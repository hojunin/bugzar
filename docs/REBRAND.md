# Rebrand: QA Recorder → **Bugzar**

> **목적**: 이 저장소의 모든 식별자를 `QA Recorder` / `@qar` / `qar-*` → **Bugzar** / `@bugzar` / `bugzar-*` 로 전환.
> **실행 방식**: `/goal` 로 마일스톤(M1–M5)을 순서대로 실행. 각 마일스톤은 **기계 검증 가능한 탈출조건**을 가지며, 조건이 만족될 때까지 루프한다.
> **범위**: 사용자가 "전체 리브랜드" 선택 — 내부 CSS 접두사까지 포함.

---

## 0. 파라미터 (single source of truth)

치환은 아래 매핑을 따른다. 좌측이 1건도 남지 않으면 해당 묶음 완료.

| 종류 | OLD | NEW |
|---|---|---|
| 표시 이름 | `QA Recorder` | `Bugzar` |
| npm 스코프 | `@qar/` | `@bugzar/` |
| 패키지 5종 | `@qar/{backend,sdk,capture-core,shared,viewer}` | `@bugzar/{...}` |
| Worker 이름 | `qar-backend` / `qar-backend-preview` / `qar-backend-local` | `bugzar-backend` / `-preview` / `-local` |
| R2 버킷 | `qar-artifacts` / `qar-artifacts-preview` | `bugzar-artifacts` / `-preview` |
| Analytics dataset | `qa_recorder` / `qa_recorder_preview` | `bugzar` / `bugzar_preview` |
| Analytics binding | `QA_RECORDER` | `BUGZAR_ANALYTICS` |
| Style 엘리먼트 id | `qar-recorder-styles` | `bugzar-styles` |
| CSS 클래스 접두사 | `qar-` (예: `.qar-root`) | `bugzar-` |
| CSS 변수 접두사 | `--qar-*` | `--bugzar-*` |
| postMessage source | `qar-oauth` | `bugzar-oauth` |
| export HTML id | `qar-data` | `bugzar-data` |
| testid | `qar-capture-summary` | `bugzar-capture-summary` |
| repo slug | `qa-plugin` | `bugzar` |
| repo owner/slug | `hojunin/qa-plugin` | `${GH_OWNER}/bugzar` |

**실행자가 시작 전 확정할 변수**

- `GH_OWNER` = (`bugzar` org 또는 `hojunin`) — repo URL 치환에 사용. 미정이면 `bugzar` 로 둔다.
- R2 바인딩 이름 `ARTIFACTS`, AI 바인딩 `AI` 는 **코드 내부 식별자라 변경하지 않는다** (브랜드와 무관).

---

## 1. 사전 조건 (수동 — `/goal` 대상 아님)

`/goal` 은 코드만 바꾼다. 아래는 사람이 먼저 처리한다.

- [ ] `npm view bugzar` 와 `npm view @bugzar/sdk` 로 스코프 가용성 확인. **선점돼 있으면 중단**하고 스코프 재선정.
- [ ] 작업 브랜치 생성: `git switch main && git switch -c chore/rebrand-bugzar`
- [ ] (배포 전) GitHub org/repo `bugzar`, 도메인 `bugzar.dev` 확보 — M6에서 사용.

### ⛔ STOP 조건 (실행 중 하나라도 참이면 멈추고 사람에게 보고)

1. **운영 R2 데이터 보존 필요** — `qar-artifacts` 에 살아있는 `/r/<id>` 리플레이가 있고 보존해야 함 → M3 진입 전 [부록 A] 마이그레이션 먼저.
2. `npm view bugzar` 결과 스코프가 이미 점유됨.
3. 마스터 가드(아래)가 치환 의도와 무관한 오탐을 낼 때(예: 의존성 이름에 우연히 `qar` 포함) → 가드 `PATTERN` 예외 추가 후 진행.

---

## 2. Definition of Done (전체 탈출조건)

모든 마일스톤 종료 시 아래가 **전부** 참이어야 한다.

```bash
# (1) 레거시 브랜드 토큰 0건  ── 핵심 탈출조건
bash scripts/rebrand-guard.sh        # exit 0

# (2) 정적 검사 / 타입 / 테스트 / 빌드 전부 통과
pnpm check                            # Biome, exit 0
pnpm -r typecheck                     # exit 0
pnpm test                             # 전 패키지 green (backend 111 등 — 개수 회귀 없음)
pnpm -r build                         # exit 0
```

### 테스트 코드: `scripts/rebrand-guard.sh` (없으면 M1에서 생성)

