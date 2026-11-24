#!/usr/bin/env bash
#
# docker-image-smoke.test.sh — tests for the #9248 tool check in
# scripts/docker-image-smoke.sh: the built image must resolve `ps` and `lsof`.
#
# The script's other checks need a real image, so this drives only the first
# one against a fake `docker` placed FIRST on PATH in a fresh mktemp -d (never
# in a real tool directory). The shim answers only the `--entrypoint sh ... -c`
# probe, by running that shell command with PATH set to a fake "image bin"
# directory that holds exactly the tools the case wants the image to have;
# every other docker call fails, so the script stops right after the tool
# check. "Green" therefore means: the tool check passed and the script moved
# on ("== Image tools OK" printed); "red" means it failed naming the tool.
#
# Run from repo root:  bash scripts/__tests__/docker-image-smoke.test.sh
set -uo pipefail

EXPECTED_CASES=4
PASS=0
FAIL=0
FAILED_TESTS=()
pass() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() {
  FAIL=$((FAIL + 1)); FAILED_TESTS+=("$1")
  echo "  FAIL - $1"
  [ -n "${2:-}" ] && echo "         $2"
}

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SMOKE="$REPO_ROOT/scripts/docker-image-smoke.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/shim"
cat > "$TMP/shim/docker" <<'SHIM'
#!/usr/bin/env bash
# Fake docker: `version` and `image inspect` succeed (the script's preflights); only the `--entrypoint sh <image> -c <script> _ <tool>` probe works.
case "${1:-}" in
  version) exit 0 ;;
  image) [ "${2:-}" = inspect ] && exit 0 ;;
esac
args=("$@")
for i in "${!args[@]}"; do
  if [ "${args[$i]}" = "--entrypoint" ] && [ "${args[$((i+1))]:-}" = "sh" ]; then
    for j in "${!args[@]}"; do
      if [ "${args[$j]}" = "-c" ]; then
        PATH="$FAKE_IMAGE_BIN" exec /bin/sh "${args[@]:$j}"
      fi
    done
  fi
done
exit 1
SHIM
chmod +x "$TMP/shim/docker"

# run_case <name> <tools-present...>; sets OUT and RC
run_case() {
  local name="$1"; shift
  local bin="$TMP/$name-bin"
  mkdir -p "$bin"
  for t in "$@"; do printf '#!/bin/sh\nexit 0\n' > "$bin/$t"; chmod +x "$bin/$t"; done
  OUT="$(PATH="$TMP/shim:$PATH" FAKE_IMAGE_BIN="$bin" bash "$SMOKE" fake:image 2>&1)"
  RC=$?
}

echo "docker-image-smoke.sh tool check (#9248)"

run_case both ps lsof
if grep -qF "== Image tools OK" <<<"$OUT"; then
  pass "image with ps and lsof passes the tool check"
else
  fail "image with ps and lsof passes the tool check" "$OUT"
fi

run_case nolsof ps
if [ "$RC" -ne 0 ] && grep -qF "FAIL: 'lsof' is not installed in fake:image" <<<"$OUT" && ! grep -qF "Image tools OK" <<<"$OUT"; then
  pass "image without lsof fails naming lsof"
else
  fail "image without lsof fails naming lsof" "rc=$RC $OUT"
fi

run_case nops lsof
if [ "$RC" -ne 0 ] && grep -qF "FAIL: 'ps' is not installed in fake:image" <<<"$OUT" && ! grep -qF "Image tools OK" <<<"$OUT"; then
  pass "image without ps fails naming ps"
else
  fail "image without ps fails naming ps" "rc=$RC $OUT"
fi

run_case neither
if [ "$RC" -ne 0 ] && grep -qF "FAIL: 'ps' is not installed" <<<"$OUT"; then
  pass "image with neither fails"
else
  fail "image with neither fails" "rc=$RC $OUT"
fi

echo ""
echo "passed: $PASS  failed: $FAIL"
BROKEN=0
if [ "$FAIL" -gt 0 ]; then
  for t in "${FAILED_TESTS[@]}"; do echo "  - $t"; done
  BROKEN=1
fi
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
  BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
exit 0
