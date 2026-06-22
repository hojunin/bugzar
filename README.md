# Bugzar

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

어떤 React 프론트엔드에도 드롭인하는 임베더블 **in-app QA 세션 레코더**. 컴포넌트 하나(`<Bugzar />`)로 rrweb DOM·콘솔·네트워크·스토리지·디자인 의견을 캡처해 self-contained 리플레이 HTML 로 만들고, 결정론 빌더(+ 선택적 Workers AI 다듬기)로 Jira 초안을 만들어 발행한다. **브라우저 확장 불필요.**

> **셀프호스팅 도구입니다.** 리플레이 HTML 은 본인 스토리지(S3/R2/…)에 올리고, Jira 발행 백엔드(Cloudflare Worker + R2 + Workers AI)와 Atlassian OAuth 앱을 직접 운영하는 구조라 외부 SaaS 의존이 없습니다(Atlassian Cloud 제외). SDK 통합은 [`packages/sdk`](./packages/sdk/README.md), 백엔드 셋업은 [`docs/SETUP.md`](./docs/SETUP.md) 참고.

## 시작하기 — 두 가지 길

```bash
npm install @bugzar/sdk
```

배포 여부로 두 갈래다. **둘 다 self-contained 리플레이 HTML 을 만든다** — 차이는 *Jira 자동 발행*뿐이다.

### 길 1 — 배포 없이 (즉시·무료)

서버 없이 캡처해 self-contained 리플레이 HTML 을 **로컬로 내려받아** 슬랙·이슈에 직접 첨부한다. `endpoint` 가 없을 때 `onExport` 가 받는 blob 이 곧 그 HTML 이고, 번들된 `downloadReplay` 헬퍼가 그걸 바로 파일로 저장한다.

```tsx
import { Bugzar, downloadReplay } from "@bugzar/sdk";

<Bugzar onExport={downloadReplay} />;
```

우하단 플로팅 **QA** 버튼 → 녹화 → 정지 → 더블클릭하면 오프라인에서 바로 열리는 HTML 이 떨어진다. (공유 URL 이 필요하면 같은 blob 을 본인 스토리지(S3/R2/…)에 올리고 그 URL 을 반환하면 된다.) **Jira 자동 발행·호스팅 리플레이는 길 2.** props·privacy·헤드리스 훅(`useBugzar`)은 [`packages/sdk/README.md`](./packages/sdk/README.md).

### 길 2 — 무료 배포로 Jira 까지 (≈5분, 거의 무료)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hojunin/bugzar)

버튼을 누르면 브라우저에서 레포를 포크하고 Cloudflare 계정에 백엔드(Worker + R2 + Workers AI)를 배포한다 — 로컬 설치·터미널 불필요. Cloudflare 무료 한도(R2 10GB · Workers 10만req/일 · Workers AI 1만뉴런/일)면 소규모 팀은 사실상 무료. 모노레포라 배포 마법사에서 한 번만 맞춰 준다:

- **Root directory** — `packages/backend`
- **Deploy command** — `pnpm run deploy` (뷰어 빌드까지 포함)

> ⚠️ 버튼은 **Worker + R2 까지** 한 번에 띄운다. 시크릿(Jira/Atlassian 자격증명)은 버튼에 담기지 않으니 배포 후 대시보드에서 직접 넣는다(아래 링크).

터미널이 편하면 한 줄로도 된다(동일 결과):

```bash
git clone https://github.com/hojunin/bugzar && cd bugzar
pnpm run deploy:backend
```

배포가 끝나면 출력된 `https://bugzar-backend.<sub>.workers.dev` 를 `endpoint` 로 연결한다. Jira 모드는 둘 중 하나:

```tsx
// (a) 서비스 계정 — 가장 쉬움. Worker 시크릿 JIRA_API_BASE/EMAIL/API_TOKEN/PROJECT_KEY 만 넣으면 끝
<Bugzar endpoint={ENDPOINT} jira={{ enabled: true }} />

// (b) per-user OAuth — 티켓이 리뷰어 본인 명의로 발행. Atlassian 3LO 앱 등록 필요
<Bugzar endpoint={ENDPOINT} jira={{ clientId: ATLASSIAN_CLIENT_ID }} />
```

