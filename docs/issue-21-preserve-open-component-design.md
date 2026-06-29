# 이슈 #21 — FAB 누름이 열린 outside-click 컴포넌트를 닫는 문제 (설계)

> 상태: 3인 교차 리뷰 수렴(DOM 이벤트 / SDK·DX / QA·UX, 전원 GO-WITH-CHANGES). 테스트 작성 완료, `/goal` 실행 대기.
> 범위: **접근 (i) — FAB pointerdown capture-phase 선점만.** 백스톱 (ii)(동결 오버레이)는 **deferred**. 키보드 단축키는 **배제**(이슈 확정).

## 1. 문제

디자인 QA로 Select·Tooltip·Modal·SideSheet 등 "outside-click 시 닫히는" 컴포넌트를 **열린 상태 그대로** 리포트하려는데, Design FAB을 누르는 순간 그 누름이 호스트 페이지의 outside-click으로 인식되어 컴포넌트가 닫힌다.

근본 타이밍(`packages/sdk/src/Bugzar/index.tsx`):
- FAB 누름 → 호스트의 document 리스너(대개 **bubble-phase `pointerdown`**, Radix/Headless UI/Floating UI/MUI)가 dismiss를 발화 → 컴포넌트 닫힘
- **그 다음** React `onClick`(`Toolbar.tsx` → `onPick`) → `startPick()`이 `captureSnapshot`(`index.tsx:220`) 실행 → 이미 닫힌 화면을 캡처

## 2. 접근 (i) — FAB 누름을 capture-phase에서 선점

mount 시 `document`에 **네이티브 capture-phase** 리스너를 깐다. 전파 순서는 `capture(document→body→FAB) → target → bubble(FAB→body→document)`. 호스트의 dismiss는 대개 **document bubble-phase**라 우리 capture 리스너가 **먼저** 실행 → 누름이 호스트 핸들러에 도달하기 전에 차단 → 컴포넌트가 **열린 채 유지** → click 시점 `captureSnapshot`이 열린 상태를 캡처.

```ts
// Bugzar/index.tsx — mount effect (deps: [])
useEffect(() => {
  // 누름이 .bugzar-fab/.bugzar-pill(툴바 컨트롤)일 때만 작동.
  const onPointerDown = (e: Event) => {
    if ((e.target as Element | null)?.closest?.('.bugzar-fab, .bugzar-pill'))
      e.stopPropagation();           // pointerdown: 전파만 차단 (preventDefault 금지 — 터치 활성화 보호)
  };
  const onMouseDown = (e: Event) => {
    if ((e.target as Element | null)?.closest?.('.bugzar-fab, .bugzar-pill')) {
      e.stopPropagation();
      e.preventDefault();            // mousedown(마우스 전용): focus-steal 차단 → focusout/blur dismiss 방지
    }
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('mousedown', onMouseDown, true);
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('mousedown', onMouseDown, true);
  };
}, []);
```

FAB의 React `onClick → startPick`은 **그대로** 산다(별도 click 이벤트, portal 루트 `document.body`에서 위임 — `stopPropagation`은 click을 막지 않음). 픽 모드 진입 후엔 기존 picker의 capture-phase 억제(`picker.ts:370-373`)가 이어받는다.

### 왜 이 메커니즘인가 (3인 리뷰 근거)

- **React 19 + portal-to-body 검증(DOM 리뷰):** Toolbar는 `createPortal(…, document.body)`이라 React 합성 리스너가 **`document.body`**에 위치한다. 우리 네이티브 리스너는 **`document`**(한 단계 위) capture에서 더 먼저 실행 → 호스트 bubble dismiss를 막으면서 React click(별도 이벤트, body에서 위임)은 온전. → **React `onPointerDownCapture` 합성 핸들러는 채택하지 않음** — 합성 `stopPropagation`은 호스트의 *네이티브* document 리스너를 못 막는다.
- **`stopPropagation`(immediate 아님):** 동일 타깃·동일 페이즈의 형제 리스너는 못 막지만(그건 (ii) 케이스), bubble 페이즈 도달 자체를 막아 호스트 bubble dismiss를 차단한다.

