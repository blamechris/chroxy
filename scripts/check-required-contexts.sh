#!/usr/bin/env bash
# Diff CONTRIBUTING.md's required-checks roster against main's LIVE
# branch-protection contexts (#7448).
#
# Local-only by design: reading branch protection needs repo-admin scope, which
# CI's GITHUB_TOKEN does not have — a CI job "checking" this would be the
# cannot-check-treated-as-nothing-to-check failure in
# docs/false-safety-guards.md. Exit codes: 0 = in sync, 1 = drift (printed both
# directions), 2 = could not read one of the two sides (NEVER silently 0).
set -u
cd "$(dirname "$0")/.."

live=$(gh api repos/blamechris/chroxy/branches/main/protection --jq '.required_status_checks.contexts[]' 2>/dev/null) || {
  echo "REFUSE: cannot read live branch protection (gh auth / admin scope?)" >&2
  exit 2
}
[ -n "$live" ] || { echo "REFUSE: live contexts list came back empty" >&2; exit 2; }

# The roster is every backticked name inside the required-status-checks bullet.
doc=$(awk '/Required status checks must be green/,/wired as required/' CONTRIBUTING.md \
  | grep -o '`[^`]*`' | tr -d '`') || true
[ -n "$doc" ] || { echo "REFUSE: could not parse the CONTRIBUTING.md roster" >&2; exit 2; }

drift=0
while IFS= read -r c; do
  if ! grep -qxF "$c" <<< "$doc"; then
    echo "DRIFT: required in live protection, missing from CONTRIBUTING.md: $c"
    drift=1
  fi
done <<< "$live"
while IFS= read -r c; do
  if ! grep -qxF "$c" <<< "$live"; then
    echo "DRIFT: listed in CONTRIBUTING.md, not required in live protection: $c"
    drift=1
  fi
done <<< "$doc"

[ "$drift" -eq 0 ] && echo "OK: CONTRIBUTING.md roster matches live protection ($(wc -l <<< "$live" | tr -d ' ') contexts)"
exit "$drift"
