# Release Hardening Plan — A·B·C 한방 처리

오픈소스/npm 공개 전 차단 이슈를 **한 브랜치**에서 세 워크스트림으로 처리한다.
근거 감사: 보안 S-1·S-4·S-5·S-7·S-8·S-9 (A), S-2·S-3·S-6·S-10·S-11·S-13 (B), 인프라 I-1·I-2·I-4·I-5·I-6 + U-5·U-8·U-9 (C).

전제(코드 확인 완료):
- `recorder.ts`의 기본값은 이미 안전(`captureCookies=false`) — SDK 진입점이 뒤집고 있을 뿐.
- `applyReplaySecurityHeaders()`(worker.ts:409)가 **이미 존재**하고 `/`·`/r/:id`에 적용 중. asset GET 경로에만 빠짐.
- `serialize-state.ts`의 `JWT_RE` 값-스캔이 이미 검증됨 — network/storage/console로 재사용.
- 업로드 PUT은 전부 `upload.ts`의 `extraHeaders`를 관통 → 훅/토큰 주입점 단일.

---

## 합의가 필요한 설계 결정 2가지

**D1. 리댁션 중앙화 (권장: 채택).**
`@bugzar/shared`에 단일 sanitize 진입점을 두고 network·storage·console·state가 모두 재사용한다.
구체적으로 `sanitize-network-body.ts`의 `maskJsonValue`에 `JWT_RE` 값-스캔을 승격하고,
plain/XML 분기에 `redactFreeText`(JWT·`Bearer xxx` 정규식)를 추가, storage/console은 이 함수들을 호출.
→ S-1·S-5·S-8이 한 곳의 로직으로 닫힌다. 분산 구현 대비 테스트·유지보수 1/3.

**D2. Worker 쓰기 인증 강도 — ✅ 결정: 옵션 A (HMAC 업로드 토큰).**

| | 옵션 A — HMAC 업로드 토큰 (권장) | 옵션 B — 경량(Origin+create-only) |
|---|---|---|
| 막는 것 | 무단 생성·**타 리포트 덮어쓰기**·flooding | 무단 생성·덮어쓰기(create-only) |
| 새 env | `UPLOAD_SECRET` 1개 | 없음 |
| SDK 변경 | `upload.ts`가 토큰 echo (create 응답에서 받음, 투명) | 없음 |
| 호환성 | 토큰 미echo 구버전 SDK는 거부(0.0.x라 허용) | 무변경 |
| 범위 | worker 3곳 + upload.ts | worker 3곳 |

옵션 A는 `extraHeaders` 배관이 이미 있어 한계비용이 낮고, IDOR-write를 실제로 닫는다. 옵션 B는 무-신규-secret이지만 동일 origin 내 임의 id 생성+덮어쓰기는 `head()` 선검사(create-only)로만 막는다.
**아래 Phase B는 옵션 A 기준으로 기술**하고, 옵션 B 차이는 각 단계에 괄호로 표기.

---

## Phase 0 — 사전 정리 (차단 제거, ~10분)

- `rm probe2.mjs` (I-12). `.gitignore`에 `*.scratch.*` 또는 `/probe*.mjs` 규칙 추가.
- 회사 식별자 치환(S-16): `packages/sdk/example/src/App.tsx:144` + 테스트(`review-drawer.test.tsx`, `design-publish.test.tsx`, `m4-publish.test.ts`)의 `example.com` → `example.com`. (테스트는 양쪽 리터럴 동시 수정.)
- 검증: `pnpm -r test` green, `git status`에 probe 없음.

---

## Phase A — 캡처 프라이버시 (S-1·S-4·S-5·S-7·S-8·S-9)

TDD: 각 항목 reproducing test 먼저 → 빨강 확인 → 구현.

