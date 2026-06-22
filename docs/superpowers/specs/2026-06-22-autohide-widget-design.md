# Bugzar SDK — `autoHide`: hover-reveal 위젯 (코너 핫스팟 + 사용 중 fix + 2초 grace)

- **Date:** 2026-06-22
- **Status:** Design approved → `/goal` 실행 대기.
- **Branch:** `main` (작업 시 `feat/autohide-widget` 권장)
- **Touches:** `packages/sdk` — `Bugzar.tsx`(`BugzarProps` + 로직), `styles.ts`(CSS 추가), `__tests__/Bugzar.test.tsx`. **`capture-core` / `backend` / `viewer` / `public-types.ts` 변경 없음.**
- **Breaking:** No — `autoHide` 기본 `false`. 끄면 현재 동작과 100% 동일.

## Problem / Goal

`<Bugzar />`를 설치하면 우측 하단에 툴바가 **항상 고정 노출**되어 호스트 앱에서 노이즈가 된다.
원할 때만 꺼내 쓰도록, **평소엔 숨기고 코너에 마우스를 가져가면 툭 올라오는** 동작을 추가한다.
단 녹화/주석/리뷰 등 **실제 사용 중에는 마우스가 떠나도 내려가지 않아야** 하고, 다 쓰고 닫으면
**최초 위젯 상태로 2초간 머문 뒤 다시 내려가야** 한다.

이 동작은 배포되는 SDK의 기존 사용처에 영향을 주지 않도록 **opt-in prop**으로 넣는다.

## API

```tsx
<Bugzar autoHide />        // 이 제품에서만 켬
<Bugzar />                 // 기본 false — 지금과 동일하게 항상 고정 노출
```

- `BugzarProps`에 `autoHide?: boolean` 추가. 기본 `false`.
- `autoHide === false`: **렌더 경로/마크업/CSS 모두 현재와 동일**(dock·핫스팟·리스너 없음). 기존 테스트 무변경 통과.
- `autoHide === true`: 아래 reveal 로직 활성화.

## 동작 명세 (상태 머신)

위젯은 **collapsed**(내려감) ↔ **revealed**(올라옴) 두 시각 상태를 가진다.

```
revealed = hovering  ∥  inUse  ∥  grace
```

| 입력 | 정의 |
|---|---|
| `hovering` | 커서가 **reveal 핫존** 안에 있음 (아래 "감지 방식"). |
| `inUse` | `recording ∥ uploading ∥ picking ∥ drawer(열림)` — "제품을 사용 중". `true`면 hover와 무관하게 항상 revealed (= **fix**). |
| `grace` | `inUse`가 `true→false`로 끝나 idle로 복귀한 직후 **2초** 동안 `true`. 종료 시 hover 여부로 자연 폴백. |

- **마운트 직후**: `collapsed`로 시작(grace 없음). → 설치 시 노이즈 제거.
- **사용 시작**(녹화/주석 클릭): `inUse=true` → 즉시 revealed 고정.
- **사용 종료/닫기**(녹화 정지 후 idle 복귀, picker 종료, ReviewDrawer `onClose`): idle 토글바로 돌아오며 `grace=true` → 2초 후 collapse. 단 2초 사이/직후 hover 중이면 그대로 열려 있다가 떠날 때 내려감.

> 참고: `picking`/`drawer` 상태에선 컴포넌트가 toolbar 대신 picker/ReviewDrawer를 렌더(기존 early-return).
> dock은 idle/recording/uploading 경로에서만 그려지므로, dock 입장에서 `inUse`는 사실상 `recording ∥ uploading`이고,
> `picking`/`drawer` → idle 복귀는 `grace`가 담당한다.

## 감지 방식 (택1 — 확정)

**기하학적 `pointermove` 감지를 사용한다. CSS `:hover`/엘리먼트 이벤트는 쓰지 않는다.**

이유: collapsed 트리거를 "투명 + 완전 숨김"으로 두면, 코너에 보이지 않는 클릭 차단 영역이 생겨
그 아래 페이지 요소 클릭을 먹어버린다(더 큰 노이즈). dock을 `pointer-events: none`으로 두고
좌표로만 판정하면 **클릭을 전혀 막지 않는다**.

- `window`에 passive `pointermove` 리스너 1개 (autoHide && mounted일 때만 부착, unmount 시 해제).
- **reveal 핫존 = 다음 두 사각형의 합집합**:
  - **A. 코너 핫스팟** — `window.innerWidth/innerHeight`로 계산하는 고정 `300×30` 사각형
    (bottom-right 기준 `[vw-300, vw] × [vh-30, vh]`). 레이아웃 측정 불필요 → 항상 신뢰 가능.
  - **B. 툴바 rect** — `.bugzar-root`의 `getBoundingClientRect()`(±4px 여유). revealed 상태에서 커서가
    올라온 툴바 위에 머물 때 keep-alive.
- `hovering = inside(A) ∨ inside(B)`. 합집합이라 (A)만으로도 열림 유지가 되어 **레이아웃 없는 테스트 환경(happy-dom)에서도 결정적**.
- `inUse`인 동안엔 revealed가 강제되므로 hovering 갱신은 무시해도 무방.

### 슬라이드 / 위치

- 슬라이드는 `.bugzar-root`의 `transform: translateY()` + `transition: transform ~240ms ease`.
  - collapsed: `translateY(calc(100% + 20px))` (툴바 높이 40px + 코너 여백 20px만큼 화면 밖 아래로).
  - revealed: `translateY(0)`.
- **위치별 방향**: `bottom-*`는 아래로, `top-*`는 위로 숨김(앵커된 세로 모서리 쪽). 부호만 반전.
- `prefers-reduced-motion: reduce`: `.bugzar-root` transform transition 비활성(스냅). 기존 reduced-motion 블록에 추가.