- **(a) 서비스 계정** 시크릿·CORS·검증: [`docs/self-hosting-sdk.md`](./docs/self-hosting-sdk.md) (Worker 5분)
- **(b) per-user OAuth** 앱 등록·스코프·redirect URI(`…/oauth/callback`): [`docs/SETUP.md`](./docs/SETUP.md)

## 두 가지 모드

- **버그 신고** — rrweb DOM + 콘솔(스택 포함) + fetch/XHR(헤더·body·타이밍) + localStorage / sessionStorage 스냅샷 + Web Vitals. 정지 시 결정론 빌더가 timeline·콘솔 에러·실패 네트워크로 ADF 본문을 즉시 채움.
- **디자인 의견** — 페이지 위 element 픽 → 인라인 메모 → selector·컴포넌트명·메모를 담은 구조화 annotation. 리플레이는 좌측 스크린샷 + 우측 카드, 카드 클릭 시 해당 영역 하이라이트.

공통: 정지 시 `endpoint` + `jira` 가 설정돼 있으면 `DraftEditView`(review drawer)가 열려 검토·편집, 필요 시에만 "AI 로 다듬기" 로 Workers AI 한국어 다듬기 → "Jira 에 발행" 으로 끝. 발행 티켓엔 항상 `onExport` 가 반환한 리플레이 URL 포함.

## 핵심 차별점

- **재현 절차 자동 합성** — rrweb full-snapshot 의 노드를 `<tag>` + 텍스트 + selector 힌트(data-testid / aria-label / class)로 인덱싱, click / input / nav / 실패 network / console.error 를 시간순 정리. "이거 안돼요" 한 줄로도 "필터 열기 → 판매중 선택 → /graphql 500 → 결과 미표시" 가 나옴.
- **Epic 우선 발행** — Jira 프로젝트를 묻지 않음. JQL `summary ~` 로 접근 가능한 Epic 검색·선택, prefix 에서 프로젝트 자동 도출. 기본값 "내가 assignee/reporter", 마지막 Epic auto-prefill.
- **캡처 시점 토큰 스크럽** — network body·storage·console 의 민감 키·JWT 를 페이지 밖으로 나가기 전에 redact. `onBeforeUpload` 로 번들 전체를 직접 스크럽 가능, cookie 는 캡처하지 않음.
- **per-user OR 서비스 계정 Jira** — `jira.clientId` 로 리뷰어 본인 Atlassian 계정 OAuth 발행(티켓이 그 사람으로 기록), 또는 `jira.enabled` 로 Worker 서비스 계정. 시크릿은 브라우저에 닿지 않음.
- **온프레미스 친화 백엔드** — Cloudflare Worker + R2 단일 bucket + Workers AI (Llama 3.1 8B). 외부 SaaS 의존 0 (Atlassian Cloud 제외).

## 사용

1. 호스트 React 앱에 `<Bugzar />` 마운트 (또는 `useBugzar` 훅으로 직접 버튼 구성)
2. (Jira 발행 시) Worker `endpoint` + `jira` prop 설정 → 첫 발행 시 per-user OAuth 동의 또는 서비스 계정
3. 플로팅 QA 버튼 → 녹화/픽 → 한 줄 메모 → 초안 검토 → (선택) AI 다듬기 → Epic 선택 → 발행

리포트 인덱스: `https://bugzar-backend.<your-subdomain>.workers.dev/` (검색·모드 필터, 행 클릭 → 리플레이)

---

## 아키텍처

