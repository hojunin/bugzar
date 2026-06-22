# Bugzar 백엔드 마이그레이션: qar-backend → bugzar-backend

- 날짜: 2026-06-22
- 상태: 승인됨 (실행 중)

## 배경

제품이 QA Recorder → Bugzar로 리브랜딩됨 (커밋 `3682f96`). 코드·UI·문서·패키지명은
모두 `bugzar`로 전환됐으나, Cloudflare 인프라는 여전히 옛 이름(`qar-backend` worker +
`qar-artifacts` R2 버킷)으로 운영 중. `wrangler.toml`은 이미 `bugzar-backend` /
`bugzar-artifacts`를 가리키지만 해당 리소스는 계정에 미존재.

## 결정 (사용자 확정)

- **완전 리브랜딩**: 새 `bugzar-backend` worker + `bugzar-artifacts` R2 버킷 신규 생성.
- **빈 시작**: 과거 R2 데이터 이전 안 함.
- **옛 리소스 유지**: `qar-backend` / `qar-artifacts`는 당분간 살려둠 → 과거 replay/Jira
  링크 계속 서빙, 옛 retention cron이 자기 버킷 정리. 추후 정리.

## 조사로 확정된 전제

- 운영 worker `qar-backend`에 **secret 0개** → 익명 모드(업로드 + replay + Workers AI
  draft + retention cron만 동작). Jira 실연동/worker-side OAuth/admin 삭제는 inert.
  → 새 worker에 재설정할 secret 없음. OAuth redirect 재설정 불필요.
- SDK는 `endpoint` 주입식 → SDK 코드 변경 없음. 영향받는 건 catalog(파일럿) 앱 설정뿐.
- 운영 cron `0 2 * * *`(11:00 KST)이 `qar-backend`에 등록되어 동작 중.
- 마지막 운영 배포: 2026-06-22 18:13 KST (리브랜딩 커밋 20:10 이전).

## 실행 단계 (🤖 내가 실행)

1. R2 버킷 생성: `bugzar-artifacts`, `bugzar-artifacts-preview`
2. 배포: `pnpm --filter @bugzar/backend run deploy` (viewer 번들 + worker + cron 등록)
3. 검증: 진단 엔드포인트(aiMode 등), cron schedules API, 익명 업로드→replay 스모크
4. 새 URL(`https://bugzar-backend.<subdomain>.workers.dev`) 확보 후 전달

## 컷오버 (🧑 사용자 수동, 레포 밖)

- catalog 파일럿 앱의 `endpoint`를 새 worker URL로 변경 → 재배포.

## 무중단 · 롤백

- 새 worker는 별도 URL, 옛 worker 유지 → 컷오버 전까지 기존 동작 그대로.
- 롤백: catalog `endpoint`를 옛 URL로 되돌리면 즉시 복구.
