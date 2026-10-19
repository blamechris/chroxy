#!/usr/bin/env bash
# Read-only check of a live trial run, from GitHub only (no model usage, no writes).
#
#   bash docs/reports/harness-evals/trial/scripts/check-run.sh A2c-cy-claude
#   bash docs/reports/harness-evals/trial/scripts/check-run.sh B2c-cy-codex blamechris/chroxy
#
# Prints: the base branch tip, every commit on the base since T0, every PR whose base is
# the run's branch, the ten queue issues (state, comment count, last update: all must be
# untouched during a run), the main tip, and whether the run report exists on the base.
# Needs `gh` authenticated for the repo. Exits non-zero only when a `gh` call fails (auth,
# network, a base branch that does not exist yet); otherwise 0 whatever it finds: read the output.
set -euo pipefail
RUN_ID="${1:?usage: check-run.sh RUN_ID [OWNER/REPO]}"
REPO="${2:-blamechris/chroxy}"
BASE="trial/$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
HERE="$(cd "$(dirname "$0")" && pwd)"

T0="$(gh api "repos/$REPO/compare/main...$BASE" --jq '.merge_base_commit.sha')"
echo "== $RUN_ID   base=$BASE   T0=${T0:0:8}   checked $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "-- base tip"
gh api "repos/$REPO/branches/$BASE" \
  --jq '.commit.sha[0:8] + "  " + .commit.commit.committer.date + "  " + (.commit.commit.message | split("\n")[0])'

echo "-- commits on the base since T0 (oldest first)"
gh api "repos/$REPO/compare/$T0...$BASE" \
  --jq '.commits[] | .sha[0:8] + "  " + .commit.committer.date + "  " + (.commit.message | split("\n")[0])'

echo "-- pull requests with base $BASE (all states)"
gh pr list -R "$REPO" --base "$BASE" --state all --limit 50 \
  --json number,title,state,isDraft,createdAt,updatedAt,mergedAt \
  --jq '.[] | "\(.number)  \(.state)\(if .isDraft then " draft" else "" end)  created \(.createdAt)  updated \(.updatedAt)  merged \(.mergedAt // "-")  \(.title)"'

echo "-- queue issues (must stay untouched: no comments, labels or closures during a run)"
QUEUE="$(python3 - "$HERE/queue.json" <<'PY'
import json, sys
q = json.load(open(sys.argv[1]))
it = q.get('issues', q)
if isinstance(it, dict):
    nums = list(it.keys())
else:
    nums = [str(i.get('number', i)) if isinstance(i, dict) else str(i) for i in it]
print(' '.join(str(n).lstrip('#') for n in nums))
PY
)"
for n in $QUEUE; do
  gh api "repos/$REPO/issues/$n" \
    --jq '"\(.number)  \(.state)  comments=\(.comments)  updated \(.updated_at)  labels=\([.labels[].name] | join(","))"'
done

echo "-- main tip (a change here is the supervisor's; the daemon must not be redeployed during a run)"
gh api "repos/$REPO/branches/main" --jq '.commit.sha[0:8] + "  " + .commit.commit.committer.date'

echo "-- run report on the base?"
if probe="$(gh api "repos/$REPO/contents/docs/reports/harness-evals/trial/runs/$RUN_ID/REPORT.md?ref=$BASE" --jq '.sha' 2>&1)"; then
  echo "yes: docs/reports/harness-evals/trial/runs/$RUN_ID/REPORT.md is on $BASE (the run is over)"
elif printf '%s' "$probe" | grep -q "404"; then
  echo "no report yet"
else
  echo "report probe failed: $probe" >&2
  exit 1
fi
