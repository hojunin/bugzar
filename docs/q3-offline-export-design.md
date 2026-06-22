# Q3 설계 — 백엔드 없는 자가완결형 오프라인 리플레이 export

> 대상: `@bugzar/sdk`를 백엔드 없이 쓰는 사용자가 **더블클릭하면 오프라인에서 바로 보는** 리플레이 아티팩트를 받게 한다.
> 근거: 실측 + 실제 Chrome headless `file://` 검증 (deep-dive workflow). load-bearing 주장 4개 중 1개 confirmed-with-precision, 2개 confirmed, **1개 refuted**.

## 1. 문제 재정의

백엔드(`endpoint`) 없이 멈추면 `downloadBundle`([Bugzar.tsx:136](packages/sdk/src/Bugzar.tsx:136))이 전체 번들을 `JSON.stringify(bundle, null, 2)`로 내려준다 → **완전하지만 볼 수 없는 데이터**. 유일한 HTML 리플레이 `buildReplayHtml`([replay-html.ts:7](packages/sdk/src/replay-html.ts:7))은 Worker에서 player를 로드하고 events를 fetch하므로 **백엔드 없이는 작동 안 함**. 게다가 pretty-print가 데이터를 부풀린다(측정: 20MB-raw 세션 → pretty **47.5MB** vs compact 20.8MB).

## 2. 선택지 비교 — 권장 (B) 전체 viewer 단일 HTML