### A1. 리댁션 코어 확장 — `packages/shared/src/sanitize-network-body.ts`
- `maskJsonValue`: 문자열 leaf가 `JWT_RE` 매치면 `REDACTED` (키 무관). `JWT_RE`는 `serialize-state.ts`에서 export하거나 공용 상수로 추출.
- 신규 `redactFreeText(s)`: `Bearer\s+[\w.\-]+`, JWT, `<password>...</password>`/`<*secret*>...` 패턴 마스킹.
- `sanitizeNetworkBody`의 plain/XML 분기(:159, `<`로 시작하는 바디 포함)를 `redactFreeText(body)` 통과로 교체.
- 신규 `sanitizeStorageValue(key, value)`: JSON이면 `maskJsonValue`(이제 JWT 인지) → 재직렬화; 아니면 `JWT_RE`/`isSensitiveKey(key)`면 `REDACTED`; 그 외 `redactFreeText`.
- 테스트: `{"input":"Bearer eyJ..."}` 마스킹, XML `<password>` 마스킹, Supabase형 `{"access_token":"...","refresh_token":"..."}` 서브키 마스킹.

### A2. 스토리지 스냅샷 적용 — `packages/capture-core/src/storage-snapshot.ts`
- `snapshotOnce`에서 local/session 엔트리를 `sanitizeStorageValue(key, val)`로 매핑(:38,:48). cookies도 `redactFreeText` 통과.
- 테스트: localStorage에 JWT/`sb-*-auth-token` 넣고 스냅샷 → 값이 `[REDACTED]`.

### A3. 콘솔 인자 적용 — `packages/capture-core/src/console-patch.ts`
- `stringifyArg` 결과(:59 근처)를 `redactFreeText`로 한 번 감싼다.
- 테스트: `console.log("token", "eyJabc...")` → 캡처된 arg 마스킹.

### A4. 쿠키 기본값 복원 (S-4) — SDK 진입점
- `packages/sdk/src/Bugzar.tsx:192` `captureCookies = true` → `false`.
- `packages/sdk/src/use-bugzar.ts`(:50 default, :70 전달) 동일하게 `false`.
- 테스트: 기본 마운트 시 recorder가 `captureCookies:false`로 생성되는지(스파이) 확인.

### A5. consumer 리댁션 훅 (S-7) — 단일 choke point
- `public-types.ts`: `BugzarProps`에 `onBeforeUpload?: (b: ReportBundle) => ReportBundle | Promise<ReportBundle>` 추가.
- `upload.ts`: `uploadBundle(endpoint, bundle, opts?: { onBeforeUpload? })`로 선택 인자 추가, `POST /reports` 직전에 `bundle = await opts.onBeforeUpload(bundle)` 적용. (managed `endpoint` 경로가 콜백 전 업로드되던 S-7 갭을 여기서 닫음.)
- `Bugzar.tsx:245`/`use-bugzar.ts`의 `uploadBundle(endpoint, bundle)` → `(endpoint, bundle, { onBeforeUpload })`.
- 테스트: `onBeforeUpload`가 업로드 페이로드를 변형하는지 (fetch 목).

### A6. 문서 정정 (S-9·U-2·U-6) — `packages/sdk/README.md`
- ":35 cookies opt-in" → 실제 기본값(이제 `false`)과 일치하게 수정.
- props 표에 `captureCookies`, `onBeforeUpload`, `redactState` 행 추가.
- "Privacy & redaction" 섹션 신설: 무엇이 마스킹되고(키-매칭·JWT·Bearer·스토리지 값·콘솔) 무엇이 best-effort(자유 텍스트 바디)인지, consent 패턴.

**Phase A 검증:** `pnpm --filter @bugzar/shared test` + `--filter @bugzar/capture-core test` + `--filter @bugzar/sdk test` green.

---

## Phase B — Worker 보안 (S-2·S-3·S-6 + S-10·S-11·S-13)

