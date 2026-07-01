# 이슈 #22 — Jira 비활성 시 캡처 결과가 버려지는 문제 (설계)

> 상태: 3인 교차 리뷰 수렴(브라우저 런타임 / SDK·DX / QA·UX, 전원 GO-WITH-CHANGES). 테스트 작성 후 `/goal` 대기.
> 범위: `<Bugzar>` 컴포넌트의 **jiraOff 전달 경로**. jiraOn(드로어) 플로우는 불변.

## 1. 문제

`jiraOn === false`(= `clientId`/`enabled` 없음 또는 `endpoint` 없음)이면 녹화·디자인 QA 완료 후 캡처 결과가 버려진다:

1. **onExport가 URL을 반환해도 표시 UI 없음** — `index.tsx:240,295`의 `.then((url) => { if (jiraOn) setDrawer(...) })`에서 url은 `if (jiraOn)` 안에서만 쓰여 jiraOff면 **버려짐**.
2. **onExport가 없으면 캡처 자체 폐기** — `index.tsx:236,278`의 `if (!onExport && !jiraOn) return`로 즉시 return, 다운로드 폴백 없음.
3. **빌드한 blob을 보관 안 함** — `exportBlob`(`:221-227`)이 `onExport(await produce())`로 blob을 흘려보내 reject 시 다운로드 폴백 불가.

→ 제품 핵심 가치("녹화 → 링크 → 공유")가 사실상 Jira 켜진 경우만 성립.

## 2. 계약 (resolved 값 기준 4-way) — **핵심**

> 리뷰 합의: `onExport` *존재* 여부가 아니라 **resolved 값**으로 분기. (`onExport={downloadReplay}`는 `void` 반환 → "존재하면 칩"이면 url 없는 죽은 칩이 됨.)

빌드한 blob을 손에 쥔 상태에서:

| 조건 | 동작 |
|---|---|
| **jiraOn** (creds+endpoint) | 기존대로 드로어 오픈(url 있으면 링크). reject=onError+리셋(불변) |
| jiraOff + onExport가 **non-empty string** 반환 | **링크 칩**(Open + Copy + ✕) |
| jiraOff + onExport가 **void/빈문자열** 반환 | **무표시** — 호스트가 자체 처리(예: downloadReplay). 유일한 정상 silent 종료 |
| jiraOff + onExport **reject** | **다운로드 폴백** + `onError`(+없으면 `console.error`) + **Downloaded 칩** |
| jiraOff + **onExport 없음** | **다운로드 폴백** + **Downloaded 칩** |
| (모든 경우) **produce()/빌드 throw** | `onError`(+없으면 `console.error`), blob 없어 폴백 불가 — 무표시 금지(에러는 신호) |

## 3. 구현

### 3.1 통합 `deliver` 헬퍼 (stop·onComplete 중복 제거 + 폐기 return 제거)

blob을 **한 번 빌드해 보관**하고 sink를 보장한다. 페이로드 준비(bundle/annotations, designMeta, `onAnnotate`)는 호출부에 남겨 추상화를 새지 않게 한다(DX 권고).

```ts
type ResultState =
  | { kind: 'link'; mode: 'bug' | 'design'; url: string }
  | { kind: 'downloaded'; mode: 'bug' | 'design' };

const [result, setResult] = useState<ResultState | null>(null);

const reportErr = useCallback((err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  if (onError) onError(e); else console.error('[bugzar]', e); // 무신호 금지
}, [onError]);

const deliver = useCallback(
  async (produce: () => Promise<Blob>, meta: ExportMeta, toDrawer: (url?: string) => void) => {
    setUploading(true);
    let blob: Blob;
    try { blob = await produce(); }
    catch (err) { reportErr(err); setUploading(false); return; } // build-throw → 폴백 불가
    const jiraOn = !!((jira?.clientId || jira?.enabled) && endpoint);
    const chipMode = meta.mode === 'design' ? 'design' : 'bug';
    try {
      const url = onExport ? await onExport(blob, meta) : undefined;
      if (jiraOn) toDrawer(typeof url === 'string' && url ? url : undefined);
      else if (typeof url === 'string' && url) setResult({ kind: 'link', mode: chipMode, url });
      else if (!onExport) { downloadReplay(blob, meta); setResult({ kind: 'downloaded', mode: chipMode }); }
      // else: onExport가 void/빈 → 호스트 자체 처리 → 무표시
    } catch (err) {
      reportErr(err);
      if (!jiraOn) { downloadReplay(blob, meta); setResult({ kind: 'downloaded', mode: chipMode }); }
      // jiraOn reject: 기존 동작(onError+리셋, 드로어 안 엶) 보존
    } finally { setUploading(false); }
  },
  [onExport, endpoint, jira, reportErr],
);
```