| 기준 | (A) player-only HTML | **(B) 전체 viewer 단일 HTML (권장)** | (C) JSON+압축만 |
|---|---|---|---|
| 얻는 것 | 리플레이만 | **리플레이 + 6패널 + Design (현 viewer와 동일)** | 못 봄 |
| 크기(20MB 세션) | ~1.5MB | **~1.94MB** | ~1.1MB(못 봄) |
| 난이도 | 중-상(패널 재구현) | **중**(viewer diff ~20-30줄 + gen + entry) | 하 |
| 오프라인 | 가능 | **가능(file:// 검증됨)** | N/A |
| SDK 번들 영향 | subpath면 0 | **subpath면 0 delta(검증됨)** | 0 |

**(B) 추천 이유:** 전체 viewer는 이미 99% 자가완결(단일 491KB JS). 유일한 네트워크 결합이 `loadReport`의 fetch 한 곳([load-report.ts:49](packages/viewer/src/report/load-report.ts:49), verifier confirmed)이라, 그 한 점만 우회하면 Console/Network/Resources/State/Storage/SystemInfo/Design 패널 전부가 inline props만으로 오프라인 동작한다. (A)는 패널 6종을 재구현해야 하고, (C)는 "못 본다"는 문제를 그대로 둔다.

## 3. 권장 아키텍처 (B) end-to-end

### 3.1 빌드 파이프라인
`scripts/gen-rrweb-player.mjs`의 검증된 인라인 패턴을 미러링:
1. **viewer를 단일 classic IIFE로 빌드.** 현 dist는 `<script type="module" crossorigin>`([viewer/dist/index.html:7](packages/viewer/dist/index.html))인데 **file://에서 외부 module은 CORS 차단**(검증됨). → `vite-plugin-singlefile` 또는 `build.lib format:'iife'` + `inlineDynamicImports`. **이게 단순 래핑이 아닌 실제 빌드 작업.**
2. **`scripts/gen-viewer-asset.mjs`** 추가: 빌드된 `index-*.js` → `packages/sdk/src/viewer-asset.generated.ts`의 `export const VIEWER_JS`. CSS는 viewer가 `injectStyles`로 JS에서 주입하므로 JS만 인라인.
3. **빌드 순서:** viewer가 SDK보다 먼저. backend의 `build:viewer`/`gen:player` 선례를 미러링해 SDK `prebuild`에 `pnpm --filter @bugzar/viewer build && node ../../scripts/gen-viewer-asset.mjs`.

### 3.2 데이터 인라인 (fetch 대신 전역 읽기)
새 `packages/viewer/src/main-inline.tsx`(현 16줄짜리 `main.tsx` 미러): `window.__BUGZAR_REPORT__`를 읽어 `parseReportParams`/`loadReport`/failed-slot을 전부 건너뛰고, `checkSchemaVersion` 후 동일한 `<App>` 본문(`reportMode` → `DesignView`|`SessionView`)을 렌더. **`load-report.ts`는 변경 없이 우회됨.** `ReportBundle`([public-types.ts:171](packages/sdk/src/public-types.ts:171))은 viewer `ReportData`([types.ts:71](packages/viewer/src/report/types.ts))에 1:1 매핑(+`design:[]` 슬롯만 추가).

### 3.3 압축 — ⚠️ 전체 gzip (packer 쓰지 말 것)
**반증된 가설:** events에 `@rrweb/packer` per-event pack은 오히려 부풀린다.
- per-event pack은 이벤트마다 zlib 헤더 + base64 33% → 20MB 세션에서 **per-event 11.63MB vs 전체 gzip 1.10MB (~10배 큼)**, 2766ms vs 77ms.
- `unpackFn`은 연결 가능하지만([use-replayer.ts:68](packages/viewer/src/player/use-replayer.ts)) **쓰면 안 됨**.

**정답:** compact 번들 한 번 → `CompressionStream('gzip')` → 청크 base64 → `<script type="application/json" id="bugzar-data">`에 임베드. events는 raw로 Player에 전달 → **`unpackFn` 변경 불필요(viewer diff 더 줄어듦)**.

### 3.4 file:// 안전 구성 (실제 Chrome headless 검증)
- **금지:** 모든 `fetch()`, 외부 ES-module import, 멀티-MB `data:` URL 네비게이트. → 전부 인라인 + **classic inline script**.
- **동작 확인:** inline script, `blob:` URL, `CompressionStream`/`DecompressionStream`, base64 round-trip 모두 file://에서 OK(검증됨).
- **meta-CSP는 file://에서 honor됨**(검증). Worker `REPLAY_CSP`([worker.ts:382](packages/backend/src/worker.ts:382))를 미러링하되 `<meta>` 비호환 directive(`frame-ancestors`/report-only)만 제외. 권장: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; frame-src 'self' about: blob: data:; child-src 'self' about: blob: data:; connect-src blob: data:; base-uri 'none'; form-action 'none'`.
- **XSS 봉쇄:** rrweb Replayer는 리플레이 iframe을 `sandbox=['allow-same-origin']`로만 빌드(`UNSAFE_replayCanvas`일 때만 `allow-scripts`) → 캡처 페이지 스크립트 미실행. **export에서 `UNSAFE_replayCanvas` 켜지 말 것.**
- **다운로드:** 거대 문자열 concat 금지 → `new Blob([shell, data, viewerJs])` + `URL.createObjectURL`.

### 3.5 SDK 전달 — ⚠️ 별도 subpath만 0 delta (lazy import는 반증됨)
**반증:** `await import('./export')`(상대경로)는 0 delta를 **못** 보장. SDK tsup은 cjs+esm 동시 빌드라 `splitting:false`가 강제되고, 그러면 esbuild가 dynamic-import 타깃을 엔트리에 **인라인**(probe: index.js 133B→233,824B).

**유일하게 유효한 방법(검증: index.js 68B, 0 blob):**
1. `tsup.config.ts` entry에 `'src/export.ts'` 추가(`splitting:false` 유지), `noExternal`에 `fflate` 추가.
2. `package.json` exports에 `./tanstack`와 동형의 `"./export"` 블록.
3. **index.ts는 export 모듈을 절대 import 금지.** lazy load는 상대경로가 아니라 **bare specifier `await import('@bugzar/sdk/export')`** — 그래야 별도 청크. `sideEffects:false`가 tree-shaking 보장.

## 4. 대용량 데이터 (20MB-raw 세션 실측)

| 단계 | 크기 |
|---|---|
| 현재 pretty-print | **47.51 MB** |
| compact JSON | 20.80 MB |
| gzip L6 | 1.10 MB (압축 77ms / 해제 72ms) |
| gzip→base64 | 1.47 MB |
| **최종 .html** (viewer 480KB + data 1.47MB + shell 6KB) | **~1.94 MB** |

→ **오늘 대비 24.4배 작고, 게다가 오프라인에서 볼 수 있다.** (L1 1.59MB / L6 1.10MB / L9 1.05MB → L6 기본)
**폴백:** `CompressionStream` 미지원 브라우저(구형)면 feature-detect로 `identity`(compact 미압축) 임베드 + envelope `encoding` 플래그. `@rrweb/packer`가 이미 번들하는 fflate를 폴백 디코더로 재사용 가능.

## 5. Public API (최소·하위호환)
1. **프로그래매틱(주):** `import { exportReportHtml } from '@bugzar/sdk/export'; const blob = await exportReportHtml(bundle);` — 순수 함수, Blob 반환, import 시에만 무거운 에셋 로드.
2. **컴포넌트 opt-in:** 기존 boolean `download`을 `download?: boolean | 'json' | 'html' | 'both'`로 확대. `true === 'json'`으로 **현재 기본동작 byte-for-byte 보존**. `'html'`/`'both'`면 `await import('@bugzar/sdk/export')`.

## 6. 구현 체크리스트 (파일별 + 검증)
1. `packages/viewer/src/main-inline.tsx` 신규(~20-30줄) → 검증: `__BUGZAR_REPORT__` 주입 시 `loadReport` 미호출 assert.
2. viewer 단일 IIFE 빌드 타깃 → 검증: dist가 `type="module"` 없는 단일 JS.
3. `scripts/gen-viewer-asset.mjs` → 검증: `VIEWER_JS` export, 길이 >400KB.
4. `packages/sdk/src/export.ts` (`exportReportHtml`) → 검증: Node round-trip(gzip→b64→atob→gunzip→parse 무손실, Unicode 보존).
5. `tsup.config.ts`/`package.json` 배선 → 검증: `dist/index.js` 크기 0 delta(±수십 바이트).
6. SDK `prebuild` 순서 → 검증: clean 빌드 통과.
7. Bugzar 배선([:136](packages/sdk/src/Bugzar.tsx:136)) `download` 확대 + lazy import → 검증: 기존 terminal-states 테스트 유지 + `download:'html'` 신규.
8. **★ 차단 게이트 — 실제 브라우저 file:// 더블클릭 테스트** (아래 리스크 #1). 정적 probe로 검증 못 한 유일한 가정.

## 7. 리스크 & 미해결 질문
**검증된 리스크:**
- `@rrweb/packer` 쓰면 안 됨(per-event라 ~10배 큼) → 전체 gzip + unpackFn 없음.
- lazy `await import('./export')`(상대경로)는 0 delta 깨뜨림 → 별도 subpath + bare specifier 필수.
- file:// 외부 module 차단 → 현 viewer dist 그대로 못 씀, 단일 IIFE 재빌드 필요.
- **외부 리소스:** rrweb는 URL만 캡처 → 오프라인에선 원격 이미지/폰트가 깨짐(inherent). 질문 #2 참조.

**미해결 질문(정직하게):**
1. **(차단 게이트)** rrweb의 `sandbox=allow-same-origin` srcdoc iframe이 file:// origin에서 Chrome/Firefox/Safari **모두** DOM 리빌드 + `contentDocument` 읽기([DesignView.tsx:80](packages/viewer/src/design/DesignView.tsx))를 허용하는가? 일부 브라우저가 file:// srcdoc을 opaque-origin 취급 시 throw. **실제 더블클릭 테스트 전 커밋 금지.**
2. SDK rrweb config가 `inlineImages`/`inlineStylesheet`를 켜는가? 안 켜면 오프라인 리플레이에서 원격 에셋 깨짐 — backend-less 경로에선 켜는 게 나을 수 있음.
3. raw 50MB+ 극단 세션에서 거대 inline script 대신 compact-JSON 폴백/경고할 것인가?
4. meta-CSP를 Worker `REPLAY_CSP` 재사용(single source) vs 별도 정의?
5. Design-pick(annotation) 플로우도 오프라인 export 필요한가, record 경로 한정인가?
