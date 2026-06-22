#!/usr/bin/env bash
#
# One-shot Bugzar backend deploy.
#
#   git clone https://github.com/hojunin/bugzar && cd bugzar
#   pnpm run deploy:backend
#
# Does everything a self-hoster needs: installs deps, logs into Cloudflare,
# creates the R2 bucket, builds the viewer, and deploys the Worker. Prints the
# resulting URL to use as the SDK `endpoint`. Workers AI + Analytics Engine need
# no extra setup; Jira is optional (printed at the end).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/packages/backend"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

say "1/4  의존성 설치 (pnpm install)…"
(cd "$REPO_ROOT" && pnpm install)

say "2/4  Cloudflare 로그인 확인…"
if ! (cd "$BACKEND_DIR" && pnpm exec wrangler whoami >/dev/null 2>&1); then
  echo "   로그인이 필요합니다 — 브라우저가 열립니다."
  (cd "$BACKEND_DIR" && pnpm exec wrangler login)
fi

say "3/4  R2 버킷 생성 (이미 있으면 통과)…"
if ! (cd "$BACKEND_DIR" && pnpm exec wrangler r2 bucket create bugzar-artifacts 2>/dev/null); then
  echo "   (이미 존재하거나, R2가 비활성이면 대시보드에서 R2를 한 번 활성화하세요)"
fi

say "4/4  뷰어 빌드 + Worker 배포…"
(cd "$BACKEND_DIR" && pnpm run deploy)

cat <<'DONE'

✅ 끝났습니다.
   위 출력의  https://bugzar-backend.<your-subdomain>.workers.dev  가 백엔드 주소입니다.
   SDK 에 그대로 넣으세요:

     <Bugzar endpoint="https://bugzar-backend.<your-subdomain>.workers.dev" />

ℹ️  (선택) Jira 발행까지 쓰려면 — Atlassian OAuth 앱을 만든 뒤:
     cd packages/backend
     pnpm exec wrangler secret put ATLASSIAN_CLIENT_ID
     pnpm exec wrangler secret put ATLASSIAN_CLIENT_SECRET
   그리고 Atlassian 앱의 redirect URI 로  <위 endpoint>/oauth/callback  를 등록,
   <Bugzar> 에  jira={{ clientId: '<client id>', projectKey: 'XXX' }}  추가.
DONE
