#!/usr/bin/env bash
# bundle-server.test.sh — black-box coverage for desktop server resource staging.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

EXPECTED_CASES=4
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

check_executable() {
    local description="$1"
    local path="$2"
    if [ -x "$path" ]; then
        echo "ok   - $description"
        PASS=$((PASS + 1))
    else
        echo "FAIL - $description" >&2
        FAIL=$((FAIL + 1))
    fi
}

# Verifies the derived lockfile (#7324) actually landed: a real v3 lockfile
# naming the staged server, no leftover @chroxy/* entry, and no copied-in
# packages/server/package-lock.json (bundle-server.sh no longer copies one —
# a stray fixture leak here would mean the OLD copy step silently survived).
check_derived_lockfile() {
    local description="$1"
    local lockfile="$2"
    if [ -f "$lockfile" ] && node -e "
      const lock = require('$lockfile');
      if (lock.lockfileVersion !== 3) process.exit(1);
      if (!lock.packages || !lock.packages[''] || lock.packages[''].name !== 'fixture-server') process.exit(1);
      if (Object.keys(lock.packages).some((k) => k.includes('@chroxy/'))) process.exit(1);
    "; then
        echo "ok   - $description"
        PASS=$((PASS + 1))
    else
        echo "FAIL - $description" >&2
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
    "$FIXTURE_ROOT/scripts/lib" \
    "$TMP_DIR/bin"
cp "$SCRIPT_DIR/bundle-server.sh" "$FIXTURE_ROOT/packages/desktop/scripts/bundle-server.sh"

# derive-server-lockfile.mjs (#7324) is invoked BY bundle-server.sh, as the
# real script under test, so it needs a real copy here too — along with the
# repo-scripts entry-point guard it imports (scripts/lib/is-entry-point.mjs),
# at the same repo-relative path its own `../../../scripts/lib/...` import
# expects.
cp "$SCRIPT_DIR/derive-server-lockfile.mjs" "$FIXTURE_ROOT/packages/desktop/scripts/derive-server-lockfile.mjs"
cp "$SCRIPT_DIR/../../../scripts/lib/is-entry-point.mjs" "$FIXTURE_ROOT/scripts/lib/is-entry-point.mjs"

cat > "$FIXTURE_ROOT/packages/server/package.json" <<'EOF'
{"name":"fixture-server","version":"1.0.0","dependencies":{}}
EOF
# The root lockfile derive-server-lockfile.mjs reads from — packages/server
# no longer carries its own package-lock.json (#7324). An empty
# "dependencies" above keeps the derived closure empty, so this fixture only
# needs a bare workspace entry, not a real dependency graph.
cat > "$FIXTURE_ROOT/package-lock.json" <<'EOF'
{"name":"fixture-repo","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture-repo","version":"1.0.0"},"packages/server":{"name":"fixture-server","version":"1.0.0"}}}
EOF
printf '%s\n' '// fixture cli' > "$FIXTURE_ROOT/packages/server/src/cli.js"
printf '%s\n' '// fixture util' > "$FIXTURE_ROOT/packages/server/src/utils/fixture.js"
printf '%s\n' '#!/usr/bin/env bash' > "$FIXTURE_ROOT/packages/server/hooks/permission-hook.sh"
printf '%s\n' '// native route fixture' > "$FIXTURE_ROOT/packages/server/hooks/claude-native-route-check.mjs"
printf '%s\n' '<!doctype html>' > "$FIXTURE_ROOT/packages/dashboard/dist/index.html"

# This precondition makes the production chmod observable: if the fixture were
# already executable, removing chmod from bundle-server.sh could stay green.
if [ -x "$FIXTURE_ROOT/packages/server/hooks/permission-hook.sh" ]; then
    echo "HARNESS REFUSED: permission-hook.sh fixture must start non-executable" >&2
    exit 1
fi

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
check_executable \
    "makes staged permission-hook.sh executable" \
    "$STAGED/hooks/permission-hook.sh"
check_file_matches \
    "stages the built dashboard" \
    "$FIXTURE_ROOT/packages/dashboard/dist/index.html" \
    "$STAGED/src/dashboard-next/dist/index.html"
check_derived_lockfile \
    "derives a standalone v3 lockfile for the staged server from the root lockfile (#7324)" \
    "$STAGED/package-lock.json"

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
