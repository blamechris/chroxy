#!/usr/bin/env bash
# verify-entitlements.sh — assert required entitlements are present in a
# signed macOS .app bundle (or in a raw entitlements.plist for unit tests).
#
# Background: see #4801. The macOS Tauri build was shipping without
# `com.apple.security.device.audio-input`, which silently denied microphone
# access to the bundled Swift speech-helper. This script runs against the
# release-built .app so the next missing-entitlement regression fails the
# build instead of shipping broken voice input.
#
# Usage:
#   scripts/verify-entitlements.sh <path-to-app-or-plist>
#
# Modes:
#   - If the target ends with `.plist` or is a regular file, dump its raw text.
#   - Otherwise, run `codesign -d --entitlements - <target>` against an app
#     bundle to extract the embedded entitlements blob.
#
# Exits non-zero if any required entitlement is missing.

set -euo pipefail

REQUIRED_ENTITLEMENTS=(
    "com.apple.security.cs.allow-jit"
    "com.apple.security.cs.allow-unsigned-executable-memory"
    "com.apple.security.cs.disable-library-validation"
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

# Capture entitlements blob. For plist files we just cat; for .app bundles we
# go through codesign so we're asserting on what was actually signed in, not
# the source plist.
if [[ "$TARGET" == *.plist ]] || { [ -f "$TARGET" ] && [[ "$TARGET" != *.app ]]; }; then
    ENTITLEMENTS_BLOB="$(cat "$TARGET")"
else
    if ! command -v codesign >/dev/null 2>&1; then
        echo "verify-entitlements: codesign not found (macOS-only)" >&2
        exit 2
    fi
    # codesign emits the XML plist on stdout; older macOS versions print a
    # leading header line on stderr which we discard.
    ENTITLEMENTS_BLOB="$(codesign -d --entitlements - --xml "$TARGET" 2>/dev/null || true)"
    if [ -z "$ENTITLEMENTS_BLOB" ]; then
        # Retry without --xml for compatibility with older codesign that
        # emits the plist as the primary output and may not support --xml.
        ENTITLEMENTS_BLOB="$(codesign -d --entitlements - "$TARGET" 2>/dev/null || true)"
    fi
    if [ -z "$ENTITLEMENTS_BLOB" ]; then
        echo "verify-entitlements: unable to read entitlements from $TARGET" >&2
        exit 1
    fi
fi

MISSING=()
for key in "${REQUIRED_ENTITLEMENTS[@]}"; do
    # Match the `<key>NAME</key>` line as a fixed string (grep -F) so dots in
    # the entitlement name (`com.apple.security.device.audio-input`) are not
    # treated as regex "any char" — a regex match would false-positive on
    # malformed `<key>comXappleXsecurityXdeviceXaudio-input</key>`. The
    # surrounding `<key>...</key>` anchors also guard against substring
    # collisions (e.g. `audio-input` vs `audio-input-foo`).
    if ! printf '%s\n' "$ENTITLEMENTS_BLOB" | grep -qF "<key>${key}</key>"; then
        MISSING+=("$key")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "verify-entitlements: FAIL — missing required entitlements in $TARGET:" >&2
    for key in "${MISSING[@]}"; do
        echo "  - $key" >&2
    done
    exit 1
fi

echo "verify-entitlements: OK — all required entitlements present in $TARGET"
