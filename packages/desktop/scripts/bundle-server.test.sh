#!/usr/bin/env bash
# bundle-server.test.sh — black-box coverage for desktop server resource staging.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

EXPECTED_CASES=2
PASS=0
FAIL=0

check_file_matches() {
    local description="$1"
    local source="$2"
    local bundled="$3"
    if [ -f "$bundled" ] && cmp -s "$source" "$bundled"; then
        echo "ok   - $description"
        PASS=$((PASS + 1))
    else
        echo "FAIL - $description" >&2
        FAIL=$((FAIL + 1))
    fi
}

check_trees_match() {
    local description="$1"
    local source="$2"
    local bundled="$3"
    if [ -d "$bundled" ] && diff -qr "$source" "$bundled" >/dev/null; then
        echo "ok   - $description"
        PASS=$((PASS + 1))
    else
        echo "FAIL - $description" >&2
        diff -qr "$source" "$bundled" >&2 || true
        FAIL=$((FAIL + 1))
    fi
}

# Run the real staging script against a minimal synthetic monorepo. npm is
# stubbed because dependency installation is unrelated to the resource-copy
# contract under test and would make this test depend on the network.
FIXTURE_ROOT="$TMP_DIR/repo"
mkdir -p \
    "$FIXTURE_ROOT/packages/desktop/scripts" \
    "$FIXTURE_ROOT/packages/server/src/utils" \
    "$FIXTURE_ROOT/packages/server/hooks" \
    "$FIXTURE_ROOT/packages/dashboard/dist" \
    "$TMP_DIR/bin"
cp "$SCRIPT_DIR/bundle-server.sh" "$FIXTURE_ROOT/packages/desktop/scripts/bundle-server.sh"

cat > "$FIXTURE_ROOT/packages/server/package.json" <<'EOF'
{"name":"fixture-server","version":"1.0.0","dependencies":{}}
EOF
cat > "$FIXTURE_ROOT/packages/server/package-lock.json" <<'EOF'
{"name":"fixture-server","version":"1.0.0","lockfileVersion":3,"packages":{}}
EOF
printf '%s\n' '// fixture cli' > "$FIXTURE_ROOT/packages/server/src/cli.js"
printf '%s\n' '// fixture util' > "$FIXTURE_ROOT/packages/server/src/utils/fixture.js"
printf '%s\n' '#!/usr/bin/env bash' > "$FIXTURE_ROOT/packages/server/hooks/permission-hook.sh"
printf '%s\n' '// native route fixture' > "$FIXTURE_ROOT/packages/server/hooks/claude-native-route-check.mjs"
printf '%s\n' '<!doctype html>' > "$FIXTURE_ROOT/packages/dashboard/dist/index.html"

cat > "$TMP_DIR/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p node_modules
EOF
chmod +x "$TMP_DIR/bin/npm"

PATH="$TMP_DIR/bin:$PATH" bash "$FIXTURE_ROOT/packages/desktop/scripts/bundle-server.sh" >/dev/null

STAGED="$FIXTURE_ROOT/packages/desktop/src-tauri/server-bundle"
check_trees_match \
    "stages every server runtime hook, including claude-native-route-check.mjs" \
    "$FIXTURE_ROOT/packages/server/hooks" \
    "$STAGED/hooks"
check_file_matches \
    "stages the built dashboard" \
    "$FIXTURE_ROOT/packages/dashboard/dist/index.html" \
    "$STAGED/src/dashboard-next/dist/index.html"

echo ""
echo "bundle-server tests: $PASS passed, $FAIL failed"

BROKEN=0
if [ "$FAIL" -gt 0 ]; then
    BROKEN=1
fi
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
    echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
    BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