`stop`:
```ts
const bundle = stopRecorder();
if (!bundle) return;
deliver(() => buildReplayBlob(bundle), { ...bundle.meta, mode: 'session' },
        (url) => setDrawer({ mode: 'bug', bundle, ...(url ? { url } : {}) }));
```
`onComplete`(디자인): `onAnnotate?.(annotations)` 먼저 호출 후
```ts
deliver(() => buildDesignBlob(annotations, snapshot, system), designMeta,
        (url) => setDrawer({ mode: 'design', annotations, ...(url ? { url } : {}) }));
```

### 3.2 자산 인라인 — `wantsHtml = !endpoint`

다운로드 폴백은 self-contained HTML이어야 하므로 인라인 필요. `!endpoint && !!onExport` → **`!endpoint`**(주석 재작성). jira(endpoint set) 경로는 false 유지(worker 뷰어가 replay 담당 — 불변).

**[한계]** `endpoint`는 있으나 jira creds 없는 jiraOff 구성(`<Bugzar endpoint=… />`, 문서상 misconfiguration)에서 다운로드 폴백 시 HTML이 인라인 안 됨. endpoint는 "Jira 백엔드 전용"이라 이 조합은 비정상 — 한계로 명시(별도 과제).

**[비용 — 브라우저 리뷰]** zero-config `<Bugzar/>`도 이제 record 시작 + 30s 체크포인트마다, 디자인 픽마다 자산 인라인. 이미지 많은 페이지서 메모리·메인스레드 잰크↑. 이슈 의도대로지만 공짜 아님 — 성능 리포트 모니터.

### 3.3 결과 칩 UI

`Toolbar.tsx`의 idle FAB 행을 **대체**(녹화/uploading/idle과 같은 위계). `result` 있으면 칩만 렌더 → ✕로 닫아야 다시 Record/Design(이슈의 "toolbar 자리의 칩 · 수동 ✕" 모델, DX 합의).

