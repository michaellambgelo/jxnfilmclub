#!/usr/bin/env bash
# PostToolUse hook: nudge Claude when edited files map to a documented feature.
# Reads hook JSON from stdin, extracts the file path, checks against the
# file-to-doc mapping, and outputs a nudge if the relevant doc may be stale.

FILE=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0

# Normalize to relative path
REL="${FILE#*/jxnfilmclub/}"

# Map source file patterns to feature doc names
docs_for_file() {
  case "$1" in
    worker/src/index.js)           echo "signup signin member-profile attendance" ;;
    ui/views.html)                 echo "events members-directory watched home attendance" ;;
    ui/auth.html)                  echo "signup signin member-profile attendance" ;;
    ui/widgets.html)               echo "members-directory" ;;
    model/index.ts)                echo "events members-directory" ;;
    scripts/refresh_letterboxd.py) echo "watched" ;;
    scripts/refresh_spotify.py)    echo "home" ;;
    .github/workflows/deploy-*)    echo "deployment" ;;
    .github/workflows/build-*)     echo "deployment" ;;
    .github/workflows/test.yml)    echo "deployment" ;;
    .github/workflows/add-member*) echo "signup" ;;
    .github/workflows/update-member*) echo "member-profile" ;;
    .github/workflows/snapshot-attendance*) echo "attendance" ;;
    .github/workflows/refresh-letterboxd*) echo "watched" ;;
    .github/workflows/refresh-spotify*) echo "home" ;;
    index.html)                    echo "navigation" ;;
    *)                             echo "" ;;
  esac
}

DOCS=$(docs_for_file "$REL")
[ -z "$DOCS" ] && exit 0

STALE=""
for doc in $DOCS; do
  p="docs/features/${doc}.md"
  [ -f "$p" ] && STALE="$STALE $p"
done

[ -z "$STALE" ] && exit 0

cat <<ENDJSON
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Feature docs may be stale after this edit. Review and update if needed:${STALE}"}}
ENDJSON
