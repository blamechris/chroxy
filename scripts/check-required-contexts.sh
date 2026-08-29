#!/usr/bin/env bash
# Diff CONTRIBUTING.md's required-checks roster against main's LIVE required
# status checks (#7448) — classic branch protection AND branch rulesets, since
# a check required only via a ruleset never appears in the classic contexts
# field (the false-OK the #7499 review caught).
#
# Local-only by design: reading classic protection needs repo-admin scope,
# which CI's GITHUB_TOKEN does not have — a CI job "checking" this would be
# the cannot-check-treated-as-nothing-to-check failure in
# docs/false-safety-guards.md. The doc parse itself is NOT duplicated here: it
# runs scripts/lib/contributing-roster.mjs, the same implementation the CI
# test imports.
#
# The repo slug is deliberately hardcoded: the roster describes UPSTREAM's
# protection, so a fork clone auditing upstream is correct.
#
# Exit codes: 0 = in sync, 1 = drift (printed both directions), 2 = could not
# read one of the two sides (NEVER silently 0).
set -u
CDPATH='' cd -- "$(dirname -- "$0")/.." || exit 2

gh_err=$(mktemp)
trap 'rm -f "$gh_err"' EXIT

# Classic protection: prefer the non-deprecated checks[].context, fall back to
# the legacy contexts field.
classic=$(gh api repos/blamechris/chroxy/branches/main/protection \
  --jq '(.required_status_checks.checks // []) | map(.context) | .[]' 2>"$gh_err") || {
  echo "REFUSE: cannot read live branch protection: $(head -2 "$gh_err" | tr '\n' ' ')" >&2
  exit 2
}
if [ -z "$classic" ]; then
  classic=$(gh api repos/blamechris/chroxy/branches/main/protection \
    --jq '(.required_status_checks.contexts // []) | .[]' 2>"$gh_err") || {
    echo "REFUSE: cannot read live branch protection (legacy field): $(head -2 "$gh_err" | tr '\n' ' ')" >&2
    exit 2
  }
fi

# Ruleset-required checks (aggregate rules endpoint, no admin scope needed).
rules=$(gh api repos/blamechris/chroxy/rules/branches/main \
  --jq '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context' 2>"$gh_err") || {
  echo "REFUSE: cannot read branch rules: $(head -2 "$gh_err" | tr '\n' ' ')" >&2
  exit 2
}

live=$(printf '%s\n%s\n' "$classic" "$rules" | sed '/^$/d' | sort -u)
[ -n "$live" ] || { echo "REFUSE: live required-checks set came back empty" >&2; exit 2; }

# No pipe on this line: a pipeline would report sort's exit code, not the
# parser's, and the parser's REFUSE message is the diagnostic that matters.
doc=$(node scripts/lib/contributing-roster.mjs 2>"$gh_err") || {
  echo "REFUSE: $(head -2 "$gh_err" | tr '\n' ' ')" >&2
  exit 2
}
doc=$(sort -u <<< "$doc")
[ -n "$doc" ] || { echo "REFUSE: roster parse produced no output" >&2; exit 2; }

drift=0
while IFS= read -r c; do
  if ! grep -qxF -- "$c" <<< "$doc"; then
    echo "DRIFT: required live (protection or ruleset), missing from CONTRIBUTING.md: $c"
    drift=1
  fi
done <<< "$live"
while IFS= read -r c; do
  if ! grep -qxF -- "$c" <<< "$live"; then
    echo "DRIFT: listed in CONTRIBUTING.md, not required live: $c"
    drift=1
  fi
done <<< "$doc"

[ "$drift" -eq 0 ] && echo "OK: CONTRIBUTING.md roster matches live required checks ($(wc -l <<< "$live" | tr -d ' ') contexts)"
exit "$drift"
