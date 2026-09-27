#!/usr/bin/env bash
# bundle-server.test.sh — black-box coverage for desktop server resource staging.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

EXPECTED_CASES=8
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

# derive-server-lockfile.mjs (#7324) and find-macho.mjs (#7986) are both
# invoked BY bundle-server.sh, as the real scripts under test, so they need
# real copies here too — along with the repo-scripts entry-point guard both
# import (scripts/lib/is-entry-point.mjs), at the same repo-relative path
# their own `../../../scripts/lib/...` import expects.
cp "$SCRIPT_DIR/derive-server-lockfile.mjs" "$FIXTURE_ROOT/packages/desktop/scripts/derive-server-lockfile.mjs"
cp "$SCRIPT_DIR/find-macho.mjs" "$FIXTURE_ROOT/packages/desktop/scripts/find-macho.mjs"
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

# The npm stub also plants scenario-specific fixtures into node_modules,
# selected by $BUNDLE_MACHO_CASE, so the same fixture repo can exercise every
# find-macho.mjs / SDK-prune scenario below just by re-running bundle-server.sh
# (which always starts with `rm -rf "$STAGING"`, so nothing from a previous
# case leaks into the next). Magic bytes are written with printf's \xHH escape
# — literal inside this quoted heredoc, interpreted once, when the stub itself
# runs as its own bash process (see the "escapes can die in nested shells"
# precondition below, which independently verifies these landed correctly
# before any scenario's pass/fail is trusted).
cat > "$TMP_DIR/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p node_modules
case "${BUNDLE_MACHO_CASE:-none}" in
  extensionless)
    # An extension-less Mach-O (thin64/MH_MAGIC_64) with no signing story —
    # exactly the shape the extension-based guard cannot see (#7986).
    mkdir -p node_modules/some-pkg/bin
    printf '\xfe\xed\xfa\xcf\x00\x00\x00\x0c' > node_modules/some-pkg/bin/tool
    ;;
  sdk-platform)
    # The SDK's platform-specific `claude` binaries (#7986) — pruned on every
    # host regardless of Mach-O detection — plus the JS entrypoint that must
    # survive the prune.
    mkdir -p node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64
    printf '\xfe\xed\xfa\xcf\x00\x00\x00\x0c' > node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
    mkdir -p node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64
    printf '\xfe\xed\xfa\xcf\x00\x00\x00\x0c' > node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude
    mkdir -p node_modules/@anthropic-ai/claude-agent-sdk
    printf '%s\n' '// fixture sdk entry' > node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
    ;;
  node-pty-exempt)
    # node-pty's darwin spawn-helper: a real extension-less Mach-O that MUST
    # be exempt from the scan (signed by build.rs at Tauri bundle time, #3902).
    mkdir -p node_modules/node-pty/prebuilds/darwin-arm64
    printf '\xfe\xed\xfa\xcf\x00\x00\x00\x0c' > node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
    ;;
  java-class)
    # cafebabe shared with FAT_MAGIC, disambiguated by nfat_arch: major
    # version 52 (0x34) is far outside the plausible 1..29 architecture count.
    mkdir -p node_modules/some-pkg
    printf '\xca\xfe\xba\xbe\x00\x00\x00\x34' > node_modules/some-pkg/Fixture.class
    ;;
  none) ;;
esac
EOF
chmod +x "$TMP_DIR/bin/npm"

# uname stub: forces the Darwin-only guard to run on ANY host, so this suite
# is not silently skipped when run on non-macOS CI or a developer's Linux box.
cat > "$TMP_DIR/bin/uname" <<'EOF'
#!/usr/bin/env bash
echo "Darwin"
EOF
chmod +x "$TMP_DIR/bin/uname"

# HARNESS REFUSED precondition: independently invoke the npm stub (outside
# bundle-server.sh) for every scenario and verify the planted files' magic
# bytes with `od`, rather than trusting that the printf escapes above survived
# the heredoc unmangled. Nested-shell escape loss is silent by nature — a
# scenario whose fixture bytes came out wrong would still produce a pass or
# fail, just not for the reason the case name claims.
hex_head() {
    od -An -tx1 -N "$2" "$1" | tr -d ' \n'
}
verify_magic_bytes() {
    local description="$1" file="$2" want="$3" got
    got="$(hex_head "$file" "$((${#want} / 2))")"
    if [ "$got" != "$want" ]; then
        echo "HARNESS REFUSED: $description: planted magic bytes are wrong (got '$got', want '$want')" >&2
        exit 1
    fi
}
MACHO_PROBE_DIR="$TMP_DIR/macho-probe"
for probe_case in extensionless sdk-platform node-pty-exempt java-class; do
    rm -rf "$MACHO_PROBE_DIR"
    mkdir -p "$MACHO_PROBE_DIR"
    (cd "$MACHO_PROBE_DIR" && BUNDLE_MACHO_CASE="$probe_case" "$TMP_DIR/bin/npm" ci >/dev/null)
    case "$probe_case" in
        extensionless)
            verify_magic_bytes "extensionless fixture" \
                "$MACHO_PROBE_DIR/node_modules/some-pkg/bin/tool" "feedfacf"
            ;;
        sdk-platform)
            verify_magic_bytes "sdk-platform darwin-arm64 fixture" \
                "$MACHO_PROBE_DIR/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" "feedfacf"
            verify_magic_bytes "sdk-platform darwin-x64 fixture" \
                "$MACHO_PROBE_DIR/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude" "feedfacf"
            ;;
        node-pty-exempt)
            verify_magic_bytes "node-pty spawn-helper fixture" \
                "$MACHO_PROBE_DIR/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper" "feedfacf"
            ;;
        java-class)
            verify_magic_bytes "java-class fixture" \
                "$MACHO_PROBE_DIR/node_modules/some-pkg/Fixture.class" "cafebabe00000034"
            ;;
    esac
