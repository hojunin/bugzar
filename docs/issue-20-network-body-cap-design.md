# 이슈 #20 — 네트워크 바디 truncation 한도 상향 (safe 버전) 설계

> 상태: 3인 교차 리뷰 수렴(backend/infra · capture/perf · product/DX, 전원 GO-WITH-CHANGES) + 사용자 "safe 버전" 승인. 테스트 작성 후 `/goal` 대기.

## 1. 문제

네트워크 **응답** 바디가 100KB(100,000 **chars**) 초과 시 캡처 시점에 `…[truncated]`로 잘림(`network-patch.ts:106,228`). 소급 복구 불가 → 큰 200 OK 바디(커머스 item 목록 JSON)가 잘린 채로만 남아 디버깅 데이터가 빔.

## 2. 왜 "상수 bump"만으론 안 되나 (리뷰 핵심)

per-body cap만 100KB→1MB로 올리면 **더 위험**해진다:

- **탭 OOM (capture/perf F1, HIGH):** `networkEntries`는 단일 인메모리 배열(`recorder.ts:89,115`), 증분 flush·total cap **전혀 없음** — 세션 내내 힙에 유지. per-body 10×면 긴 SPA 세션이 힙 OOM → **조용한 전체 손실**(413보다 나쁨).
- **413 세션 통째 손실 (backend F4):** per-body+asset cap은 **총량을 안 묶음**. 100+ 큰 응답이면 asset cap 초과 → 413 → 그 세션 네트워크 **전부** 유실(초과분만 아님).
- **char vs byte (backend F1 · capture F2, HIGH):** per-body는 `text.length`(UTF-16 char), backend asset cap은 `chunk.byteLength`(UTF-8 byte). **韓/CJK는 1 char ≈ 2-3 byte** → "1MB×50=50MB"가 실제론 "~3MB×16". 헤드룸 과대평가.

→ 안전한 fix = **byte 기반 per-body cap + 클라이언트 total budget + surgical backend cap**, 세 값을 **단일 출처(@bugzar/shared)**로 묶어 CI 단언.

## 3. 확정 값 (3인 수렴)

| 상수 | 값 | 근거 |
|---|---|---|
| `NETWORK_BODY_MAX_BYTES` (per-body) | **1 MB** (1,000,000 byte) | 512KB는 재절단(소급불가), error-only는 200 OK 케이스 놓침 → 둘 다 거부. **byte 기반**(TextEncoder) |
| `NETWORK_TOTAL_BUDGET_BYTES` (클라 세션 총량) | **20 MB** | asset cap 아래. 초과 시 바디만 `…[budget exceeded]`, entry/metadata 보존 → 탭 OOM·413 동시 방지 |
| `NETWORK_ASSET_CAP_BYTES` (backend network asset) | **25 MB** | Worker isolate ~128MB(`arrayBuffer()` 전체 버퍼) + **viewer가 network.json 전체 eager-load**(느린 열람) → 50MB는 viewer lazy-load 후 후속 |

**불변식(CI 단언):** `NETWORK_TOTAL_BUDGET_BYTES + NETWORK_BODY_MAX_BYTES <= NETWORK_ASSET_CAP_BYTES` (클라가 cap보다 더 못 보냄 → 413 불가). 20+1 ≤ 25 ✓.

## 4. 구현

### 4.1 단일 출처 — `@bugzar/shared/src/network-limits.ts` (신규)

세 상수 export. capture-core·backend 모두 import(둘 다 이미 `@bugzar/shared` 사용 — `sanitizeNetworkBody`, jira-draft). 주석으로 char/byte·lockstep 명시.

### 4.2 capture-core `network-patch.ts` — `capBody` 헬퍼로 4개 사이트 통합

기존: 응답만 truncate(char)→sanitize. 요청 바디(`:93,:214`)는 **무제한**(sanitize만).
신규: **요청·응답 4개 사이트 전부** `capBody(text, contentType)` 경유:

```ts
const encoder = new TextEncoder();
let capturedBodyBytes = 0; // 세션 누적. installNetworkPatch에서 0으로 리셋(세션별).

export const capBody = (text: string | null, contentType: string | null): string | null => {
  if (text == null) return null;
  if (capturedBodyBytes >= NETWORK_TOTAL_BUDGET_BYTES) return BUDGET_MARK; // 예산 소진
  const bytes = encoder.encode(text);
  let body = text;
  let truncated = false;
  let kept = bytes.length;
  if (bytes.length > NETWORK_BODY_MAX_BYTES) {
    // byte 경계 슬라이스 → 잘린 trailing codepoint는 fatal:false 디코더가 U+FFFD로, 끝의 U+FFFD 제거
    body = new TextDecoder('utf-8', { fatal: false })
      .decode(bytes.subarray(0, NETWORK_BODY_MAX_BYTES)).replace(/�+$/, '');
    truncated = true;
    kept = NETWORK_BODY_MAX_BYTES; // 예산은 보수적으로 cap만큼 차감
  }
  if (capturedBodyBytes + kept > NETWORK_TOTAL_BUDGET_BYTES) {
    capturedBodyBytes = NETWORK_TOTAL_BUDGET_BYTES;  // 소진 마킹
    return BUDGET_MARK;
  }
  capturedBodyBytes += kept;
  return sanitizeNetworkBody(truncated ? `${body}${TRUNCATED_MARK}` : body, contentType);
};
```

