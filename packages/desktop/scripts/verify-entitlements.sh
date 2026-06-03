#!/usr/bin/env bash
# verify-entitlements.sh — assert required entitlements are present in a
# signed macOS .app bundle (or in a raw entitlements.plist for unit tests).
#
# Background: see #4801 and #4953. The macOS Tauri build originally shipped
# without `com.apple.security.device.audio-input` on the parent app (#4801),
# then continued to ship voice-broken because TCC binds entitlements per
# binary and the bundled Swift speech-helper was signed with empty
# entitlements even after the parent was patched (#4953). This script
# verifies BOTH the parent .app bundle AND the embedded
# Contents/Resources/speech-helper Mach-O so a future missing-entitlement
# regression fails the build instead of shipping broken voice input.
#
# Usage:
#   scripts/verify-entitlements.sh <path-to-app-or-plist>
#
# Modes:
#   - If the target ends with `.plist` or is a regular file, dump its raw
#     text and check the parent-app required-keys set.
#   - If the target is a `.app` bundle, run `codesign -d --entitlements -`
#     against the bundle (parent required-keys set) AND against
#     Contents/Resources/speech-helper (helper required-keys set).
#
# Exits non-zero if any required entitlement is missing.

set -euo pipefail

# Parent app needs JIT/library entitlements for the Tauri webview + Node runtime
# AND audio-input so it can spawn the helper inside its TCC context.
REQUIRED_ENTITLEMENTS=(
    "com.apple.security.cs.allow-jit"
    "com.apple.security.cs.allow-unsigned-executable-memory"
    "com.apple.security.cs.disable-library-validation"
    "com.apple.security.device.audio-input"
)

# Helper subprocess only needs audio-input. TCC evaluates microphone access
# against the binary that opens the audio device — the helper's own
# entitlements blob, not the parent's. See #4953.
HELPER_REQUIRED_ENTITLEMENTS=(
    "com.apple.security.device.audio-input"
)

usage() {
    echo "Usage: $0 <path-to-Chroxy.app | path-to-entitlements.plist>" >&2
    exit 2
}

if [ $# -ne 1 ]; then
    usage
fi

TARGET="$1"

if [ ! -e "$TARGET" ]; then
    echo "verify-entitlements: target not found: $TARGET" >&2
    exit 2
fi

extract_entitlements() {
    local target="$1"
    local blob
    if [[ "$target" == *.plist ]] || { [ -f "$target" ] && [[ "$target" != *.app ]] && [ ! -d "$target" ]; }; then
        cat "$target"
        return 0
    fi
    if ! command -v codesign >/dev/null 2>&1; then
        echo "verify-entitlements: codesign not found (macOS-only)" >&2
        return 2
    fi
    # codesign emits the XML plist on stdout; older macOS versions print a
    # leading header line on stderr which we discard.
    blob="$(codesign -d --entitlements - --xml "$target" 2>/dev/null || true)"
    if [ -z "$blob" ]; then
        # Retry without --xml for compatibility with older codesign that
        # emits the plist as the primary output and may not support --xml.
        blob="$(codesign -d --entitlements - "$target" 2>/dev/null || true)"
    fi
    if [ -z "$blob" ]; then
        return 1
    fi
    printf '%s' "$blob"
}

# Check a blob against a list of required keys. Sets MISSING_KEYS to space-
# separated missing keys, empty if all present.
check_keys() {
    local blob="$1"
    shift
    MISSING_KEYS=""
    for key in "$@"; do
        # Match the `<key>NAME</key>` line as a fixed string (grep -F) so dots in
        # the entitlement name (`com.apple.security.device.audio-input`) are not
        # treated as regex "any char" — a regex match would false-positive on
        # malformed `<key>comXappleXsecurityXdeviceXaudio-input</key>`. The
        # surrounding `<key>...</key>` anchors also guard against substring
        # collisions (e.g. `audio-input` vs `audio-input-foo`).
        if ! printf '%s\n' "$blob" | grep -qF "<key>${key}</key>"; then
            if [ -z "$MISSING_KEYS" ]; then
                MISSING_KEYS="$key"
            else
                MISSING_KEYS="$MISSING_KEYS $key"
            fi
        fi
    done
}

EXIT_CODE=0

# --- Parent check (always runs) ---
PARENT_BLOB="$(extract_entitlements "$TARGET")" || {
    echo "verify-entitlements: unable to read entitlements from $TARGET" >&2
    exit 1
}

check_keys "$PARENT_BLOB" "${REQUIRED_ENTITLEMENTS[@]}"
if [ -n "$MISSING_KEYS" ]; then
    echo "verify-entitlements: FAIL — missing required entitlements in $TARGET:" >&2
    for key in $MISSING_KEYS; do
        echo "  - $key" >&2
    done
    EXIT_CODE=1
else
    echo "verify-entitlements: OK — all required entitlements present in $TARGET"
fi

# --- Helper check (only for .app bundles) ---
# #4953: the speech-helper inside Contents/Resources/ has its own signature
# and TCC entitlement set. Verify it carries audio-input — the parent's
# audio-input does NOT propagate to the subprocess.
if [ -d "$TARGET" ] && [[ "$TARGET" == *.app ]]; then
    HELPER_PATH="${TARGET}/Contents/Resources/speech-helper"
    if [ -f "$HELPER_PATH" ]; then
        HELPER_BLOB="$(extract_entitlements "$HELPER_PATH" || true)"
        if [ -z "$HELPER_BLOB" ]; then
            echo "verify-entitlements: FAIL — speech-helper has no embedded entitlements at $HELPER_PATH" >&2
            echo "  (#4953: helper must be signed with --entitlements entitlements-helper.plist)" >&2
            EXIT_CODE=1
        else
            check_keys "$HELPER_BLOB" "${HELPER_REQUIRED_ENTITLEMENTS[@]}"
            if [ -n "$MISSING_KEYS" ]; then
                echo "verify-entitlements: FAIL — missing required entitlements in $HELPER_PATH:" >&2
                for key in $MISSING_KEYS; do
                    echo "  - $key" >&2
                done
                EXIT_CODE=1
            else
                echo "verify-entitlements: OK — all required entitlements present in $HELPER_PATH"
            fi
        fi
    else
        echo "verify-entitlements: WARN — speech-helper not present at $HELPER_PATH (skipping helper check)" >&2
    fi
fi

exit $EXIT_CODE
