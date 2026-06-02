#!/usr/bin/env bash
# verify-entitlements.test.sh — black-box test for verify-entitlements.sh.
#
# Runs the verifier against synthetic entitlements plists to confirm it:
#   1. Passes when every required key is present (including audio-input).
#   2. Fails non-zero when audio-input is missing (the #4801 regression).
#   3. Fails non-zero when any other required key is missing.
#   4. Fails non-zero on a malformed / empty plist.
#   5. Fails non-zero when the target file does not exist.
#   6. Fails on the live entitlements.plist in src-tauri only if the source
#      ever drops a required key — guards against accidental removal.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFIER="$SCRIPT_DIR/verify-entitlements.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0

assert_exit() {
    local description="$1"
    local expected="$2"
    local actual="$3"
    if [ "$expected" -eq "$actual" ]; then
        echo "ok   - $description (exit=$actual)"
        PASS=$((PASS + 1))
    else
        echo "FAIL - $description (expected exit=$expected, got $actual)" >&2
        FAIL=$((FAIL + 1))
    fi
}

run_verifier() {
    set +e
    "$VERIFIER" "$1" >/dev/null 2>&1
    local rc=$?
    set -e
    echo "$rc"
}

write_plist() {
    local path="$1"
    shift
    {
        echo '<?xml version="1.0" encoding="UTF-8"?>'
        echo '<plist version="1.0">'
        echo '<dict>'
        for key in "$@"; do
            echo "    <key>${key}</key>"
            echo "    <true/>"
        done
        echo '</dict>'
        echo '</plist>'
    } > "$path"
}

# Case 1 — all required keys present → exit 0
GOOD_PLIST="$TMP_DIR/good.plist"
write_plist "$GOOD_PLIST" \
    "com.apple.security.cs.allow-jit" \
    "com.apple.security.cs.allow-unsigned-executable-memory" \
    "com.apple.security.cs.disable-library-validation" \
    "com.apple.security.device.audio-input"
assert_exit "passes when all required entitlements present" 0 "$(run_verifier "$GOOD_PLIST")"

# Case 2 — missing audio-input (the #4801 regression) → exit 1
MISSING_AUDIO="$TMP_DIR/missing-audio.plist"
write_plist "$MISSING_AUDIO" \
    "com.apple.security.cs.allow-jit" \
    "com.apple.security.cs.allow-unsigned-executable-memory" \
    "com.apple.security.cs.disable-library-validation"
assert_exit "fails when audio-input missing (#4801)" 1 "$(run_verifier "$MISSING_AUDIO")"

# Case 3 — missing one of the JIT/library entitlements → exit 1
MISSING_JIT="$TMP_DIR/missing-jit.plist"
write_plist "$MISSING_JIT" \
    "com.apple.security.cs.allow-unsigned-executable-memory" \
    "com.apple.security.cs.disable-library-validation" \
    "com.apple.security.device.audio-input"
assert_exit "fails when allow-jit missing" 1 "$(run_verifier "$MISSING_JIT")"

# Case 4 — empty plist → exit 1
EMPTY_PLIST="$TMP_DIR/empty.plist"
write_plist "$EMPTY_PLIST"
assert_exit "fails on empty plist" 1 "$(run_verifier "$EMPTY_PLIST")"

# Case 5 — non-existent target → exit 2
assert_exit "fails when target missing" 2 "$(run_verifier "$TMP_DIR/does-not-exist.plist")"

# Case 6 — live source plist must satisfy verifier
LIVE_PLIST="$(cd "$SCRIPT_DIR/.." && pwd)/src-tauri/entitlements.plist"
assert_exit "src-tauri/entitlements.plist contains all required keys" 0 "$(run_verifier "$LIVE_PLIST")"

# Substring-collision guard — ensure the matcher doesn't false-positive on a
# look-alike key (e.g. `com.apple.security.device.audio-input-foo`).
COLLIDE_PLIST="$TMP_DIR/collide.plist"
write_plist "$COLLIDE_PLIST" \
    "com.apple.security.cs.allow-jit" \
    "com.apple.security.cs.allow-unsigned-executable-memory" \
    "com.apple.security.cs.disable-library-validation" \
    "com.apple.security.device.audio-input-foo"
assert_exit "rejects look-alike audio-input-foo key" 1 "$(run_verifier "$COLLIDE_PLIST")"

# Regex-metachar guard — dots in the entitlement name must be treated as
# literal dots, not regex "any char". A malformed plist where dots are
# replaced with other characters must fail (would falsely pass under
# `grep -E` because the dots in the pattern would match any character).
REGEX_COLLIDE_PLIST="$TMP_DIR/regex-collide.plist"
write_plist "$REGEX_COLLIDE_PLIST" \
    "com.apple.security.cs.allow-jit" \
    "com.apple.security.cs.allow-unsigned-executable-memory" \
    "com.apple.security.cs.disable-library-validation" \
    "comXappleXsecurityXdeviceXaudio-input"
assert_exit "treats dots in key as literal, not regex any-char" 1 "$(run_verifier "$REGEX_COLLIDE_PLIST")"

echo ""
echo "verify-entitlements tests: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