```
packages/
├─ sdk/           임베더블 React 레코더 (@bugzar/sdk, npm) — 플로팅 툴바 + 헤드리스 훅
├─ capture-core/  캡처 엔진 (rrweb·console·network·storage patch, chrome.* 의존 0)
├─ backend/       Cloudflare Worker (R2 + Workers AI + Atlassian proxy + 리플레이 호스팅)
├─ viewer/        리플레이 뷰어 (/r/<id>, Worker 에 baked)
└─ shared/        메시지·스키마 타입 (SCHEMA_VERSION + postMessage bridge)
```

**캡처 → 발행 흐름** (공통 — bug/design 둘 다):

1. `<Bugzar />` 가 녹화 중에만 page 를 계측(`console` · `fetch`/`XHR` · storage patch + rrweb), 정지 시 전부 복원.
2. 정지 → 번들을 self-contained 리플레이 HTML 로 빌드 → `onExport`(본인 스토리지 업로드). `endpoint` + `jira` 설정 시 → ① 번들을 `POST /reports` + R2 자산 PUT → ② 결정론 빌더로 ADF 생성 → `DraftEditView`.
3. (선택) "AI 로 다듬기" → `POST /jira/draft` → Workers AI(json_schema) → ADF 교체. 실패 시 `AiFallbackView`.
4. "Jira 에 발행" → per-user 토큰(브라우저) 또는 Worker 서비스 계정으로 `createIssue` → `SubmittedView`.

**Worker 라우트**: `POST /reports` (id 발급) · `PUT/GET /reports/<id>/X` · `GET /r/<id>` (replay.html) · `GET /` (인덱스) · `POST /jira/draft` (AI 다듬기) · `POST /oauth/exchange` · `GET /oauth/callback` (per-user 3LO) · `GET /__state`. R2 bucket `bugzar-artifacts`, prefix `reports/<id>/`. AI 출력은 `extractJsonFromAiResponse` 로 코드펜스·prose·후미 chatter·balanced-brace 핸들.

**OAuth (Atlassian 3LO)** — confidential client 라 token exchange 시 PKCE + `client_secret` 둘 다 필요. 시크릿은 Worker 가 보관하고 브라우저엔 public `clientId` 만 노출(`jira.clientId`). 서비스 계정 모드(`jira.enabled`)는 Worker 가 토큰을 들고 발행.

**Storage** — `localStorage`(per-user OAuth 토큰·옵션) / IDB(녹화 중 rrweb·console·network·storage·video 버퍼) / 리플레이 HTML 은 `onExport` 가 받는 본인 스토리지 / R2(`endpoint` 사용 시 발행 자산, 영구).

**마스킹** — `mask`(기본 ON, 텍스트 input 마스킹; password 는 항상) / `redactState`(app-state 스냅샷) / `onBeforeUpload`(번들 전체 last-chance 스크럽). AI 직전 `sanitizeForAI` 로 Authorization·Cookie·JWT redact, R2 원본은 보존.

---

## 개발

```bash
pnpm install
pnpm --filter @bugzar/sdk build            # tsup — npm 패키지 빌드 (exports map + .d.ts)
pnpm --filter @bugzar/sdk test             # vitest
pnpm --filter @bugzar/backend dev          # wrangler dev (:8787)
pnpm --filter @bugzar/backend run deploy   # Cloudflare 배포 (뷰어 빌드 포함)
pnpm test                               # vitest 전 패키지
pnpm check[:fix]                        # Biome
```

Backend 배포·OAuth 앱 등록·R2/Workers AI 셋업: [`docs/SETUP.md`](./docs/SETUP.md).

## 문서

- 백엔드 셀프호스팅 setup·OAuth scope 표·R2/Workers AI: [`docs/SETUP.md`](./docs/SETUP.md)
- SDK 통합·props·Jira 발행·privacy: [`packages/sdk/README.md`](./packages/sdk/README.md)
- SDK 빠른 셀프호스팅(Worker 5분): [`docs/self-hosting-sdk.md`](./docs/self-hosting-sdk.md)
- 기여 방법: [`CONTRIBUTING.md`](./CONTRIBUTING.md) · 보안 신고: [`SECURITY.md`](./SECURITY.md)