```bash
#!/usr/bin/env bash
# 레거시 브랜드 토큰이 1건이라도 남으면 exit 1. 전부 사라지면 exit 0.
set -uo pipefail
cd "$(dirname "$0")/.."
EXCLUDES=(
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
  --exclude-dir=coverage --exclude-dir=public --exclude-dir=.wrangler
  --exclude-dir=test-results --exclude-dir=playwright-report
  --exclude=pnpm-lock.yaml --exclude=REBRAND.md
)
# qar* , qa-recorder / qa_recorder / "qa recorder"(=QA Recorder) , qa-plugin  (대소문자 무시)
PATTERN='qar|qa[-_ ]recorder|qa-plugin'
hits="$(grep -rnIiE "$PATTERN" "${EXCLUDES[@]}" . 2>/dev/null)"
if [ -n "$hits" ]; then
  echo "❌ 레거시 토큰 잔존:"; echo "$hits"; exit 1
fi
echo "✅ 레거시 브랜드 토큰 없음"; exit 0
```

> 생성 후 `chmod +x scripts/rebrand-guard.sh`.
> 마일스톤별 부분 가드는 `PATTERN` 만 바꿔 같은 방식으로 검사한다(아래 각 M의 "탈출조건" 참고).

---

## 3. 마일스톤 (`/goal` 으로 순서 실행)

> 권장: 마일스톤 하나씩 별도 `/goal` 로 실행. 각 M의 **탈출조건** 블록이 그대로 goal 의 success criteria.
> M1→M2→M3 까지는 한 PR(되돌리기 쉬움). M3는 인프라 영향 → 리뷰 후 진행. M4는 단독 PR 권장.

### M1 — npm 스코프 `@qar` → `@bugzar`

**대상**: 워크스페이스 5개 패키지명, 모든 `import ... from '@qar/...'`(67 파일), `pnpm-workspace.yaml`, `tsconfig.base.json` paths, 루트 `package.json` 의 `--filter @qar/*` 스크립트.

**작업**
1. `scripts/rebrand-guard.sh` 가 없으면 위 내용으로 생성.
2. 5개 `packages/*/package.json` 의 `"name"` 치환.
3. 전 소스의 `@qar/` → `@bugzar/` 치환.
4. `pnpm install` (lockfile 갱신).

**탈출조건**
```bash
# @qar 참조 0건
! grep -rnIE '@qar/' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist .
pnpm -r typecheck            # exit 0
pnpm install --frozen-lockfile=false >/dev/null && echo OK   # 설치 성공
```

**롤백**: `git restore -SW :/ && pnpm install` (브랜치 내).

---

### M2 — 브랜드 텍스트 & repo URL

**대상**
- Worker 생성 HTML 타이틀: `packages/backend/src/worker.ts` 4곳(인덱스/삭제/리플레이/OAuth).
- 문서: `README.md`, `docs/**`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, 각 패키지 `README.md`.
- repo URL `hojunin/qa-plugin` 7곳: README 배포버튼·clone, `scripts/setup-backend.sh`, `packages/sdk/package.json`(repository/homepage/bugs).
- `packages/sdk/package.json` description/author/keywords.

**탈출조건**
```bash
# 표시 이름 / repo slug 잔존 0건 (CSS·infra 토큰은 M3·M4에서 처리하므로 여기선 제외)
! grep -rnIiE 'qa[- ]recorder|qa-plugin' \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude=pnpm-lock.yaml --exclude=REBRAND.md .
pnpm -r typecheck            # exit 0
```
> 주의: `qa-recorder`/`qa_recorder` 중 **IDB·analytics 식별자**는 M3 소관. 위 패턴은 `qa recorder`(표시명)·`qa-plugin`만 잡는다. M3 이후 마스터 가드로 최종 확인.

**롤백**: `git restore` (브랜치 내).

---

### M3 — 인프라 식별자 ⚠️ (배포 영향)

> **선행**: [STOP 조건 1] 확인. 보존할 R2 데이터 있으면 [부록 A] 먼저.

**대상**
- `packages/backend/wrangler.toml` + `wrangler.local.jsonc`: `name`(prod/preview/local), `bucket_name`·`preview_bucket_name`(`qar-artifacts*`), analytics `dataset`(`qa_recorder*`), binding `QA_RECORDER`→`BUGZAR_ANALYTICS`.
- 코드 내 binding 참조: `packages/backend/src/worker.ts` 의 `env.QA_RECORDER` → `env.BUGZAR_ANALYTICS` (+ 타입 정의).
- 스크립트: `r2:create`(`packages/backend/package.json`), `scripts/delete-report.mjs`, `scripts/setup-backend.sh`, `.github/workflows/**`(preview 버킷/Worker 명).
- Jira label: `packages/backend/src/worker.ts` 의 `labels: ['qa-recorder']` 2곳 → `'bugzar'`, 동반 테스트 `packages/backend/src/m4-publish.test.ts` 의 assert.

