# 백엔드 + Jira 셋업 가이드

이 문서는 **Jira 발행**과 **AI 초안 다듬기**가 필요할 때만 따라 하면 된다.
그 외 캡처·리플레이·로컬 저장·URL 공유는 SDK(`@bugzar/sdk`)만으로 동작하므로
백엔드를 배포할 필요가 없다 → [README 1단계](../README.md#1단계--빠른-설치) 참고.

배포 대상은 Cloudflare Worker 하나다. Worker 가 ① 리포트 자산을 R2 에 저장하고
② Workers AI(Llama 3.1 8B)로 Jira 초안을 다듬고 ③ Atlassian 으로 이슈를 발행한다.
시크릿(Jira/Atlassian 자격증명)은 Worker 가 보관하며 브라우저에 닿지 않는다.

> 스크린샷은 각 단계의 `📷` 표시 자리에 들어간다.

---

## 사전 준비물

- **Cloudflare 계정** (무료 플랜으로 충분 — R2 10GB · Workers 10만 req/일 · Workers AI 1만 뉴런/일)
- **Node.js ≥ 22.20**, **pnpm 9**
- **Atlassian Cloud 사이트** + 이슈 생성 권한이 있는 계정 (Jira 발행을 쓸 경우)

---

## 1. Worker 배포

레포를 받아 한 줄만 실행하면 의존성 설치 → Cloudflare 로그인 → R2 버킷 생성 →
뷰어 빌드 → Worker 배포까지 자동으로 진행된다.

```bash
git clone https://github.com/hojunin/bugzar && cd bugzar
pnpm run deploy:backend
```

처음 실행 시 Cloudflare 로그인을 위해 브라우저가 자동으로 열린다. 로그인을 허용한다.

> 📷 _스크린샷 자리 — Cloudflare 로그인(wrangler) 브라우저 인증 화면_

R2 가 처음이라면 계정에서 한 번 활성화해야 할 수 있다. 그럴 경우 안내 메시지가
출력되니, [Cloudflare 대시보드 → R2](https://dash.cloudflare.com/?to=/:account/r2) 에서
R2 를 활성화한 뒤 다시 `pnpm run deploy:backend` 를 실행한다.

배포가 끝나면 출력 마지막 줄에 **백엔드 주소**가 찍힌다. 이후 단계에서 계속 쓰니 복사해 둔다.

```
https://bugzar-backend.<your-subdomain>.workers.dev
```

> 📷 _스크린샷 자리 — 배포 완료 후 출력된 Worker URL_

여기까지만 해도 SDK 에 `endpoint` 만 연결하면 자산 업로드·리플레이 호스팅은 동작한다.
**Jira 발행**까지 쓰려면 아래 모드 중 하나를 고른다.

---

## 2. Jira 발행 모드 고르기

| | **모드 A — 서비스 계정** | **모드 B — per-user OAuth** |
|---|---|---|
| 발행자 명의 | 팀 공용 1계정 | 리뷰어 본인 |
| 설정 난이도 | 쉬움 (API 토큰만) | 보통 (Atlassian 앱 등록) |
| 리뷰어 추가 작업 | 없음 | 첫 발행 시 1회 로그인 |
| 적합한 경우 | 빠르게 띄우고 싶을 때 | 누가 올렸는지 기록이 중요할 때 |

둘 다 시크릿은 Worker 에만 저장되고 브라우저로 내려가지 않는다. 한쪽만 설정하면 된다.

---

## 3. 모드 A — 서비스 계정

### 3-1. Atlassian API 토큰 발급

1. [id.atlassian.com → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) 접속
2. **Create API token** 클릭 → 라벨(예: `bugzar`) 입력 → 생성
3. 표시된 토큰을 복사 (이 화면을 벗어나면 다시 볼 수 없다)

> 📷 _스크린샷 자리 — Atlassian API 토큰 생성 화면_

### 3-2. Worker 시크릿 등록

`packages/backend` 에서 시크릿 4개를 넣는다. 값은 입력해도 화면에 표시되지 않는다.

```bash
cd packages/backend
pnpm exec wrangler secret put JIRA_API_BASE      # 예: https://your-org.atlassian.net
pnpm exec wrangler secret put JIRA_EMAIL         # Atlassian 로그인 이메일
pnpm exec wrangler secret put JIRA_API_TOKEN     # 3-1 에서 복사한 토큰
pnpm exec wrangler secret put JIRA_PROJECT_KEY   # 예: BUGZAR
```

### 3-3. SDK 연결

호스트 앱(= `@bugzar/sdk` 를 설치한 본인의 React 앱)에 `endpoint` 와 `jira` 를 연결한다.

```tsx
const ENDPOINT = "https://bugzar-backend.<your-subdomain>.workers.dev";

<Bugzar endpoint={ENDPOINT} jira={{ enabled: true, projectKey: "BUGZAR" }} />;
```

→ [5. 동작 확인](#5-동작-확인) 으로 이동.

---

## 4. 모드 B — per-user OAuth (Atlassian 앱 등록 가이드)

리뷰어 본인 명의로 티켓이 발행된다. Atlassian OAuth 2.0 (3LO) 앱을 한 번 등록해야 한다.

### 4-1. 앱 생성

1. [Atlassian developer console](https://developer.atlassian.com/console/myapps/) 접속
2. **Create** → **OAuth 2.0 integration** 선택
3. 앱 이름(예: `Bugzar`) 입력 → 약관 동의 → **Create**

> 📷 _스크린샷 자리 — Create → OAuth 2.0 integration 선택_

> 📷 _스크린샷 자리 — 앱 이름 입력 후 생성_

### 4-2. 권한(스코프) 추가

좌측 **Permissions** 탭 → **Jira API** 줄의 **Add** → 이어서 **Configure** 클릭 →
**Granular scopes** 에서 아래 스코프를 **모두** 추가한다.
SDK 가 인증 시 요청하는 목록이라, 하나라도 빠지면 동의 단계에서 실패한다.
(원본 정의: [`packages/sdk/src/oauth/atlassian.ts`](../packages/sdk/src/oauth/atlassian.ts))

```
read:issue:jira
write:issue:jira
write:comment:jira
write:comment.property:jira
write:attachment:jira
read:project:jira
read:project.property:jira
read:project-category:jira
read:project-version:jira
read:project.component:jira
read:application-role:jira
read:group:jira
read:issue-type-hierarchy:jira
read:avatar:jira
read:user:jira
read:issue-type:jira
read:issue-details:jira
read:issue-meta:jira
read:field-configuration:jira
read:audit-log:jira
read:jql:jira
read:issue-status:jira
read:email-address:jira
offline_access
```

> 📷 _스크린샷 자리 — Permissions → Jira API → Granular scopes 추가 화면_

### 4-3. Callback URL 등록

좌측 **Authorization** 탭 → **OAuth 2.0 (3LO)** 의 **Configure** → **Callback URL** 에
1단계에서 복사한 Worker 주소 뒤에 `/oauth/callback` 을 붙여 등록한다.

```
https://bugzar-backend.<your-subdomain>.workers.dev/oauth/callback
```

> 📷 _스크린샷 자리 — Authorization → Callback URL 등록 화면_

### 4-4. Client ID / Secret 복사

좌측 **Settings** 탭에서 **Client ID** 와 **Secret** 을 복사한다.

> 📷 _스크린샷 자리 — Settings 탭의 Client ID / Secret_

### 4-5. Worker 시크릿 등록

`packages/backend` 에서 시크릿 2개를 넣는다.

```bash
cd packages/backend
pnpm exec wrangler secret put ATLASSIAN_CLIENT_ID       # 4-4 의 Client ID
pnpm exec wrangler secret put ATLASSIAN_CLIENT_SECRET   # 4-4 의 Secret
```

### 4-6. SDK 연결

호스트 앱에는 **public Client ID 만** prop 으로 넘긴다. **Secret 은 절대 코드/프론트에 넣지 않는다** — Worker 가 보관한다.

```tsx
const ENDPOINT = "https://bugzar-backend.<your-subdomain>.workers.dev";

<Bugzar
  endpoint={ENDPOINT}
  jira={{ clientId: "<4-4 에서 복사한 Client ID>", projectKey: "BUGZAR" }}
/>;
```

리뷰어는 첫 발행 때 **Connect Atlassian** 팝업으로 한 번 로그인한다. 이후에는
저장된 토큰으로 본인 명의 발행이 바로 된다.

> 📷 _스크린샷 자리 — 리뷰어의 첫 "Connect Atlassian" 로그인 팝업_

---

## 5. 동작 확인

브라우저로 아래 주소를 열면 헬스 체크와 현재 Jira 모드가 보인다.

```
https://bugzar-backend.<your-subdomain>.workers.dev/__state
```

- Jira 모드가 **`real`** 이면 발행 준비 완료다.
- **`stub`** 이면 시크릿이 누락된 것이다 (모드 A 의 `JIRA_*` 또는 모드 B 의 `ATLASSIAN_*`).
  `stub` 상태에서 발행하면 실제 이슈가 만들어지지 않고 `STUB-…` 플레이스홀더만 반환된다.

실제 흐름: 호스트 앱에서 우하단 **QA** 버튼 → 녹화 → 정지 → **검토 드로어**에서
제목·설명·Epic 검토 → (선택) **AI 로 다듬기** → **Jira 에 발행**.

> 📷 _스크린샷 자리 — 발행된 Jira 티켓 (리플레이 링크 포함)_

---

## 6. (선택) 프로덕션 노출 시 하드닝

인터넷에 공개되는 Worker 라면 [`packages/backend/wrangler.toml`](../packages/backend/wrangler.toml)
주석을 참고해 아래를 설정한다.

- `PUBLIC_DEPLOY = "1"` — 익명 쓰기/발행을 막고 `/` 리포트 인덱스를 숨긴다(fail-closed).
- `ALLOWED_ORIGINS` — 허용할 앱 오리진 목록 (예: `https://app.yourco.com`).
- `UPLOAD_SECRET` — 자산 쓰기를 발행 토큰에 묶는 비밀값.
- `ADMIN_SECRET` — `DELETE /reports/:id` 및 삭제 CLI 용 관리자 토큰.

---

## 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| 배포 중 R2 관련 오류 | 대시보드에서 R2 를 한 번 활성화 후 재실행 |
| `/__state` 가 `stub` | 시크릿 누락 — 모드 A 의 `JIRA_*` 또는 모드 B 의 `ATLASSIAN_*` 확인 |
| OAuth 동의 단계에서 실패 | 4-2 의 granular 스코프 누락, 또는 4-3 Callback URL 불일치 |
| 발행은 됐는데 `stubbed: true` | Worker 가 미설정 상태 — 실제 이슈 아님. 시크릿 등록 후 재시도 |

---

## 참고 문서

- SDK 통합·props·privacy: [`packages/sdk/README.md`](../packages/sdk/README.md)
- 백엔드 패키지: [`packages/backend/README.md`](../packages/backend/README.md)
