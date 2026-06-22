#!/usr/bin/env bash
# rebrand-guard.sh — exit 0 only when no legacy "QA Recorder / qar" brand tokens remain.
# Used as the machine-checkable exit condition for the Bugzar rebrand (docs/REBRAND.md).
set -uo pipefail
cd "$(dirname "$0")/.."

EXCLUDES=(
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
  --exclude-dir=dist-inline --exclude-dir=coverage --exclude-dir=public
  --exclude-dir=.wrangler --exclude-dir=release
  --exclude-dir=test-results --exclude-dir=playwright-report
  --exclude=pnpm-lock.yaml --exclude=REBRAND.md
  --exclude=rebrand-apply.sh --exclude=rebrand-guard.sh
  --exclude=*.tgz
)

# Case-insensitive union catches every shape:
#   qar*  (@qar/, qar-, qarv-, QARecorder, QAR_*, qarCamelKeys, [qar])
#   qa[-_ ]recorder  (QA Recorder, qa-recorder, qa_recorder, QA_RECORDER)
#   qa-plugin
PATTERN='qar|qa[-_ ]recorder|qa-plugin'

hits="$(grep -rnIiE "$PATTERN" "${EXCLUDES[@]}" . 2>/dev/null)"
if [ -n "$hits" ]; then
  echo "❌ legacy brand tokens remain ($(printf '%s\n' "$hits" | wc -l | tr -d ' ') lines):"
  printf '%s\n' "$hits"
  exit 1
fi
echo "✅ no legacy brand tokens"
exit 0