### B1. 자산 GET 보안 헤더 — Stored XSS 무력화 (S-2) ★최우선·무인증과 독립
- 신규 `applyAssetSecurityHeaders(headers, asset?)`: 모든 R2 GET에 `X-Content-Type-Options: nosniff` + `Referrer-Policy`. 비이미지·비JSON(특히 `replay`)에는 `Content-Disposition: attachment` + content-type을 `text/plain; charset=utf-8`로 강제(활성 HTML 서빙 금지).
- 적용처: `handleGetAsset`(:346–350), `handleGetElementScreenshot`(:322–325), `handleLegacyArtifactsGet`(:1101). 공유는 이미 `/r/:id`→`/v/` 샌드박스 viewer라 활성 replay.html 서빙 불필요.
- 테스트(`worker.csp.test.ts` 확장): `replay` GET이 `nosniff`+`attachment`+`text/plain`인지; `PUT`이 보낸 `content-type:text/html`이 GET에서 활성화 안 되는지.

### B2. 쓰기 인증 — 무단 생성·덮어쓰기·flooding 차단 (S-3)
- `originAllowed`로 쓰기 게이트: `handleCreateReport`, `handlePutAsset`, `handlePutElementScreenshot`, `handleLegacyUpload`. (현재 `/publish`·`/jira/epics`에만 적용.)
- **옵션 A(권장):** `handleCreateReport`가 `uploadToken = HMAC(reportId, env.UPLOAD_SECRET)`를 응답에 포함. `handlePutAsset`/`handlePutElementScreenshot`는 `Authorization: Bearer <token>` 검증(report id 바인딩 → 타 리포트 덮어쓰기 불가). `upload.ts`는 create 응답의 토큰을 `extraHeaders`에 합류시켜 모든 PUT에 echo. `UPLOAD_SECRET` 미설정 시 dev처럼 토큰 검사 skip(원자: 점진 배포).
  **옵션 B(경량):** 토큰 대신 `handlePutAsset`을 create-only로 — `env.ARTIFACTS.head(key)` 존재 시 409. SDK 변경 없음.
- 공통 — 용량 보호 (크기 캡 + rate limit은 **한 쌍**: 캡=한 번에 얼마나, limit=얼마나 자주):
  - **① 요청당 크기 캡 (필수·코드):** `handlePutAsset`(:269)·`handlePutElementScreenshot`에서 asset별 상한. JSON(events/network/console/storage/meta/state/resources/vitals/system) **10MB**, PNG(screenshot/element) **5MB**, video **100MB**. `content-length` 헤더 초과 → **413**; 헤더 없거나 chunked면 바이트-카운팅 `TransformStream`으로 캡 초과 시 abort(R2 `.put`은 ReadableStream 수용).
  - **② 리포트당 합계:** `ASSETS` 화이트리스트(~13종, :162) × HMAC 단일 writer라 ①에서 자동 도출(≲150MB) — 별도 합산 로직 불필요.
  - **③ rate limit (권장·코드 0줄):** Cloudflare Rate Limiting Rule로 `POST /reports`·`PUT /reports/*`에 IP당 N/min. 토큰이 있어도 curl이 `POST /reports`를 반복하면 flooding 가능하므로 ①과 반드시 병행. 강화 시 토큰 발급에 Turnstile.
  - **④ 버킷 전체:** `retention.ts`(9.5GB·daily)는 사후 floor — Cloudflare Billing/Usage 알림으로 보강(운영 설정).
  - 참고: Workers 플랫폼 기본 본문 상한 ~100MB(Free)는 천장일 뿐, JSON asset엔 너무 커서 앱-레벨 캡(①)이 필요.
