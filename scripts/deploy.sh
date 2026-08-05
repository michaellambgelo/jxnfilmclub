#!/usr/bin/env bash
# deploy-branch: main
set -euo pipefail

# One push to main drives all three targets via GitHub Actions:
#   site   -> deploy-site.yml   (test-gated)
#   worker -> deploy-worker.yml (path-filtered to worker/**, test-gated)
#   admin  -> deploy-admin.yml  (path-filtered to admin/**)
#
# The snapshot crons bot-commit to main, so the push is preceded by a
# rebase. Path filters mean a push may legitimately not trigger worker/admin
# runs — the router's `gh run watch` would then latch onto the most recent
# (older) run of that workflow; harmless, but read the run's commit line.

TARGET="${DEPLOY_TARGET:-}"

PUSHED=0
push_main() {
  if [[ "$PUSHED" = 1 ]]; then return; fi
  if [[ "${DEPLOY_DRY_RUN:-}" = 1 ]]; then
    echo "would: git pull --rebase origin main && git push origin main"
  else
    git pull --rebase origin main
    git push origin main
  fi
  PUSHED=1
}

run_target() {
  local name="$1" workflow="$2" url="$3"
  echo "::deploy:target=${name}:start"
  push_main
  echo "::deploy:target=${name}:watch=${workflow}"
  echo "::deploy:target=${name}:url=${url}"
  echo "::deploy:target=${name}:end:status=ok"
}

case "$TARGET" in
  '')
    run_target site   deploy-site.yml   https://jxnfilm.club
    run_target worker deploy-worker.yml https://join.jxnfilm.club
    run_target admin  deploy-admin.yml  https://admin.jxnfilm.club
    ;;
  site)   run_target site   deploy-site.yml   https://jxnfilm.club ;;
  worker) run_target worker deploy-worker.yml https://join.jxnfilm.club ;;
  admin)  run_target admin  deploy-admin.yml  https://admin.jxnfilm.club ;;
  *)
    echo "unknown target: ${TARGET} (expected site|worker|admin)"
    exit 2
    ;;
esac