done
rm -rf "$MACHO_PROBE_DIR"

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

# Re-runs bundle-server.sh with $BUNDLE_MACHO_CASE=$1 (selecting what the npm
# stub above plants), capturing stdout/stderr to per-case files and the exit
# code into $BUNDLE_CASE_RC without tripping this script's own `set -e` —
# several of the cases below EXPECT a non-zero exit. `rm -rf "$STAGING"` at
# the top of bundle-server.sh means each call starts from a clean bundle, so
# nothing a previous case planted or pruned leaks into the next.
run_bundle_case() {
    local case_name="$1"
    BUNDLE_CASE_STDOUT="$TMP_DIR/${case_name}.stdout"
    BUNDLE_CASE_STDERR="$TMP_DIR/${case_name}.stderr"
    if BUNDLE_MACHO_CASE="$case_name" PATH="$TMP_DIR/bin:$PATH" \
        bash "$FIXTURE_ROOT/packages/desktop/scripts/bundle-server.sh" \
        >"$BUNDLE_CASE_STDOUT" 2>"$BUNDLE_CASE_STDERR"; then
        BUNDLE_CASE_RC=0
    else
        BUNDLE_CASE_RC=$?
    fi
}

# (a) An extension-less Mach-O binary fails the build, and the failure names
# its exact path — the case the extension-based guard alone cannot catch.
run_bundle_case extensionless
if [ "$BUNDLE_CASE_RC" -ne 0 ] && grep -q "some-pkg/bin/tool" "$BUNDLE_CASE_STDERR"; then
    echo "ok   - rejects an extension-less Mach-O binary and names its path in stderr (#7986)"
    PASS=$((PASS + 1))
else
    echo "FAIL - rejects an extension-less Mach-O binary and names its path in stderr (#7986)" >&2
    echo "  exit code: $BUNDLE_CASE_RC" >&2
    cat "$BUNDLE_CASE_STDERR" >&2
    FAIL=$((FAIL + 1))
fi

# (b) The SDK's darwin platform packages are pruned on every host; the SDK's
# own JS entrypoint (sdk.mjs) survives; the build succeeds.
run_bundle_case sdk-platform
SDK_DARWIN_ARM64="$STAGED/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"
SDK_DARWIN_X64="$STAGED/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64"
SDK_ENTRYPOINT="$STAGED/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
if [ "$BUNDLE_CASE_RC" -eq 0 ] && [ ! -e "$SDK_DARWIN_ARM64" ] && [ ! -e "$SDK_DARWIN_X64" ] \
    && [ -f "$SDK_ENTRYPOINT" ]; then
    echo "ok   - prunes the SDK's darwin platform packages, keeps sdk.mjs, and the build succeeds (#7986)"
    PASS=$((PASS + 1))
else
    echo "FAIL - prunes the SDK's darwin platform packages, keeps sdk.mjs, and the build succeeds (#7986)" >&2
    echo "  exit code: $BUNDLE_CASE_RC" >&2
    ls -la "$STAGED/node_modules/@anthropic-ai" >&2 2>/dev/null || true
    cat "$BUNDLE_CASE_STDERR" >&2
    FAIL=$((FAIL + 1))
fi

# (c) node-pty's darwin spawn-helper — a real extension-less Mach-O — is
# exempt from the scan and stays in the bundle (it's signed later, by
# build.rs at Tauri bundle time, #3902).
run_bundle_case node-pty-exempt
SPAWN_HELPER="$STAGED/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
if [ "$BUNDLE_CASE_RC" -eq 0 ] && [ -f "$SPAWN_HELPER" ]; then
    echo "ok   - exempts node-pty's darwin spawn-helper (extension-less Mach-O) from the scan (#7986)"
    PASS=$((PASS + 1))
else
    echo "FAIL - exempts node-pty's darwin spawn-helper (extension-less Mach-O) from the scan (#7986)" >&2
    echo "  exit code: $BUNDLE_CASE_RC" >&2
    cat "$BUNDLE_CASE_STDERR" >&2
    FAIL=$((FAIL + 1))
fi

# (d) A Java class file (Fixture.class) shares cafebabe with FAT_MAGIC but is
# correctly disambiguated by nfat_arch, and is not flagged.
run_bundle_case java-class
JAVA_CLASS_FILE="$STAGED/node_modules/some-pkg/Fixture.class"
if [ "$BUNDLE_CASE_RC" -eq 0 ] && [ -f "$JAVA_CLASS_FILE" ]; then
    echo "ok   - does not flag a Java class file sharing cafebabe's magic (#7986)"
    PASS=$((PASS + 1))
else
    echo "FAIL - does not flag a Java class file sharing cafebabe's magic (#7986)" >&2
    echo "  exit code: $BUNDLE_CASE_RC" >&2
    cat "$BUNDLE_CASE_STDERR" >&2
    FAIL=$((FAIL + 1))
fi

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