- `originAllowed` 미설정-시-개방(:1800 `return true`)을 **공개 배포에서 닫기**: `env.ALLOWED_ORIGINS` 미설정 + `env.PUBLIC_DEPLOY` 설정이면 deny. dev(둘 다 미설정)는 기존대로 개방. wrangler.toml·SETUP.md에 "공개 노출 전 `ALLOWED_ORIGINS` 필수" 명문화.
- 테스트: 토큰 없는 PUT 401; 다른 reportId 토큰으로 PUT 401(옵션 A); 기존 키 재PUT 409(옵션 B); 허용 origin은 통과; asset 캡 초과 PUT 413(예: 11MB `network`); chunked 캡 초과 시 abort.

### B3. 공개 인덱스 제거 — 열거 차단 (S-6)
- `GET /`(handleListReports, :1967)를 `env.PUBLIC_INDEX === '1'` 또는 `Authorization: Bearer <ADMIN_SECRET>`일 때만 렌더. 기본은 200 빈 페이지/404. (id는 ~2^50 추측불가라 리포트 자체는 capability-URL 모델 유지 — 변경 없음.)
- SETUP.md에 "리포트 URL = bearer capability, 인덱스는 opt-in" 명시.
- 테스트: 기본 배포에서 `GET /`가 리포트 목록을 노출 안 함; `PUBLIC_INDEX=1`이면 노출.

### B4. 방어심층 (S-10·S-11·S-13) — 같은 PR에 포함
- `handleOAuthExchange`(:1639)·`handleJiraDraft`(:1383)를 `originAllowed`로 게이트(S-10·S-14).
- `CORS_HEADERS`의 `*`(:123)를 origin-echo로: `ALLOWED_ORIGINS`에 있을 때만 요청 Origin 반향, 아니면 미설정. read/draft/oauth/telemetry 포함(S-11).
- `handleDeleteReport`의 `token !== env.ADMIN_SECRET`(:491)을 상수시간 비교(`crypto.subtle` digest 비교)로(S-13). 업로드 토큰 검증도 동일 헬퍼 재사용.
- 테스트: 비허용 origin의 oauth/draft 403; admin 비교 헬퍼 단위 테스트.

**Phase B 검증:** `pnpm --filter @bugzar/backend test` green + `wrangler dev` 로컬 스모크(POST/PUT/GET/r 흐름).

---

## Phase C — npm 배포 정합성 (I-1·I-2·I-4·I-5·I-6 + U-5·U-8·U-9)

### C1. 배포 차단 해제 — `packages/sdk/package.json`
- `"publishConfig": { "access": "public", "provenance": true }` (I-1·I-2).
- `repository`(type+url+`"directory": "packages/sdk"`), `homepage`, `bugs.url`, `author`, `keywords`(`["rrweb","session-replay","qa","bug-report","react"]`) 추가 (U-5).

### C2. LICENSE 동봉 (I-6)
- 루트 `LICENSE` → `packages/sdk/LICENSE` 복사(npm은 패키지 디렉터리 LICENSE만 자동 포함). 선택: Apache `NOTICE`.

### C3. tarball 슬림화 (I-5) — `packages/sdk/tsup.config.ts`
- 배포 빌드에서 `sourcemap: false` 또는 `package.json` `files`를 `["dist", "!dist/**/*.map"]`로. (2.6MB→0; 런타임 index.js만.)
- 검증: `cd packages/sdk && npm pack --dry-run` → `.map` 부재, tarball 크기 확인.

### C4. CI에 SDK 빌드 게이트 (I-4) — `.github/workflows/ci.yml`
- 스텝 추가: `pnpm --filter @bugzar/sdk typecheck && pnpm --filter @bugzar/sdk build`. 가능하면 `publint` + `@arethetypeswrong/cli`로 dist 검증.

### C5. 릴리즈 워크플로우 (I-2) — `.github/workflows/release-sdk.yml` (신규)
- `on: push: tags: ['sdk-v*']`. CI 빌드 후 `npm publish --provenance --access public` (npm OIDC Trusted Publishing 또는 보호 Environment의 scoped `NPM_TOKEN`).

