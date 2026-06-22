#!/usr/bin/env bash
# rebrand-apply.sh — mechanical QA Recorder -> Bugzar rebrand (docs/REBRAND.md).
# Idempotent-ish: safe to re-run; runs ordered, fixed-string replacements then file renames.
# Does NOT touch generated artifacts (dist/, public/, *.tgz, .wrangler/, release/), the lockfile,
# the plan doc, or these scripts. Run `scripts/rebrand-guard.sh` afterwards to verify.
#
# Tunables (override via env):
#   GH_OWNER   GitHub owner for the new repo URL (default: bugzar)  e.g. GH_OWNER=hojunin
set -euo pipefail
cd "$(dirname "$0")/.."

GH_OWNER="${GH_OWNER:-bugzar}"

# --- portable in-place sed (GNU vs BSD/macOS) -------------------------------
if sed --version >/dev/null 2>&1; then SED_I=(sed -i); else SED_I=(sed -i ''); fi

EXCLUDES=(
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
  --exclude-dir=dist-inline --exclude-dir=coverage --exclude-dir=public
  --exclude-dir=.wrangler --exclude-dir=release
  --exclude-dir=test-results --exclude-dir=playwright-report
  --exclude=pnpm-lock.yaml --exclude=REBRAND.md
  --exclude=rebrand-apply.sh --exclude=rebrand-guard.sh
  --exclude=*.tgz
)

# All text files that mention any legacy token (union pattern). Built once.
FILES="$(grep -rlIiE 'qar|qa[-_ ]recorder|qa-plugin' "${EXCLUDES[@]}" . 2>/dev/null || true)"
[ -z "$FILES" ] && { echo "nothing to rebrand"; exit 0; }

# sub OLD NEW  — fixed-string replace across FILES (| delimiter; tokens have no |)
sub() {
  local old="$1" new="$2" f
  printf '%s\n' "$FILES" | while IFS= read -r f; do
    [ -f "$f" ] && "${SED_I[@]}" "s|$old|$new|g" "$f"
  done
}
# rsub OLD NEW — regex replace (for camelCase / bracket classes)
rsub() {
  local old="$1" new="$2" f
  printf '%s\n' "$FILES" | while IFS= read -r f; do
    [ -f "$f" ] && "${SED_I[@]}" "s|$old|$new|g" "$f"
  done
}

# === ORDER MATTERS: most specific first ====================================
sub  'qar-recorder-styles'        'bugzar-styles'          # STYLE_ID (before qar-)
sub  'QARecorder'                 'Bugzar'                 # component+hook+types+imports (before any QAR/qar generic)
sub  'use-qa-recorder'            'use-bugzar'             # hook file refs (before qa-recorder)
sub  "hojunin/qa-plugin"     "${GH_OWNER}/bugzar"     # repo URL owner (before qa-plugin)
sub  '@qar/'                      '@bugzar/'               # npm scope
sub  'qarv-'                      'bugzarv-'               # viewer CSS prefix (before qar-)
sub  'qar-'                       'bugzar-'                # SDK CSS, qar-backend, qar-artifacts, qar-oauth, qar-data, --qar-
rsub 'qar\([A-Z]\)'              'bugzar\1'               # camelCase storage keys: qarAtlassianTokens -> bugzar...
rsub '\[qar\]'                    '[bugzar]'               # log tags
sub  'QA Recorder'                'Bugzar'                 # display name
sub  'QA_RECORDER'                'BUGZAR_ANALYTICS'       # analytics binding (uppercase, before qa_recorder)
sub  'qa_recorder'                'bugzar'                 # analytics dataset (qa_recorder_preview -> bugzar_preview)
sub  'QAR'                        'BUGZAR'                 # __QAR_REPORT__, *_QAR_ENDPOINT, QAR_ADMIN_SECRET, 'QAR' jira key
sub  'Qar'                        'Bugzar'                 # PascalCase internal types (QarXHR)
sub  'QA recorder'                'Bugzar'                 # prose 'QA recorder' (lowercase r)
sub  'qa-recorder'                'bugzar'                 # IDB name, root package name, docs
sub  'qa-plugin'                  'bugzar'                 # any remaining repo slug
rsub 'qar'                        'bugzar'                 # lowercase leftovers (comments/strings)

# === file renames (content already fixed above) ============================
mvf() { [ -f "$1" ] && { git mv "$1" "$2" 2>/dev/null || mv "$1" "$2"; echo "renamed $1 -> $2"; }; }
mvf packages/sdk/src/QARecorder.tsx                 packages/sdk/src/Bugzar.tsx
mvf packages/sdk/src/__tests__/QARecorder.test.tsx  packages/sdk/src/__tests__/Bugzar.test.tsx
mvf packages/sdk/src/use-qa-recorder.ts             packages/sdk/src/use-bugzar.ts
mvf packages/sdk/src/__tests__/use-qa-recorder.test.tsx packages/sdk/src/__tests__/use-bugzar.test.tsx

echo "done. now run: pnpm install && bash scripts/rebrand-guard.sh && pnpm -r typecheck && pnpm test"
