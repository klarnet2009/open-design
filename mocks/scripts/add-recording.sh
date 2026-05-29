#!/usr/bin/env bash
# Stage a new recording for inclusion in the mocks corpus.
#
# This script does NOT touch R2. It just:
#   1. Validates the recording's structure (meta event, trace id format)
#   2. Copies it into mocks/recordings-staging/<trace-id>.jsonl
#   3. Previews the manifest entry the GitHub Action will commit
#      post-merge (so a reviewer can eyeball the metadata before approving)
#
# The actual R2 upload + manifest update happens in CI via
# `.github/workflows/sync-mocks-to-r2.yml` after merge to main.
#
# Usage:
#   bash mocks/scripts/add-recording.sh <recording.jsonl>
#   bash mocks/scripts/add-recording.sh <recording.jsonl> --no-preview
#
# Recommended workflow:
#   1. anonymize your raw recording (see anonymizer in
#      nexu-io/agent-pr-explore: cli/src/local/mock-agent/anonymize.ts)
#   2. run this script
#   3. git add mocks/recordings-staging/ && git commit -m "mocks: add <trace-id>"
#   4. open a PR; reviewer eyeballs anonymization in the .jsonl diff
#   5. merge → workflow auto-uploads to R2 + updates manifest + commits back

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MOCKS_DIR="$(cd "$HERE/.." && pwd -P)"
STAGING_DIR="$MOCKS_DIR/recordings-staging"
MANIFEST="$MOCKS_DIR/manifest.json"

PREVIEW=1
INPUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-preview) PREVIEW=0; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# //; s/^#//'; exit 0 ;;
    *)
      if [ -z "$INPUT" ]; then INPUT="$1"; shift
      else echo "unexpected arg: $1" >&2; exit 2
      fi
      ;;
  esac
done

if [ -z "$INPUT" ]; then echo "usage: $0 <recording.jsonl>" >&2; exit 2; fi
if [ ! -f "$INPUT" ]; then echo "no such file: $INPUT" >&2; exit 1; fi

TRACE_ID="$(basename "$INPUT" .jsonl)"

# Trace ids in our corpus are UUIDs (anonymizer keeps them — they're
# Langfuse trace ids, not personal data). Reject anything else so a
# typo'd filename doesn't slip through.
if ! printf '%s' "$TRACE_ID" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  echo "✗ trace id '$TRACE_ID' is not a UUID. Rename the file." >&2
  exit 1
fi

# Validate + compute the entry preview via shared lib.
# Resolve to absolute paths so this works no matter where the user cd'd.
LIB_PATH="$HERE/lib/manifest-utils.mjs"
INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd -P)/$(basename "$INPUT")"
ENTRY_JSON=$(node --input-type=module -e "
import { inspectRecording } from '$LIB_PATH';
process.stdout.write(JSON.stringify(inspectRecording('$INPUT_ABS'), null, 2));
" 2>&1) || {
  echo "✗ recording validation failed:" >&2
  echo "$ENTRY_JSON" | sed 's/^/  /' >&2
  exit 1
}

mkdir -p "$STAGING_DIR"
DEST="$STAGING_DIR/$TRACE_ID.jsonl"
if [ -f "$DEST" ]; then
  echo "⚠ overwriting existing staging file: $DEST"
fi
cp "$INPUT" "$DEST"
echo "✓ staged: $DEST"

if [ "$PREVIEW" -eq 1 ]; then
  echo
  echo "manifest entry the CI workflow will commit:"
  echo "$ENTRY_JSON" | sed 's/^/  /'
  echo
  echo "next steps:"
  echo "  git add $DEST"
  echo "  git commit -m \"mocks: add recording $TRACE_ID\""
  echo "  gh pr create  # or push and open via web"
fi