### C6. README 정합 (U-8·U-9) — `packages/sdk/README.md`
- Requirements에 필수 peer `react`+`react-dom`(>=18), optional `@tanstack/react-query`(>=5) 명시(U-8).
- `ReportBundle` 인터페이스 블록에 `system: SystemInfo` 추가(U-9). placeholder 링크(:117) 실제 URL로(U-4).

**Phase C 검증:** `npm pack --dry-run`(LICENSE·README 포함, .map 제외), CI 신규 스텝 통과.

---

## Phase D — 오프라인 self-contained HTML export (Q3)

> 백엔드 없는 Tier 0 사용자가 **더블클릭하면 오프라인에서 보는** 단일 `.html`을 받게 한다. 상세 설계·실측: [docs/q3-offline-export-design.md](q3-offline-export-design.md).
> **성격:** A·B·C(보안/배포 차단)와 달리 **기능 추가** — 릴리즈 블로커 아님. A·B·C 이후 또는 병렬 진행 가능.

핵심 결정(딥다이브 검증):
- **(B) 전체 viewer를 단일 HTML로 인라인** (player-only 아님) — viewer는 이미 단일 491KB JS, 유일한 결합점은 `loadReport` fetch 하나.
- **압축 = 번들 전체 gzip** — `@rrweb/packer` per-event는 ~10배 부풀어 **금지**. events는 raw로 Player에 전달(unpackFn 불필요).
- **전달 = 별도 `@bugzar/sdk/export` subpath** — lazy `import('./export')`(상대경로)는 `splitting:false` 탓에 0 delta 안 됨, **bare specifier 필수**.

### D1. viewer 인라인 마운트 — `packages/viewer/src/main-inline.tsx` (신규 ~20-30줄)
- `window.__BUGZAR_REPORT__`를 읽어 parseReportParams/loadReport/failed-slot 건너뛰고 `checkSchemaVersion` 후 동일 `<App>` 본문 렌더. `load-report.ts`는 변경 없이 우회.
- 검증: `__BUGZAR_REPORT__` 주입 시 `loadReport` 미호출 assert.

### D2. viewer 단일 IIFE 빌드 타깃
- `vite-plugin-singlefile` / `build.lib format:'iife'`+`inlineDynamicImports` — file://에서 외부 ES-module 차단이라 단일 classic 청크 필수.
- 검증: dist 산출물에 `type="module"` 없음.

### D3. gen 스크립트 — `scripts/gen-viewer-asset.mjs`
- `gen-rrweb-player.mjs` 미러링: 빌드된 `index-*.js` → `packages/sdk/src/viewer-asset.generated.ts`의 `VIEWER_JS`. (CSS는 viewer가 JS에서 주입.)
- 검증: `VIEWER_JS` export, 길이 >400KB.

### D4. SDK export 엔트리 — `packages/sdk/src/export.ts`
- `exportReportHtml(bundle): Promise<Blob>` — compact JSON → `CompressionStream('gzip')`(미지원 시 identity 폴백 + envelope `encoding` 플래그) → 청크 base64 → HTML 조립(meta-CSP + `<script application/json>` + `VIEWER_JS` + 부트스트랩) → `Blob`.
- meta-CSP는 Worker `REPLAY_CSP`(worker.ts:382) 미러링(meta-비호환 directive 제외). **`UNSAFE_replayCanvas` 끄기**(XSS 봉쇄).
- 검증: Node round-trip(gzip→b64→atob→gunzip→parse 무손실, Unicode 보존).

### D5. tsup/package.json 배선 (메인 번들 0 delta)
- `tsup.config.ts` entry에 `'src/export.ts'` 추가(`splitting:false` 유지), `noExternal:['fflate']`. `package.json` exports에 `./tanstack` 동형 `"./export"`.
- **index.ts는 export 모듈 import 금지.** SDK `prebuild`: `pnpm --filter @bugzar/viewer build && node ../../scripts/gen-viewer-asset.mjs`(빌드 순서 — viewer 먼저).
- 검증: 빌드 후 `dist/index.js` 0 delta(±수십 바이트).

