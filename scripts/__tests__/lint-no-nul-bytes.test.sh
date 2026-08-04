#!/usr/bin/env bash
#
# lint-no-nul-bytes.test.sh — Golden test for the NUL-byte source guard (#7103).
#
# The guard is the only thing standing between the repo and a silent regression
# of the #7103 bug class: a literal NUL byte in a text file makes that file
# invisible to every `-I` / NUL-sniffing code search, with no warning. So the
# guard itself needs a positive control — a lint that never fires is
# indistinguishable from a clean repo, which is exactly the false-safety shape
# this repo keeps getting bitten by.
#
# Cases:
#   1. a clean text tree passes
#   2. a NUL in a .js file FAILS (the core positive control)
#   3. a NUL in a TEST file fails too (the guard is workspace-wide, not
#      src-only — the one legitimate NUL in this repo lived under tests/)
#   4. a NUL in a BINARY asset (.png) is ignored (out of scope by extension)
#   5. the `\u0000` escape — the sanctioned way to keep the byte at runtime —
#      passes, since the file itself is plain ASCII
#   6. the production invocation (whole git index) stays green
#
# Drives the lint against a TEMP tree via LINT_NUL_SCAN_DIR so it never
# depends on repo state. No test framework — matches the sibling
# scripts/__tests__/*.test.sh.
#
# Run from anywhere:  bash scripts/__tests__/lint-no-nul-bytes.test.sh
# Exit status: 0 if all cases pass, 1 otherwise.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LINT="$REPO_ROOT/scripts/lint-no-nul-bytes.sh"

PASS=0
FAIL=0
FAILED=()

# run_lint <scan-dir> -> echoes the lint's exit code.
run_lint() {
  LINT_NUL_SCAN_DIR="$1" bash "$LINT" >/dev/null 2>&1
  echo $?
}

# check <name> <expected-exit> <actual-exit>
check() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "ok   - $1"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$1 (expected exit $2, got $3)"); echo "NOT  - $1 (expected exit $2, got $3)"
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SCAN="$TMP/scan"; mkdir -p "$SCAN/src" "$SCAN/tests"

# printf '\0' is the portable way to emit a real NUL from bash: the byte cannot
# survive a shell variable or an argv slot, so it has to be written directly.
nul_file() { printf 'const k = `a%bb`\n' '\0' > "$1"; }

# Case 1 — a clean text tree passes.
printf 'export const x = 1\n' > "$SCAN/src/clean.js"
printf '# notes\n' > "$SCAN/src/clean.md"
check "clean text tree passes" 0 "$(run_lint "$SCAN")"

# Case 2 — a NUL in a source file fails. THE positive control: if this ever
# starts passing, the guard has stopped guarding.
nul_file "$SCAN/src/dirty.js"
check "NUL in a .js source file fails" 1 "$(run_lint "$SCAN")"
rm -f "$SCAN/src/dirty.js"

# Case 3 — the guard is workspace-wide, not src-only.
nul_file "$SCAN/tests/dirty.test.js"
check "NUL under tests/ fails (guard is not src-scoped)" 1 "$(run_lint "$SCAN")"
rm -f "$SCAN/tests/dirty.test.js"

# Case 4 — binary assets are out of scope by extension, not by an exclude list.
nul_file "$SCAN/src/icon.png"
check "NUL in a binary asset (.png) is ignored" 0 "$(run_lint "$SCAN")"
rm -f "$SCAN/src/icon.png"

# Case 5 — the sanctioned fix. The runtime string still contains a NUL; the
# FILE does not, so the file stays greppable and the lint stays quiet.
printf "const k = 'bad.\\\\u0000nul'\n" > "$SCAN/src/escaped.js"
check "the \\u0000 escape passes (file is plain ASCII)" 0 "$(run_lint "$SCAN")"

# Case 6 — EXTS must cover every tracked text type, not just the ones #7103
# happened to hit. `.swift` is real tracked source
# (packages/desktop/src-tauri/swift/speech-helper.swift); a type missing from
# EXTS is skipped SILENTLY, which is the very failure shape the guard exists to
# prevent. This case pins the audited list against a partial one.
nul_file "$SCAN/src/helper.swift"
check "NUL in a .swift source file fails (EXTS covers every tracked text type)" 1 "$(run_lint "$SCAN")"
rm -f "$SCAN/src/helper.swift"

# Case 7 — production invocation over the real git index stays green.
bash "$LINT" >/dev/null 2>&1
check "default invocation (whole git index) green" 0 "$?"

echo "----"
if [ "$FAIL" -ne 0 ]; then
  echo "FAILED ($FAIL): ${FAILED[*]}"
  exit 1
fi
echo "PASS — all $PASS cases"
