#!/usr/bin/env bash
#
# lint-no-private-paths.test.sh: golden test for the added-lines private-path
# guard. Each case builds a throwaway git repo in a temp dir, commits a base,
# adds a change on a branch, and runs the guard against it. Every fixture is
# synthetic and the matching strings are assembled at runtime, so this file's
# own diff stays clean under the guard it tests.
#
# Run:  bash scripts/__tests__/lint-no-private-paths.test.sh
# Exit: 0 if all cases pass, 1 otherwise.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LINT="$REPO_ROOT/scripts/lint-no-private-paths.sh"

# Asserted EQUAL so a case that stops executing is as loud as a failing one.
EXPECTED_CASES=16

PASS=0
FAIL=0
FAILED=()

HOME_PATH="/Users/""blamechris/work/notes.md"
VAULT_PATH="~/Obsidian/""no-it-all/handoffs/NEXT.md"
TAILNET_HOST="box-one.tail""0a1b2c"".ts.net"
MARKER="private-path-guard:"" allow"

OUT="$(mktemp)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$OUT"' EXIT

check() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "ok   - $1"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$1 (expected exit $2, got $3)")
    echo "NOT  - $1 (expected exit $2, got $3)"
    sed 's/^/       /' "$OUT"
  fi
}

# mkrepo <name>: temp repo with one base commit (file base.txt), branch `work`.
mkrepo() {
  local d="$TMP/$1"
  mkdir -p "$d"
  git -C "$d" init -q -b main
  git -C "$d" config user.email "test@example.invalid"
  git -C "$d" config user.name "test"
  printf 'base line\n' >"$d/base.txt"
  git -C "$d" add base.txt
  git -C "$d" commit -q -m base
  git -C "$d" checkout -q -b work
  echo "$d"
}

# commit_all <repo>: stage every change in the throwaway repo and commit.
commit_all() {
  git -C "$1" add -A >/dev/null
  git -C "$1" commit -q -m change
}

# run_lint <repo> [args...]: print the exit code.
run_lint() {
  local d="$1"; shift
  (cd "$d" && bash "$LINT" "$@" >"$OUT" 2>&1)
  echo $?
}

# 1: a clean change passes
d="$(mkrepo clean)"; printf 'hello\n' >"$d/a.txt"; commit_all "$d"
check "clean change passes" 0 "$(run_lint "$d" main)"

# 2-4: each rule red
d="$(mkrepo home)"; printf 'see %s\n' "$HOME_PATH" >"$d/a.md"; commit_all "$d"
check "home path FAILS" 1 "$(run_lint "$d" main)"
grep -q 'a.md:1: \[home-path\]' "$OUT" && { PASS=$((PASS + 1)); echo "ok   - report names path:line and rule"; } \
  || { FAIL=$((FAIL + 1)); FAILED+=("report format"); echo "NOT  - report format"; sed 's/^/       /' "$OUT"; }

d="$(mkrepo vault)"; printf 'x\nread %s\n' "$VAULT_PATH" >"$d/a.md"; commit_all "$d"
check "vault path FAILS" 1 "$(run_lint "$d" main)"

d="$(mkrepo tailnet)"; printf 'host=%s\n' "$TAILNET_HOST" >"$d/a.env"; commit_all "$d"
check "tailnet MagicDNS host FAILS" 1 "$(run_lint "$d" main)"

# 5: a lookalike (not 6 hex) is not a tailnet host
d="$(mkrepo lookalike)"; printf 'host=box.tailzzzzzz.ts.net\nhost2=box.tail12345.ts.net\n' >"$d/a.env"; commit_all "$d"
check "tail-lookalike with non-hex / wrong length passes" 0 "$(run_lint "$d" main)"

# 6-8: exempt directories
for dir in .claude .codex .gemini; do
  d="$(mkrepo "ex$dir")"; mkdir -p "$d/$dir/skills"
  printf 'handoff at %s\n' "$VAULT_PATH" >"$d/$dir/skills/s.md"; commit_all "$d"
  check "$dir/ is exempt" 0 "$(run_lint "$d" main)"
done

# 9: a non-exempt path that merely contains the exempt dir name is NOT exempt
d="$(mkrepo nested)"; mkdir -p "$d/docs/.claude"; printf '%s\n' "$HOME_PATH" >"$d/docs/.claude/x.md"; commit_all "$d"
check "nested docs/.claude is not exempt" 1 "$(run_lint "$d" main)"

# 10: marker exempts only its own line
d="$(mkrepo marker)"; printf '%s  # %s\n' "$HOME_PATH" "$MARKER" >"$d/a.md"; commit_all "$d"
check "marker line is exempt" 0 "$(run_lint "$d" main)"
d="$(mkrepo marker2)"; printf '%s  # %s\n%s\n' "$HOME_PATH" "$MARKER" "$HOME_PATH" >"$d/a.md"; commit_all "$d"
check "marker does not exempt the next line" 1 "$(run_lint "$d" main)"

# 12: a deleted line (and untouched pre-existing leak) is green
d="$(mkrepo deleted)"
git -C "$d" checkout -q main
printf 'old %s\n' "$HOME_PATH" >"$d/leaky.md"; printf 'keep\n' >>"$d/leaky.md"
git -C "$d" add leaky.md; git -C "$d" commit -q -m leak
git -C "$d" checkout -q work; git -C "$d" merge -q main
BASE_SHA="$(git -C "$d" rev-parse HEAD)"
printf 'keep\n' >"$d/leaky.md"; commit_all "$d"
check "removing a leaked line passes" 0 "$(run_lint "$d" "$BASE_SHA")"

# 13: missing base exits 2
d="$(mkrepo nobase)"; printf 'hello\n' >"$d/a.txt"; commit_all "$d"
check "missing base ref exits 2 (fail closed)" 2 "$(run_lint "$d" no-such-ref)"

# 14: outside a git repo exits 2
mkdir -p "$TMP/plain"
check "not a git repo exits 2" 2 "$(run_lint "$TMP/plain" main)"

# 15: --direct works in the same shape
d="$(mkrepo direct)"; printf '%s\n' "$HOME_PATH" >"$d/a.md"; commit_all "$d"
check "--direct flags the same change" 1 "$(run_lint "$d" --direct main)"

echo "----"
BROKEN=0
if [ "$FAIL" -ne 0 ]; then
  echo "FAILED ($FAIL): ${FAILED[*]}"
  BROKEN=1
fi
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
  BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
echo "PASS — all $PASS cases"