**탈출조건**
```bash
# 인프라 토큰 0건
! grep -rnIiE 'qar-backend|qar-artifacts|qa_recorder|QA_RECORDER' \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude=pnpm-lock.yaml --exclude=REBRAND.md .
! grep -rnIE "'qa-recorder'|\"qa-recorder\"" packages/backend/src
# wrangler 설정이 파싱·번들되는지 (실제 배포·버킷 생성 X)
pnpm --filter @bugzar/backend exec wrangler deploy --dry-run --outdir .wrangler/dry 2>&1 | grep -qiE 'Total Upload|dry' && echo OK
pnpm --filter @bugzar/backend test     # backend vitest green (111 회귀 없음)
```

**롤백**: 코드는 `git restore`. **실제 CF 리소스는 M6에서만 생성**하므로 이 단계 롤백은 코드 한정.

---

### M4 — 내부 식별자 / CSS 접두사 (단독 PR 권장)

**대상** (외부 비노출, 순수 churn — SDK ~1033, backend 36, viewer 3)
- CSS 클래스 `qar-*` → `bugzar-*` : `packages/sdk/src/styles.ts` 의 CSS 문자열 전체, 전 컴포넌트의 `className="qar-..."`.
- CSS 변수 `--qar-*` → `--bugzar-*`.
- `STYLE_ID = 'qar-recorder-styles'` → `'bugzar-styles'`.
- `qar-oauth`(`packages/sdk/src/oauth/atlassian.ts` postMessage source — **양쪽 동시** 치환).
- `qar-data`(`packages/sdk/src/export.ts` + viewer 파서 — **양쪽 동시**).
- `qar-capture-summary` 등 testid.
- **동반 테스트 수정**: `sdk/__tests__/{styles,review-drawer,picker,QARecorder,export}.test.*`, `backend/src/*.test.ts` 등 `qar-` 를 assert 하는 테스트 파일.

**탈출조건**
```bash
bash scripts/rebrand-guard.sh          # ✅ (이 시점부터 마스터 가드 0건이어야 함)
pnpm --filter @bugzar/sdk test         # green
pnpm --filter @bugzar/viewer test      # green
```

**롤백**: 단독 PR이므로 PR revert 로 분리 폐기 가능.

---

### M5 — 통합 검증 (게이트)

**탈출조건 = Definition of Done 전체**
```bash
bash scripts/rebrand-guard.sh   # exit 0
pnpm check                      # exit 0
pnpm -r typecheck               # exit 0
pnpm test                       # 전 패키지 green, 테스트 개수 회귀 없음
pnpm -r build                   # exit 0
```
하나라도 실패하면 해당 M으로 되돌아가 수정 후 재검증(루프).

---

## 4. M6 — 저장소·배포·퍼블리시 (수동, `/goal` 이후)

`/goal` 로 자동화하지 않는다(외부 시스템·비가역).

- [ ] GitHub repo rename `qa-plugin` → `bugzar`, `git remote set-url origin …/${GH_OWNER}/bugzar.git`.
- [ ] R2 버킷 생성: `wrangler r2 bucket create bugzar-artifacts` (+ `-preview`). 보존 데이터 있으면 [부록 A].
- [ ] `pnpm --filter @bugzar/backend run deploy` → 출력된 새 `bugzar-backend.<sub>.workers.dev` 스모크 테스트(인덱스 / `/r/<id>` / Jira 발행 1건).
- [ ] (선택) 구 `qar-backend` Worker 를 새 URL 로 redirect 유지.
- [ ] `npm publish` → `@bugzar/sdk`; 구 `@qar/sdk` 는 `npm deprecate @qar/sdk "renamed to @bugzar/sdk"`.
- [ ] **로컬 디렉터리** `qa-recorder` → `bugzar` 는 세션 cwd 가 깨지므로 **맨 마지막에 셸에서 수동**.

---

## 부록 A — R2 데이터 마이그레이션 (보존 필요 시에만)

기존 `/r/<id>` 리플레이를 유지해야 하면 버킷 rename 전에:

```bash
# 구→신 버킷으로 객체 복사 (rclone 또는 aws s3 + R2 S3 호환 엔드포인트)
rclone copy r2:qar-artifacts r2:bugzar-artifacts --progress
```
또는 구 버킷·구 Worker 를 그대로 두고 신규만 `bugzar-*` 로 운영(이중 운영). 결정 전에는 M3의 `bucket_name` 변경을 보류한다.

---

## 부록 B — 변경 규모 (참고)

| 묶음 | 대략 건수 | 성격 | 비가역도 |
|---|---|---|---|
| M1 스코프 | 67 파일 | 기계적 | 낮음 |
| M2 브랜드/URL | ~110 | 판단+기계 | 낮음 |
| M3 인프라 | ~92 + CF 리소스 | 판단 | **높음(배포)** |
| M4 CSS/내부 | ~1070 + 테스트 | 기계적·고churn | 낮음(무영향) |