**DOM 계약(테스트가 검증):**
- 컨테이너 `.bugzar-chip`, `role="status"` `aria-live="polite"`(결과 알림, 포커스 강탈 금지 — QA).
- **link kind:** 헤딩 `replayReady`/`designReady`(세션/디자인) + `UploadedLink`(재사용, `.bugzar-uploaded-link`, `viewReplay`/`viewReport` ↗) + Copy 버튼 `.bugzar-chip-copy`(라벨 `share`) + ✕ `.bugzar-chip-dismiss`(aria-label `dismiss`).
- **downloaded kind:** 헤딩 `downloaded` + ✕만(Open/Copy 없음).
- **[#21 비간섭 — DX R6]** 칩 컨트롤은 **`.bugzar-fab`/`.bugzar-pill` 클래스 금지**(있으면 #21 가드의 mousedown preventDefault가 링크/복사 클릭 방해). 중립 클래스 사용.

**Copy 동작(브라우저 리뷰):** `navigator.clipboard?.writeText(url)`를 클릭 핸들러에서 **동기**로(이미 resolved된 url) 호출, secure-context 가드(`navigator.clipboard` undefined면 no-op/onError). 성공 시 `share`→`copied`로 ~1.5s 스왑(같은 polite 리전서 알림).

### 3.4 autoHide — `inUse += !!result`

`inUse = recording || uploading || picking || !!drawer || !!result`(`index.tsx:308`). 없으면 커서가 코너 벗어나면 칩이 숨겨져 Open/Copy 못 누름(QA must-fix). 회귀 테스트 포함.

### 3.5 `download.ts` — revoke 1틱 지연

`URL.revokeObjectURL(url)` → `setTimeout(() => URL.revokeObjectURL(url), 0)`. 큰 인라인 HTML이 이 경로로 더 자주 흘러 구 Safari 대용량 다운로드 truncation 레이스 제거(브라우저 R4, zero 다운사이드).

### 3.6 i18n

- **재사용/배선:** `replayReady`·`designReady`(칩 헤딩) / `viewReplay`·`viewReport`(UploadedLink) / `share`(Copy) / `dismiss`(✕) — 전부 기존 문자열(미렌더 잔재였던 `replayReady`/`designReady`/`share`에 집을 줌).
- **신규(EN+KO):** `copied`("Copied"/"복사됨"), `downloaded`("Downloaded"/"다운로드됨").
- `open` 잔재는 이번에 미사용 유지(삭제 안 함 — pre-existing, 별도 정리).

## 4. 결정사항 (사용자)

- **Downloaded 확인 칩**(다운로드 경로): 이슈 본문엔 "즉시 다운로드"만 있고 칩 언급 없음. QA는 "어디 갔지?" 방지 위해 권장(브라우저 다운로드 셸프는 놓치기 쉬움). **포함을 기본으로 채택**하되, 원하면 드롭 가능(다운로드만, 칩 없음).
- **자동 다운로드 = 기본값**(opt-out 프롭 없음): 현 동작은 silent data-loss 버그라 의존 대상 아님 → "절대 무신호 폐기 금지"가 옳은 기본(DX). 호스트가 진짜 아무것도 원치 않으면 `onExport={async () => {}}`(void → 무표시).

## 5. 비범위 / 한계

- **onExport가 영영 settle 안 함** → "Uploading…" 영구 소프트락(`:237` setUploading, `.finally`로만 해제). 이슈도 별도 과제로 분류 — 투기적 타임아웃 추가 안 함(Karpathy), 한계로 명시.
- endpoint-without-creds jiraOff 다운로드 인라인 누락(§3.2).
- useBugzar(헤드리스) 경로는 이번 범위 밖(이슈는 `<Bugzar>` FAB 대상).

## 6. 변경 지점

- `packages/sdk/src/Bugzar/index.tsx` — `result` 상태, `reportErr`/`deliver`, `stop`·`onComplete` 재작성(폐기 return 제거), `wantsHtml=!endpoint`, `inUse += !!result`.
- `packages/sdk/src/Bugzar/Toolbar.tsx` — result 칩 분기(idle 대체) + props(`result`,`onCopy`,`onDismiss`).
- `packages/sdk/src/Bugzar/ResultChip.tsx`(신규, presentational) — 또는 Toolbar 인라인.
- `packages/sdk/src/ReviewDrawer/UploadedLink.tsx` — 재사용(변경 없음).
- `packages/sdk/src/download.ts` — revoke 지연.
- `packages/sdk/src/i18n.ts` — `copied`/`downloaded` 추가.
- `packages/sdk/src/styles.ts` — `.bugzar-chip`/`.bugzar-chip-copy`/`.bugzar-chip-dismiss`(uploaded-link 재사용).
- (문서) README jiraOff 동작 한 줄.

## 7. 탈출 조건 (Exit Conditions)

빌드/품질:
- [ ] `pnpm -F @bugzar/sdk typecheck` 그린
- [ ] `pnpm -F @bugzar/sdk test` 전체 그린(기존 회귀 0)
- [ ] `pnpm check`(biome) — 변경 파일 클린(기존 example-app 잔존 error는 #22 무관)

테스트 계약(`capture-result.test.tsx`) — 구현 전 red:
- [ ] **jiraOff + onExport→url:** 링크 칩(`.bugzar-chip`) + Open 링크 href=url + Copy 버튼; 드로어 안 열림
- [ ] **jiraOff + onExport→void:** 칩 없음 + `downloadReplay` 미호출(호스트 처리)
- [ ] **jiraOff + onExport 없음:** `downloadReplay`(mock) 1회 호출 + Downloaded 칩
- [ ] **jiraOff + onExport reject:** `downloadReplay` 호출 + `onError` 발화 + Downloaded 칩
- [ ] **build-throw(produce reject):** `onError` 발화 + `downloadReplay` 미호출 + 칩 없음
- [ ] **jiraOn + onExport→url:** 드로어 오픈(기존), 칩 없음 (회귀)
- [ ] **autoHide + result:** `inUse` 반영 → `collapsed === false`
- [ ] **Copy:** 클릭 시 `navigator.clipboard.writeText(url)` 호출 + 라벨 `copied` 스왑; secure-context 없음 가드
- [ ] **dismiss ✕:** 칩 제거 → idle Record/Design 복귀
- [ ] **#21 비간섭:** 칩 컨트롤에 `.bugzar-fab`/`.bugzar-pill` 없음(클래스 단언) → 칩 mousedown `defaultPrevented === false`
- [ ] 디자인 모드 변형(mode='design' → designReady/viewReport) 최소 1