## 3. 스코프 보정 — `.bugzar-root`가 아니라 `.bugzar-fab, .bugzar-pill` (CRITICAL)

> 이슈 본문은 "타깃이 `.bugzar-root` 내부면"이라고 했으나 **그대로 구현하면 안 된다.**

`ReviewDrawer`(`ReviewDrawer/index.tsx:121`)도 `className="bugzar-root …"`로 렌더되고 내부에 Jira 폼 `<input>`(`DrawerForm.tsx:74`)·`<textarea>`(`:87`)·EpicCombobox를 가진다. `.bugzar-root` 매칭 + `mousedown.preventDefault()`는 **드로어 입력의 포커스/캐럿/텍스트선택을 깨뜨린다**(헤드라인 기능인 Jira 티켓 작성이 망가짐). 툴바와 드로어는 동시 렌더되지 않지만(`index.tsx:297` vs `:318`), 글로벌 리스너는 항상 살아있어 드로어 입력도 삼킨다.

→ 가드를 **`.bugzar-fab, .bugzar-pill`**(툴바 컨트롤, `styles.ts:49`)로 좁힌다. 이 두 클래스는 `Toolbar.tsx`에만 존재(드로어는 `.bugzar-drawer`·`.bugzar-input`·`.bugzar-textarea`)하므로 드로어 폼은 구조적으로 영향받지 않는다. 픽 오버레이(`.bugzar-pick-root`)도 다른 클래스라 비매칭.

## 4. 터치 안전 — pointerdown/mousedown 역할 분리 (MED-HIGH)

`pointerdown.preventDefault()`는 터치에서 활성화 `click`을 삼킬 수 있다(compatibility mouse-event 생성 opt-out). FAB 활성화는 그 click에 의존하므로 치명적. → **pointerdown은 `stopPropagation`만**(전파 차단), **mousedown은 `stopPropagation`+`preventDefault`**(focus-steal 차단; mousedown은 마우스 전용이라 터치 click 억제 무관). 역할이 다르므로 둘 다 등록한다(중복 아님).

## 5. (i)이 푸는 것 / 못 푸는 것 (QA·UX 리뷰)

| 컴포넌트 | dismiss 방식 | (i) 효과 |
|---|---|---|
| Modal / Dialog | 백드롭 outside-click (focus-trap, blur로는 안 닫힘) | **최적** — 스냅샷 열린 상태 ✅ (단, 모달 focus-trap이 노트 textarea 포커스를 뺏을 수 있음) |
| SideSheet / Drawer | outside-click | Modal과 동일 |
| Select / Listbox | outside-click **+ focus-trap/blur** | 스냅샷 ✅ / **라이브 멀티픽 ✗** — `note.focus()`(`picker.ts:235`)가 blur-dismiss 유발 |
| Tooltip / hover-Popover | **mouseleave/blur** (outside-click 아님) | **거의 무효** — 커서가 FAB로 가는 순간 이미 닫힘 |

핵심: **(i)은 "스냅샷이 열린 상태를 캡처"를 보장한다.** 픽 모드는 라이브 DOM에서 돌고, 첫 픽의 `note.focus()`가 blur-dismiss 컴포넌트(Select)를 닫으면 라이브 아웃라인 위치가 어긋나고 2번째 옵션을 픽할 수 없다. 이 라이브 멀티픽·툴팁·focus-trap 케이스가 백스톱 (ii)(동결 오버레이 위 주석)의 몫이다.

## 6. 알려진 한계 (문서화 필수)

