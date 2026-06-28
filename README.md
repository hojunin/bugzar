# Bugzar

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@bugzar/sdk.svg)](https://www.npmjs.com/package/@bugzar/sdk)

React 앱에 간단히 임베딩 가능한 QA recorder.

- **버그 신고** — 녹화 시작/정지로 DOM·콘솔(스택)·fetch/XHR·storage·Web Vitals·Resource Timing·시스템 정보 캡처 → 재현 절차 자동 합성. SPA 라우팅(클라이언트 네비게이션)으로 컴포넌트가 언마운트돼도 녹화가 끊기지 않는다
- **디자인 의견** — 페이지 위 element 픽 → 메모 → selector·컴포넌트명이 붙은 구조화 annotation

## 시연 영상

| 녹화 버전 (버그 신고) | 디자인 버전 (의견 픽) |
|---|---|
| https://github.com/user-attachments/assets/f71323d3-b365-4de3-95eb-b77e586c238e | <!-- TODO: 영상 URL 삽입 --> [▶︎ 디자인 시연 보기](#) |



## 설치

### 1단계 — 빠른 설치

정지 시 `onExport` 가 self-contained 리플레이 HTML(blob)을 넘겨준다. 받아서 어떻게 쓰는지는 자유 — **아래 둘 다 Bugzar 백엔드 없이 동작한다.**

```bash
npm install @bugzar/sdk
```

**A. 로컬 파일로 저장** — 번들된 `downloadReplay` 가 HTML 을 바로 파일로 떨군다. 더블클릭하면 오프라인에서 열린다.

```tsx
import { Bugzar, downloadReplay } from "@bugzar/sdk";

<Bugzar onExport={downloadReplay} />;
```

**B. 정적 호스트에 올려 URL 로 공유** — 같은 blob 을 본인 스토리지(S3 · R2 · GitHub Pages …)에 올리고 public URL 을 반환하면, 그 URL 이 곧 공유용 리플레이 링크다. (리플레이 호스팅엔 Worker 가 필요 없다 — `endpoint` 의 Worker 는 Jira 발행 전용.)

```tsx
import { Bugzar } from "@bugzar/sdk";

<Bugzar
  onExport={async (blob, meta) => {
    const key = `qa/${meta.mode}-${meta.startedAt}.html`;
    await uploadToYourStorage(key, blob); // S3/R2 presigned PUT 등
    return publicUrl(key); // ← 반환한 URL 이 공유 링크 (Jira 발행 시 티켓에도 첨부됨)
  }}
/>;
```

우하단 플로팅 **QA** 버튼 → 녹화 → 정지 시 `onExport` 가 발화한다.

### 2단계 — 백엔드 + Jira (선택)

**Jira 발행과 AI 초안 다듬기가 필요할 때만** Cloudflare Worker(R2 + Workers AI)를 배포한다. 그 외 캡처·리플레이·공유는 1단계로 충분하다.

```bash
git clone https://github.com/hojunin/bugzar && cd bugzar
pnpm run deploy:backend   # 로그인 → R2 생성 → 뷰어 빌드 → 배포 (한 줄)
```

배포 후 출력된 `https://bugzar-backend.<sub>.workers.dev` 를 `endpoint` 로 연결하고 Jira 모드(서비스 계정 또는 per-user OAuth)를 고르면 된다.

> **Atlassian 앱 등록·시크릿 설정·발행 확인까지 전체 절차 → [백엔드 + Jira 셋업 가이드](./docs/backend-setup.md)**

## 제공 API — `<Bugzar />` props

모두 선택값이다. 콜백만 넘기면 백엔드 없이 동작하고, `endpoint` + `jira` 를 더하면 검토 드로어·Jira 발행이 켜진다.

| Prop | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `onExport` | `(blob, meta) => Promise<string \| void>` | 선택 | – | 빌드된 self-contained 리플레이 HTML 수신 → 본인 스토리지(S3/R2/…)에 올리고 public URL 반환. 정지·디자인 픽 완료 시 발화(`meta.mode`로 구분) |
| `autoHide` | `boolean` | 선택 | `false` | 툴바를 코너 밖으로 숨김 — 코너 `hoverZone` 에 커서가 들어올 때 / 사용 중(녹화·픽·업로드·드로어) / 사용 후 2초간만 노출. 마우스 hover 전용 |
| `hoverZone` | `{ width?; height? }` | 선택 | `{ width: 300, height: 30 }` | `autoHide` 시 툴바를 불러내는 보이지 않는 코너 영역 크기(px). 기본 영역이 본인 UI 와 겹치면 줄인다 |
| `endpoint` | `string \| { url; headers? }` | **Jira 시 필수** | – | Worker base URL (**Jira 백엔드 전용**). `jira` 와 함께 설정 시 검토 드로어 활성 |
| `jira` | `{ enabled?; clientId?; defaultEpicKey? }` | **Jira 시 필수** | – | Jira 발행 설정. `enabled` = 서비스 계정 / `clientId` = per-user OAuth. 프로젝트는 선택한 Epic 키에서 자동 도출(`BUGZAR-123` → `BUGZAR`) |
| `onStart` | `() => void` | 선택 | – | 녹화 시작 시 호출 |
| `mask` | `boolean` | 선택 | `true` | 모든 텍스트 input 마스킹 (password 는 항상) |
| `position` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'` | 선택 | `'bottom-right'` | 툴바 위치 |
| `offset` | `number \| { x?; y? }` | 선택 | `20` | 앵커된 코너 모서리로부터의 inset(px). 숫자는 양축 동일, `{ x, y }` 는 축별 지정(생략 축은 20). 툴바·검토 드로어에 모두 적용 |
| `theme` | `'light' \| 'dark' \| 'auto'` | 선택 | `'auto'` | 컬러 테마 |
| `design` | `boolean` | 선택 | `true` | 디자인 의견용 "Pick" 버튼 표시 |
| `onAnnotate` | `(annotations: DesignAnnotation[]) => void` | 선택 | – | 디자인 픽 완료 시 annotation 전달 |
| `onPublished` | `(result: PublishResult) => void` | 선택 | – | 발행 시도 후 호출. `stubbed === true` 면 실제 발행 안 됨 |
| `onError` | `(error: Error) => void` | 선택 | – | `onExport`·발행 실패 시 |
| `captureState` | `() => unknown` | 선택 | – | 호스트 app-state 를 번들 timeline 에 캡처 (직렬화 + redact) |
| `redactState` | `(state) => unknown` | 선택 | – | 각 state 스냅샷 redact (내장 키/JWT 마스킹 이후) |

> 플로팅 툴바 대신 직접 버튼을 만들고 싶으면 헤드리스 훅 `useBugzar`, 백엔드 없이 파일 저장은 `downloadReplay`, 프로그래매틱 픽은 `startDesignPick` 도 export 된다. 상세 타입·예시는 [SDK README](./packages/sdk/README.md).

---

**더 보기** — SDK 통합·props·privacy: [packages/sdk/README.md](./packages/sdk/README.md) · 백엔드 셋업: [packages/backend/README.md](./packages/backend/README.md) · 기여: [CONTRIBUTING.md](./CONTRIBUTING.md) · 보안: [SECURITY.md](./SECURITY.md)
