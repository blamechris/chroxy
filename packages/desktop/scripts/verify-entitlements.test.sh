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

# Case 6b — live helper entitlements plist must contain audio-input (#4953).
# Tested via direct file inspection because the verifier's plist-mode runs the
# full parent required-keys set (which the helper plist intentionally lacks).
LIVE_HELPER_PLIST="$(cd "$SCRIPT_DIR/.." && pwd)/src-tauri/entitlements-helper.plist"
if [ -f "$LIVE_HELPER_PLIST" ]; then
    if grep -qF '<key>com.apple.security.device.audio-input</key>' "$LIVE_HELPER_PLIST"; then
        echo "ok   - src-tauri/entitlements-helper.plist contains audio-input (#4953)"
        PASS=$((PASS + 1))
    else
        echo "FAIL - src-tauri/entitlements-helper.plist missing audio-input (#4953)" >&2
        FAIL=$((FAIL + 1))
    fi
else
    echo "FAIL - src-tauri/entitlements-helper.plist not found at $LIVE_HELPER_PLIST" >&2
    FAIL=$((FAIL + 1))
fi

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

# Case 7 — synthetic .app bundle exercises the helper-in-app code path (#4955).
#
# The #4953/#4954 helper-in-app branch only fires when TARGET is a `.app`
# directory; all prior cases use `.plist` files which take the plist-mode
# short-circuit and never run the new branch. Without codesign on the test
# runner — and without a real codesigned helper binary — the parent
# `extract_entitlements` step short-circuits at line 119 on any unsigned
# `.app`, so we stub `codesign` to return a valid parent plist and an empty
# helper plist. This lets the parent check pass and the helper check fail,
# matching the regression we want to catch.
#
# This guards against:
#   - The `[ -d "$TARGET" ] && [[ "$TARGET" == *.app ]]` guard inverted
#   - The `Contents/Resources/speech-helper` path string typo'd
#   - The empty-blob FAIL branch demoted to WARN
#   - The EXIT_CODE=1 aggregation lost on helper failure
FAKE_APP="$TMP_DIR/Fake.app"
mkdir -p "$FAKE_APP/Contents/Resources"
: > "$FAKE_APP/Contents/Resources/speech-helper"

STUB_DIR="$TMP_DIR/stub-bin"
mkdir -p "$STUB_DIR"
# Stub responds to `codesign -d --entitlements - [--xml] <target>` by checking
# the last argument: helper path → exit 1 (empty blob), anything else → emit
# a valid parent plist on stdout, exit 0. Matches both codesign invocations
# in extract_entitlements (with and without --xml).
cat > "$STUB_DIR/codesign" <<'STUB'
#!/usr/bin/env bash
target="${@: -1}"
if [[ "$target" == *speech-helper* ]]; then
    exit 1
fi
cat <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
</dict>
</plist>
EOF
STUB
chmod +x "$STUB_DIR/codesign"

set +e
STUB_OUT="$(PATH="$STUB_DIR:$PATH" "$VERIFIER" "$FAKE_APP" 2>&1)"
STUB_RC=$?
set -e
assert_exit "#4955 — synthetic .app with empty-entitlements helper → exit 1" 1 "$STUB_RC"

if printf '%s' "$STUB_OUT" | grep -qF "speech-helper has no embedded entitlements"; then
    echo "ok   - #4955 — helper-in-app FAIL message present in stderr"
    PASS=$((PASS + 1))
else
    echo "FAIL - #4955 — helper-in-app FAIL message missing (output: $STUB_OUT)" >&2
    FAIL=$((FAIL + 1))
fi

# Case 8 — helper absent → WARN, parent-only result (#4955).
# Guards against the empty-blob branch being conflated with the file-missing
# branch (today they emit different messages and different exit codes).
FAKE_APP_NO_HELPER="$TMP_DIR/NoHelper.app"
mkdir -p "$FAKE_APP_NO_HELPER/Contents/Resources"
# Note: speech-helper deliberately NOT created.

set +e
STUB_OUT2="$(PATH="$STUB_DIR:$PATH" "$VERIFIER" "$FAKE_APP_NO_HELPER" 2>&1)"
STUB_RC2=$?
set -e
assert_exit "#4955 — synthetic .app with no helper file → exit 0 (WARN only)" 0 "$STUB_RC2"

if printf '%s' "$STUB_OUT2" | grep -qF "speech-helper not present"; then
    echo "ok   - #4955 — missing-helper WARN message present in stderr"
    PASS=$((PASS + 1))
else
    echo "FAIL - #4955 — missing-helper WARN message missing (output: $STUB_OUT2)" >&2
    FAIL=$((FAIL + 1))
fi

echo ""
echo "verify-entitlements tests: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