1. **(i)은 스냅샷의 열린 상태 캡처만 보장.** blur/focus로 닫히는 컴포넌트(Select 등)의 **라이브 다중요소 픽은 미지원** — 한 요소 주석 후 필요 시 컴포넌트를 다시 열어야 함. (→ (ii) 필요)
2. **Tooltip(hover/blur dismiss)은 (i)으로 해결 안 됨** — FAB로 커서 이동 시 이미 사라짐. (→ (ii) 또는 hover-hold)
3. **Modal/SideSheet focus-trap이 노트 textarea의 포커스를 뺏을 수 있음** — 노트 입력이 까다로울 수 있음(known rough edge).
4. **호스트가 document *capture-phase* 또는 vanilla 동기 DOM 제거로 dismiss하면 (i)이 못 막음**(`stopPropagation`이 동일-페이즈 형제를 못 막음). (→ (ii))
5. **rrweb-snapshot 픽셀 충실도:** 리포트는 직렬화된 DOM 재구성이라 shadow DOM·canvas·`::backdrop`·`:hover`/`:focus-visible` 라이브 상태·전환 중 위치가 1:1 재현 안 될 수 있음.

## 7. 범위 밖 (→ 후속, #21 open 유지)

- **(ii) 동결 오버레이 백스톱**: 같은 pointerdown에서 동기 rrweb 스냅샷 → 동결본 위에서 픽. picker가 라이브 DOM(`getBoundingClientRect`, `note.focus`)에 의존하므로 picker 재작업 필요 → 별도 슬라이스.
- 픽셀 정확이 필요한 케이스의 `getDisplayMedia`/브라우저 확장 옵션.
- 키보드 단축키 진입(이슈에서 배제).

## 8. 변경 지점

- `packages/sdk/src/Bugzar/index.tsx` — mount `useEffect` 추가(§2). `startPick`·`captureSnapshot`·portal 렌더는 불변.
- `packages/sdk/src/__tests__/pick-open-component.test.tsx` — 신규 테스트(§9).
- (문서) README/JSDoc에 §6 한계 명시.

코드 변경은 단일 `useEffect` 추가뿐(프롭/시그니처/기존 동작 불변).

## 9. 탈출 조건 (Exit Conditions)

빌드/품질:
- [ ] `pnpm -F @bugzar/sdk typecheck` 그린
- [ ] `pnpm -F @bugzar/sdk test` 그린(신규 포함, 309+ 기존 회귀 없음)
- [ ] `pnpm check`(biome) 그린

테스트 계약(`pick-open-component.test.tsx`) — **(i) 미구현 시 red → 구현 후 green**:
- [ ] **[전파/주력]** Design FAB에서 bubbling `pointerdown` dispatch 시, document **bubble** 리스너(호스트 outside-click 시뮬)가 **호출 안 됨**(capture stopPropagation)
- [ ] **[열림 유지/사용자 시나리오]** "fake Select"(document bubble pointerdown으로 outside면 드롭다운 제거)를 연 뒤 FAB 누름 → 드롭다운 **그대로 존재**
- [ ] **[focus-steal]** FAB `mousedown` → `defaultPrevented === true` + bubble mousedown 리스너 미호출
- [ ] **[터치 안전/회귀핀]** FAB `pointerdown` → `defaultPrevented === false`(pointerdown엔 preventDefault 안 함)
- [ ] **[드로어 보호/회귀핀]** `.bugzar-root > .bugzar-input`에서 `mousedown` → `defaultPrevented === false`(가드가 비-FAB `.bugzar-root` 미터치)
- [ ] **[스코프/회귀핀]** 일반 페이지 요소 `pointerdown` → bubble 리스너 **호출됨** + `defaultPrevented === false`
- [ ] **[활성화 불변/회귀핀]** Design FAB `click` → 픽 모드 진입(`.bugzar-pick-root` 마운트) — 가드가 click 활성화를 깨지 않음
- [ ] **[정리/회귀핀]** unmount 후 FAB `pointerdown` → 가드 미작동(리스너 해제됨)

수동/프로토타입(happy-dom 미모델 — DOM 리뷰 주의):
- [ ] 실제 Select(Radix 등)·Modal을 연 채 FAB 클릭 → 컴포넌트 유지 + 리포트 스냅샷에 열린 상태 포함
- [ ] 드로어 폼(제목/노트 입력) 포커스·타이핑 정상(회귀 없음)