### D6. Bugzar 배선 — public API
- `download?: boolean | 'json' | 'html' | 'both'` (`true === 'json'`로 기존 동작 byte-for-byte 보존). `'html'`/`'both'`면 backend-less stop 경로(Bugzar.tsx:330)에서 `await import('@bugzar/sdk/export')`로 `qa-replay-<ts>.html` 다운로드.
- 검증: 기존 terminal-states 테스트 유지 + `download:'html'` 신규.

### D7. ★ 차단 게이트 — 실제 브라우저 file:// 테스트
- 생성 HTML을 Chrome/Firefox/Safari에서 더블클릭 → 리플레이 렌더 + DesignView `contentDocument` 읽기 동작 확인. **통과 전 커밋 금지** (rrweb srcdoc iframe의 file:// opaque-origin 가정은 정적 검증 불가).
- 미해결: SDK rrweb config의 `inlineImages`/`inlineStylesheet`(오프라인 원격 에셋 깨짐 대비)를 backend-less 경로에서 켤지 결정.

**Phase D 검증:** viewer+sdk 테스트 green + Node round-trip + `dist/index.js` 0 delta + **실브라우저 file:// 더블클릭(D7)**.

---

## 통합 순서 & 충돌 관리

```
Phase 0 (정리)
  ├─> Phase A ─┐  A5(upload.ts onBeforeUpload) ┐
  ├─> Phase B ─┤  B2(upload.ts 토큰 echo)       ┘ ← upload.ts 동시 편집 → A 먼저, B2가 이어서
  ├─> Phase C    (독립 — 병렬 가능)
  └─> Phase D    (독립 — viewer + sdk/export.ts; 기능 추가라 별도 PR 가능)
```

- **유일한 파일 충돌:** `upload.ts`를 A5(훅)와 B2-옵션A(토큰)가 둘 다 건드림 → A5 먼저 머지 후 B2.
- **D6 ↔ A:** 둘 다 `Bugzar.tsx`를 건드리지만 영역이 다름(A=캡처 config/upload 호출 :192·:245, D6=download 분기 :330) → 충돌 낮음, 나중 머지 쪽만 rebase.
- 그 외 A/B/C/D는 서로 독립.

## 커밋/PR 분할 (권장)
한 브랜치 `harden/oss-release`, 4 atomic 커밋(D는 기능이라 별도 PR도 무방):
1. `feat(sdk): centralize redaction, default cookies off, onBeforeUpload hook` (Phase 0+A)
2. `feat(backend): asset security headers, write auth, gate public index` (Phase B)
3. `chore(sdk): npm publish config, license, slim tarball, release CI` (Phase C)
4. `feat(sdk): offline self-contained HTML export (@bugzar/sdk/export)` (Phase D)

## 최종 수용 기준 (Definition of Done)
- [ ] `pnpm -r test` 전부 green (신규 reproducing 테스트 포함).
- [ ] `wrangler dev`: 무단 PUT 401(옵션A)/409(옵션B), 캡 초과 PUT 413, `replay` GET이 비활성, `GET /`가 인덱스 미노출.
- [ ] `npm pack --dry-run`: LICENSE+README 포함, `*.map` 제외, `@bugzar/`·`workspace:` 토큰 0(I-11 회귀 가드).
- [ ] README가 실제 캡처/리댁션 동작과 일치.
- [ ] `git grep -i 'example\|probe2'` → 0.
- [ ] (Phase D) `@bugzar/sdk/export` 추가 후에도 `dist/index.js` 0 delta (메인 번들 회귀 가드).
- [ ] (Phase D) 생성된 `.html`을 실제 브라우저에서 더블클릭 → 오프라인 리플레이 렌더 (D7 게이트).