- `installNetworkPatch`: idempotent 가드 뒤에 `capturedBodyBytes = 0`(새 세션 리셋). recorder가 start마다 install/stop마다 uninstall(`recorder.ts:115,155`)이라 세션 격리 정확.
- 호출부 치환: fetch req `:93`, fetch resp `:106-109`, XHR req `:214`, XHR resp `:227-231` → 전부 `capBody(...)`. blob/arraybuffer placeholder(`<blob>` 등)는 그대로(바디 아님).
- **sanitize 순서 보존**: truncate→(budget)→sanitize. 큰 slice일수록 redaction 커버리지 ↑(capture F4: 회귀 없음).
- 테스트 훅: `export const __resetNetworkBudget = () => { capturedBodyBytes = 0; };`

### 4.3 backend `worker.ts` — surgical `network` 엔트리

```ts
const MAX_ASSET_BYTES = {
  default: 10 * 1024 * 1024,
  network: NETWORK_ASSET_CAP_BYTES, // 25MB — only the network asset needs >10MB
  video: 100 * 1024 * 1024,
  screenshot: 5 * 1024 * 1024,
};
```

`assetCap('network')`(`:226-227` `(asset && MAX[asset]) || default`)가 자동 픽업 → `overSizeLimit`·`capBodyStream` 양쪽에 일관 적용. **`default` 불변**(events/console/storage/vitals는 10MB 유지). `assetCap`(또는 MAX_ASSET_BYTES) export해 테스트.

## 5. 비범위 / 후속 (문서화)

- **50MB asset cap** → viewer가 network.json **lazy-load**(현재 eager `res.json()`+inline 렌더) 가능해진 뒤. 별도 이슈.
- **truncation 크기 표기** (`…[truncated — 2.3MB of 8.1MB]`) — 신뢰 향상, 별도 fast-follow.
- **error-only(plan B) 거부** — 200 OK 케이스(이슈의 실제 버그)를 놓침.
- **SDK 설정 옵션**(`maxNetworkBodyKb`) 미도입 — 공용 상수 추출로 후속 1줄화. 프라이버시는 redaction 경로가 이미 담당(Karpathy: no speculative config).
- 비소급: 기존 100KB 리포트 복구 안 됨, 신규 캡처부터.

## 6. 변경 지점

- `packages/shared/src/network-limits.ts` (신규) + `index.ts` re-export
- `packages/capture-core/src/network-patch.ts` — `capBody`/카운터/리셋/4사이트 치환
- `packages/backend/src/worker.ts` — `network` 엔트리 + `assetCap` export

## 7. 탈출 조건 (Exit Conditions)

빌드/품질:
- [ ] `pnpm -r typecheck` (shared·capture-core·backend) 그린
- [ ] `pnpm -r test` 또는 영향 패키지 `vitest run` 전체 그린(회귀 0)
- [ ] `pnpm check`(biome) — 변경 파일 클린

테스트 계약 — 구현 전 red:
- **shared `network-limits.test.ts`:**
  - [ ] 불변식 `TOTAL_BUDGET + BODY_MAX <= ASSET_CAP`
  - [ ] BODY_MAX=1MB, TOTAL=20MB, ASSET=25MB (byte 값 박제)
- **capture-core `network-patch.test.ts`(`capBody` 단위):**
  - [ ] 소형 바디 그대로 통과 + sanitize 호출(redaction 보존)
  - [ ] >1MB **ASCII** 바디 → `…[truncated]` 부착, byte ≤ ~1MB
  - [ ] **byte 기반**: char-length < 1MB but UTF-8 byte > 1MB인 CJK 바디 → 잘림(char 기반이면 안 잘림)
  - [ ] **total budget**: 누적 > 20MB 후 호출 → `…[budget exceeded]`(바디 폐기, 마커 반환)
  - [ ] `__resetNetworkBudget`(또는 install) 후 예산 리셋
  - [ ] 요청 바디도 cap(예산에 합산)
  - [ ] null → null
- **backend `network-asset-cap.test.ts`:**
  - [ ] `assetCap('network') === NETWORK_ASSET_CAP_BYTES`(25MB)
  - [ ] `assetCap('events')`/default === 10MB(불변)
  - [ ] (선택) 10MB<x≤25MB network 업로드 비-413 / >25MB 413 (핸들러 레벨, 가능 시)
