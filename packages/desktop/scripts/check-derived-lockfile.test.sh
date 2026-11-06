#!/usr/bin/env bash
# check-derived-lockfile.test.sh — black-box coverage for check-derived-lockfile.sh (#7985).
#
# Runs the real check against the real repo (the case that matters) and against
# synthetic monorepos for the rejection paths. Every rejection case asserts the
# EXACT exit code AND the distinguishing message, so a check that denied
# everything (docs/false-safety-guards.md entry 11) or died for another reason
# cannot satisfy it. EXPECTED_CASES makes a run that executes fewer cases than
# written fail instead of reporting success over zero (#7653).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

EXPECTED_CASES=6
PASS=0
FAIL=0

# expect <description> <want-exit> <want-message-regex> <check-script> [repo-root]
expect() {
    local description="$1" want_rc="$2" want_msg="$3" script="$4"
    shift 4
    local out="$TMP_DIR/out.txt" rc=0
    bash "$script" "$@" >"$out" 2>&1 || rc=$?
    if [ "$rc" -eq "$want_rc" ] && grep -Eq -- "$want_msg" "$out"; then
        echo "ok   - $description"
        PASS=$((PASS + 1))
    else
        echo "FAIL - $description (exit $rc, wanted $want_rc; message /$want_msg/)" >&2
        sed 's/^/       | /' "$out" | head -20 >&2
        FAIL=$((FAIL + 1))
    fi
}

# --- Fixture: a minimal monorepo with ONE production dependency, so the
# derivation is non-empty and npm has something real to compare. ---
make_repo() {
    local root="$1" dep_range="$2" lock_version="$3" with_dev="$4"
    mkdir -p "$root/packages/server" "$root/packages/desktop/scripts" "$root/scripts/lib"
    cp "$SCRIPT_DIR/check-derived-lockfile.sh" "$SCRIPT_DIR/strip-server-package-json.mjs" \
       "$SCRIPT_DIR/derive-server-lockfile.mjs" "$root/packages/desktop/scripts/"
    cp "$REPO_ROOT/scripts/lib/is-entry-point.mjs" "$root/scripts/lib/"
    local dev=''
    if [ "$with_dev" = yes ]; then
        dev=',"devDependencies":{"left-dev":"^1.0.0"},"scripts":{"postinstall":"node missing.js"}'
    fi
    cat > "$root/packages/server/package.json" <<EOF
{"name":"fixture-server","version":"1.0.0","dependencies":{"@chroxy/protocol":"*","foo":"$dep_range"}$dev}
EOF
    cat > "$root/package-lock.json" <<EOF
{"name":"fixture-repo","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{
"":{"name":"fixture-repo","version":"1.0.0","workspaces":["packages/*"]},
"node_modules/foo":{"version":"$lock_version","resolved":"https://registry.npmjs.org/foo/-/foo-$lock_version.tgz","integrity":"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},
"packages/server":{"name":"fixture-server","version":"1.0.0","dependencies":{"foo":"$dep_range"}}}}
EOF
}

# Precondition: the repo under test is the repo we think it is.
if [ ! -f "$REPO_ROOT/package-lock.json" ] || [ ! -f "$REPO_ROOT/packages/server/package.json" ]; then
    echo "HARNESS REFUSED: $REPO_ROOT is not the chroxy checkout" >&2
    exit 1
fi

# 1. The real repo: npm must accept the lockfile derived from the real inputs.
expect "real repo: npm accepts the derived lockfile" 0 'OK: npm ci accepts' \
    "$SCRIPT_DIR/check-derived-lockfile.sh"

# 2. Synthetic good repo WITH devDependencies + postinstall + an @chroxy/* dep
#    in the source package.json: accepted only because the shared strip removes
#    them, so a fixture-passing result proves the strip is on the path.
make_repo "$TMP_DIR/good" '^1.0.0' '1.2.0' yes
expect "fixture with devDependencies/postinstall/@chroxy/*: accepted after the strip" 0 'OK: npm ci accepts' \
    "$TMP_DIR/good/packages/desktop/scripts/check-derived-lockfile.sh" "$TMP_DIR/good"

# 3. Out-of-sync lockfile: the locked foo (1.2.0) does not satisfy the staged
#    package.json's range (^2.0.0). npm itself must reject it (EUSAGE).
make_repo "$TMP_DIR/stale" '^2.0.0' '1.2.0' no
expect "out-of-sync lockfile: npm rejection reported, exit 1" 1 'npm ci rejected the derived server lockfile' \
    "$TMP_DIR/stale/packages/desktop/scripts/check-derived-lockfile.sh" "$TMP_DIR/stale"

# 4. Leftover devDependencies: replace the shared strip with one that forgets
#    devDependencies (the mutation from the issue). The derived lockfile covers
#    only production, so npm must reject the staged package.json.
make_repo "$TMP_DIR/leftover" '^1.0.0' '1.2.0' yes
cat > "$TMP_DIR/leftover/packages/desktop/scripts/strip-server-package-json.mjs" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs'
const f = process.argv[2]
const pkg = JSON.parse(readFileSync(f, 'utf8'))
for (const k of Object.keys(pkg.dependencies || {})) if (k.startsWith('@chroxy/')) delete pkg.dependencies[k]
writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n')
EOF
expect "devDependencies left in the staged package.json: rejected, exit 1" 1 'npm ci rejected the derived server lockfile' \
    "$TMP_DIR/leftover/packages/desktop/scripts/check-derived-lockfile.sh" "$TMP_DIR/leftover"

# 5. A missing input is a distinct failure (exit 2), not "nothing to check".
mkdir -p "$TMP_DIR/empty"
expect "missing inputs: exit 2, not a pass" 2 'missing input' \
    "$SCRIPT_DIR/check-derived-lockfile.sh" "$TMP_DIR/empty"

# 6. The cache must not matter: a poisoned NPM_CONFIG_CACHE pointing at an
#    unusable path must not change the verdict (the script pins its own).
NPM_CONFIG_CACHE="/nonexistent/chroxy-cache-$$" expect "poisoned NPM_CONFIG_CACHE does not affect the verdict" 0 'OK: npm ci accepts' \
    "$SCRIPT_DIR/check-derived-lockfile.sh"

echo "$PASS passed, $FAIL failed (expected $EXPECTED_CASES cases)"
if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
if [ "$PASS" -ne "$EXPECTED_CASES" ]; then
    echo "HARNESS ERROR: ran $PASS cases, expected $EXPECTED_CASES" >&2
    exit 1
fi