### 마크업 / 접근성

- dock 래퍼: `.bugzar-dock`(autoHide on일 때만). `position: fixed`, 코너 앵커, `z-index: 2147483646`, `pointer-events: none`.
- 내부 `.bugzar-root`(기존 toolbar 그대로) → dock 안에서 `position: absolute` 코너 배치 + transform 슬라이드.
  버튼은 `pointer-events: auto`(revealed일 때 클릭 가능). collapsed 시 화면 밖이라 코너를 막지 않음.
- collapsed(`!revealed && !inUse`)일 때 `.bugzar-root`에 `inert` + `aria-hidden`을 걸어 탭 순서/스크린리더에서 제외.
- dock에 `data-bugzar-revealed="true|false"` 노출 (테스트 훅 겸 상태 표현).
- **알려진 한계(스코프 외)**: 투명 hover 핫스팟은 마우스 전용 — 터치엔 hover가 없어 도달 불가.
  QA 도구는 데스크톱 중심이므로 한계로 명시하고 추가 복잡도(탭 토글 등)는 넣지 않는다.
- 헤드리스 `useBugzar` 훅: 소비자가 UI를 직접 그림 → **변경 없음**.

## 구현 개요

1. `BugzarProps`에 `autoHide?: boolean` 추가(JSDoc 포함), 시그니처 기본값 `autoHide = false`.
2. toolbar JSX(`<div className="bugzar-root …">…</div>`)를 변수로 추출.
   - `autoHide` off → 기존과 동일하게 `createPortal(toolbar, body)`.
   - `autoHide` on → `createPortal(<dock>{toolbar}</dock>, body)`.
3. autoHide on 경로에 상태/효과 추가:
   - `const [hovering, setHovering] = useState(false)`, `const [grace, setGrace] = useState(false)`.
   - `inUse = recording || uploading || picking || !!drawer`.
   - `revealed = hovering || inUse || grace`.
   - `useEffect`로 `window` passive `pointermove` 부착(autoHide일 때만) → 핫존 합집합 판정으로 `setHovering`.
   - `useEffect`로 `inUse` 이전값(ref) 추적 → `true→false` 시 `setGrace(true)` + 2초 `setTimeout` → `setGrace(false)`; 재진입/`inUse` 재개 시 타이머 클리어, unmount 시 클리어.
4. `styles.ts`에 `.bugzar-dock` 및 `.bugzar-dock .bugzar-root` 슬라이드/위치/`pointer-events` 규칙과
   `[data-bugzar-revealed]` 상태 규칙, reduced-motion 항목 추가. **기존 셀렉터는 수정하지 않고 추가만** 한다.

## 테스트 계획 (`__tests__/Bugzar.test.tsx` 확장)

기존 컨벤션 유지: `vitest` + `@testing-library/react`, `vi.useFakeTimers()`(이미 설정됨), 포털이라 `document.querySelector`로 조회.

1. **off 기본**: `<Bugzar />` 렌더 시 `document.querySelector('.bugzar-dock')`가 `null`. 기존 FAB/pill 테스트 무변경 통과.
2. **on 마운트**: `<Bugzar autoHide />` → `.bugzar-dock[data-bugzar-revealed="false"]` 존재(collapsed). 토글바는 DOM에 있으나 `inert`/`aria-hidden`.
3. **hover reveal**: `window.innerWidth/innerHeight` 읽어 코너 안 좌표로 `pointermove` 디스패치 → `data-bugzar-revealed === "true"`.
4. **leave collapse**: `(0,0)`로 `pointermove` → `data-bugzar-revealed === "true→false"`.
5. **inUse fix**: Start recording 클릭 후, hover 없이도 `data-bugzar-revealed === "true"`.
6. **2초 grace**: 녹화 시작→정지(sink 미설정 → idle 복귀) 직후 revealed가 `"true"`; `vi.advanceTimersByTime(2000)` 후 `"false"`. (정지 직후 코너로 `pointermove`하면 2초 경과 후에도 `"true"` 유지.)

## Exit Conditions (Definition of Done) — `/goal` 탈출조건

**아래가 전부 충족되면 종료한다.**

### A. 검증 커맨드(모두 green)
1. `pnpm --filter @bugzar/sdk typecheck` — 타입 에러 0.
2. `pnpm --filter @bugzar/sdk test` — 신규 포함 전체 통과.
3. `pnpm check` — biome 통과(포맷/린트). 필요 시 `pnpm check:fix` 후 재확인.

### B. 동작 충족(위 "테스트 계획" 1–6이 실제 테스트로 존재하고 통과)
- off 기본: `.bugzar-dock` 미생성, 기존 동작 무변경.
- on: 마운트 collapsed → 코너 hover시 revealed → leave시 collapse.
- recording/uploading 등 `inUse` 중 hover 무관 revealed 고정.
- `inUse→idle` 복귀 후 2초간 revealed 유지 → 이후 collapse(hover 중이면 유지).

### C. 무회귀 / 스코프
- 기존 `Bugzar.test.tsx` 케이스 전부 무변경 통과.
- 변경 파일은 `packages/sdk`의 `Bugzar.tsx`, `styles.ts`, props 타입, `Bugzar.test.tsx`로 한정.
  `capture-core`/`backend`/`viewer`/`useBugzar` 비변경.
- `styles.ts`는 **기존 셀렉터 수정 없이 추가만**.

### 빠른 inner-loop 팁
- 반복 중엔 `pnpm --filter @bugzar/sdk exec vitest run`으로 `pretest`(viewer 재생성) 건너뛰기 가능.
  최종 게이트는 위 A의 정규 커맨드로 확인.
