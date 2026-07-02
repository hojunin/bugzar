# SDK 보안 감사 — HIGH 6종 수정 구현계획

> 출처: deep-research → 3인 전문가 패널 → adversarial 검증 게이트 감사(13 confirmed) 중 **HIGH 6종**. 각 계획은 실제 코드(file:line) 대조 + 외부 best-practice 리서치 기반. 라인 번호는 구현 시 재확인 필요.
> 범위: client-side `@bugzar/sdk`(+번들 `capture-core`·`shared`·`viewer`). backend는 분리된 private 레포라 범위 밖.

## 응집 로드맵 (foundation-first, 4 PR)

6개 중 **4개(#3·#4·#5·#6)가 `packages/shared/src/sanitize-network-body.ts` 한 파일**의 blocklist/masker를 공유한다. 공통 기반을 먼저 만들고 의존 fix를 얹는다. 전부 effort **S**(#3만 S~M).

| PR | 내용 | 의존 |
|---|---|---|
| **PR-1 공통 기반** (BLOCKING) | **A**: `sanitize-network-body.ts` 한 커밋 — #3 PII 패턴 확장 + `maskJsonValue` export(#4) + `isSensitiveHeader`(#6) + `sanitizeUrl`(#5). **B**: `isSafeUrl`을 `@bugzar/shared`로 이동 + `sdk/src/safe-url.ts`는 re-export shim(#1). | — |
| **PR-2 캡처 sink** (#6+#5) | `network-patch.ts`를 두 fix가 같이 건드리므로 한 PR. | PR-1 A |
| **PR-3 console** (#4) | `console-patch.ts` 단독. | PR-1 A |
| **PR-4 Figma XSS** (#1) | `DesignView.tsx` + `picker.ts`. | PR-1 B |
| **독립** (#2) | `atlassian.ts`만. 언제든. | — |

**충돌 주의**: `sanitize-network-body.ts`(4 findings)·`network-patch.ts`(#5·#6)는 각각 한 PR로 묶는다. `atlassian.ts`(#2)·`DesignView`(#1)는 겹침 없음.

---

## #1 — Stored XSS: `figmaUrl`이 스킴 검증 없이 href로 렌더 〔HIGH · S〕

**Root cause**: `viewer/src/design/DesignView.tsx`가 `href={el.figmaUrl}`를 truthiness(`el.figmaUrl ?`)만으로 가드 — 스킴 allowlist 없음. `figmaUrl`은 picker의 free-text `<input type=url>`(폼 submit 없이 버튼 클릭으로 읽혀 브라우저 url 검증 미적용)에서 와서 export HTML에 verbatim으로 baked. SDK 내 유일하게 `isSafeUrl()` 미적용 href. `javascript:`/`data:` URI 클릭 시 replay origin에서 실행 → 캡처 세션 전체 유출.

**접근**: 기존 `isSafeUrl`(deny-by-default http/https) 재사용. viewer는 별도 패키지라 `@bugzar/shared`로 헬퍼 이동해 공유.
- (거부) viewer에 isSafeUrl 복제 → drift; DOMPurify → 과함; export CSP 강화 → `<meta>` CSP는 `javascript:` **href 내비게이션을 못 막음** → CSP는 방어선 아님(non-fix로 문서화).

**변경**
1. `packages/shared/src/safe-url.ts` (신규) — `sdk/src/safe-url.ts`에서 `isSafeUrl` verbatim 이동 (location-guarded base 포함).
2. `packages/shared/src/index.ts` — `export * from './safe-url';` 추가.
3. `packages/sdk/src/safe-url.ts` — `export { isSafeUrl } from '@bugzar/shared';` re-export shim (기존 3개 sink·테스트 무변경).
4. `packages/viewer/src/design/DesignView.tsx` — `import { isSafeUrl } from '@bugzar/shared'`; 가드 `{el.figmaUrl ?` → `{isSafeUrl(el.figmaUrl) ?` (unsafe면 링크 omit).
5. `packages/sdk/src/picker/picker.ts` `commitPending` — 저장 조건 `if (figmaUrl)` → `if (isSafeUrl(figmaUrl))` (unsafe 값 미저장).

**테스트**: viewer `DesignView.test.tsx`(https→링크 렌더 / `javascript:`→링크 없음), shared `safe-url.test.ts`(스킴 매트릭스 이관), picker 저장 가드.
**Edge**: 상대경로 URL은 pass(기존 동작 유지); 이미 export된 poisoned HTML도 sink 가드가 렌더 시 무력화(→ sink 가드가 authoritative).
**검증**: `pnpm --filter @bugzar/shared test` + `--filter @bugzar/viewer test`. **리스크 낮음**(더 엄격한 가드일 뿐).

---

## #2 — Atlassian refresh token 평문 localStorage 저장 〔HIGH · S〕

**Root cause**: `sdk/src/oauth/atlassian.ts` `saveSession()`(~L119-121)가 세션 전체(장기 `refreshToken`, offline_access 스코프)를 `bugzar:atlassian` 키에 평문 JSON 저장. same-origin 스크립트/XSS가 refresh token 탈취 → Jira 토큰 무한 발급(탭 종료 후에도).

**접근** (fail-safe, 클라 최소수정): **refresh token을 localStorage에 절대 저장 안 함.** 탭 수명 동안 module-scoped in-memory 변수로만 보관, localStorage엔 `refreshToken: null`로 redact한 세션 저장. (full BFF/HttpOnly cookie는 backend 필요 → 범위 밖이라 보류.)

**변경** (`atlassian.ts` 4곳)
1. module-scope `let inMemoryRefreshToken` 홀더 추가.
2. `saveSession` — refresh token은 메모리에, localStorage엔 `{...session, tokens:{...,refreshToken:null}}` 저장.
3. `loadSession` — 저장본 복원 후 같은 탭이면 in-memory refresh token 재부착.
4. `clearSession` — in-memory도 null로(disconnect 시 완전 revoke).

**테스트**: `sdk/src/__tests__/atlassian.test.ts` — save 후 localStorage에 refreshToken 없음, 같은 탭 load는 정상 동작, clear가 메모리도 비움.
**검증**: `pnpm --filter @bugzar/sdk test`. 공개 시그니처 불변, `use-atlassian-auth.ts` 무변경. **리스크 낮음.**

---

## #3 — PII 미차단 (공통 기반) 〔HIGH · S~M〕

**Root cause**: `shared/src/sanitize-network-body.ts` `SENSITIVE_KEY_PATTERNS`(L37-56)는 credential 18종뿐, **PII 0종**. `maskJsonValue`는 `profile.email`을 verbatim 반환. redaction이 *secret-ness*만 보고 *identifiability*를 안 봄. `bugzar:atlassian`(사용자 이메일 보유)도 storage 스냅샷에 그대로.

**접근**: 기존 2계층(key blocklist + 정밀 value scrubber)에 **PII 카테고리 추가** — #4/#5/#6/#9가 이 헬퍼들을 이미 호출하므로 공짜로 PII 커버(공통 기반). 신규 `redactPiiText(s)`(email·E.164 phone·Luhn 검증 card)를 `maskJsonValue` string leaf + `redactFreeText`에 배선.
- (거부) value-regex만 → 이름 못 잡음; NER/ML → 동기 import 브라우저 SDK엔 과함.

**변경** (≤6)
1. `SENSITIVE_KEY_PATTERNS` — PII substring 추가 **좁게**: `email/e-mail/phone/mobile/telephone`, `firstname/last_name/fullname/surname`(bare `name` 금지), `ssn/passport/tax_id/credit_card/card_number/cvv/iban`, `street_address/postal_code/zip_code`(bare `address` 금지 — `ip_address` 충돌).
2. `looksLikeJwt` 근처 — `EMAIL_RE`·`PHONE_RE`·Luhn 헬퍼 + `redactPiiText`. **모든 leading boundary는 capture group**(lookbehind는 Safari<16.4 import-time SyntaxError).
3. `redactFreeText` — 토큰 pass 뒤 `redactPiiText` 추가(plain/XML/console 커버).
4. `maskJsonValue` string branch — `looksLikeJwt(v) ? REDACTED : redactPiiText(v)`.
5. `storage-snapshot.ts`(L38-42,49-53) — `bugzar:` prefix 키는 스냅샷에서 제외(deny-list, local+session 양쪽).
6. `_internal`에 `redactPiiText`(+Luhn) export(테스트용).

**False-positive 전략**: key는 compound만(`filename`/`ip_address`/`telemetry` 회피); value regex는 string leaf에만; card는 **Luhn + 길이 13-19**; phone은 `+`(E.164) 또는 구분자 그룹만(가격·epoch 회피); `[REDACTED]`는 재매치 안 됨(idempotent).
**테스트**: `isSensitiveKey('firstName')`=true / `'filename'`·`'name'`·`'ip_address'`=false; email·phone·Luhn(valid Visa→redact, Luhn 실패→유지); `bugzar:atlassian` 스냅샷 제외.
**검증**: `pnpm --filter @bugzar/shared test`·`--filter @bugzar/capture-core test`; `grep -nE '\(\?<' sanitize-network-body.ts`→0(Safari 가드). **리스크**: over-redaction(safe-by-default, FP 테스트셋으로 경계).

---

## #4 — console 객체 인자가 key-based redaction 우회 〔HIGH · S〕

**Root cause**: `capture-core/src/console-patch.ts` `stringifyArg`(L28-38)가 객체 인자를 `JSON.stringify` 후 `redactFreeText`(Bearer/JWT/XML만)에만 통과 — `maskJsonValue` key masking 미적용. network 경로(`maskJsonValue` 사용)와 불일치. `console.log({password:'x'})` 평문 저장.

**접근**: 비-string·비-Error 인자를 **stringify 전에 `maskJsonValue`(PR-1에서 export)로 통과**시킨 뒤 `redactFreeText`도 유지(defense-in-depth). network 경로와 구조적으로 일치.

**변경**
1. `sanitize-network-body.ts` L132 — `const maskJsonValue` → `export const maskJsonValue`(PR-1 A에 포함).
2. `console-patch.ts stringifyArg` — 객체 인자: `JSON.stringify(maskJsonValue(arg))` 후 `redactFreeText`. 순환참조·비직렬화·Error·depth 처리 유지.

**테스트**: `console-patch.test.ts` — `console.log({password,apiKey})` → 값 `[REDACTED]`; 문자열 인자 기존 동작 유지.
**검증**: `pnpm --filter @bugzar/capture-core test`. `maskJsonValue`는 non-mutating(원본 미변경)이라 **리스크 낮음.**

---

## #5 — URL 쿼리스트링 시크릿 무검열 캡처 〔HIGH · S〕

**Root cause**: `network-patch.ts`의 `req.url`(L145)·XHR `ctx.url`(L234/309)·`recorder.ts` `location.href`(L64)를 verbatim 저장 — body만 sanitize. `?api_key=`·OAuth `?code=`·signed URL·magic-link 토큰이 `bundle.network[].url`·`meta.url`에 → public-by-URL 유출.

**접근**: `sanitizeUrl(url)` 신규(`sanitize-network-body.ts`, 기존 `isSensitiveKey` 재사용) — 쿼리/프래그먼트 param **name이 sensitive면 value redact**, scheme/host/path는 보존(디버깅용). 4개 캡처 사이트에 적용.

**변경**
1. `sanitize-network-body.ts` — `sanitizeUrl` + URL 전용 짧은 param 세트(`isSensitiveParamName`) 추가(PR-1 A).
2. `network-patch.ts:145` — `const url = req.url` → `sanitizeUrl(req.url)`.
3. `network-patch.ts:234`(+309) — XHR url 저장 시점에 `sanitizeUrl(...)` 래핑.
4. `recorder.ts:64` — `location.href`를 `sanitizeUrl(...)`로.

**테스트**: `sanitize-network-body.test.ts`(`?token=x`→redact, `?q=1`→유지, 상대/malformed URL); `network-patch.test.ts`(캡처 url 검열).
**Edge**: 상대·쿼리 없는·malformed URL, 반복 param; URL 정규화 주의.
**검증**: `pnpm --filter @bugzar/shared test`·`--filter @bugzar/capture-core test`. **리스크 낮음**(순수·additive).

---

## #6 — 헤더 redaction 5-entry exact-match blocklist 〔HIGH · S〕

**Root cause**: `network-patch.ts` `REDACT_HEADER`(L24-30)=`{authorization,cookie,set-cookie,x-api-key,x-auth-token}` 5개를 exact-match(L37/250/303). `x-access-token`·`x-csrf-token`·`x-session-id`·`authentication`·`proxy-authorization`·`x-amz-security-token` 등 커스텀 auth 헤더 전부 누출.

**접근**: exact-match를 **substring 매처 `isSensitiveHeader`**(기존 `isSensitiveKey` + 헤더 전용 substring `['auth','session','csrf','xsrf','bearer']` 합성)로 교체 — body/storage와 수렴.

**변경**
1. `sanitize-network-body.ts` — `isSensitiveHeader(name)` export 추가(PR-1 A) + `_internal` 등록.
2. `network-patch.ts:24-30` — `REDACT_HEADER` Set 삭제(`REDACTED` 상수는 유지).
3. `network-patch.ts:37/250/303` — `REDACT_HEADER.has(k.toLowerCase())` → `isSensitiveHeader(k)` (3곳).
4. L264-266 주석의 `REDACT_HEADER` 언급 갱신. **content-type은 sensitive 아님 → 후속 로직에서 계속 읽힘(마스킹 금지).**

**테스트**: `sanitize-network-body.test.ts`(`isSensitiveHeader('x-csrf-token')`=true, `'content-type'`=false); `network-patch.test.ts`(커스텀 auth 헤더 redact, content-type 보존).
**검증**: `pnpm -r build`(shared 재export) + capture-core test. **리스크 낮음**(캡처 사본만 변경, 실제 요청 무영향).

---

## 참고
- 이전 감사 이슈(#28 URL쿼리=#5, #29 헤더=#6, #37 PII key=#3)가 레포 재생성으로 삭제됐으나 취약점은 유효 — 이 계획들이 대체·확장.
- 앞서 부분 수정: #46(mask 기본값)은 `recorder.ts` orchestrator 레이어를 놓쳐 별도 MEDIUM(#8)으로 잔존; #52(isSafeUrl)는 viewer `DesignView`를 놓쳐 이번 #1이 마무리.
