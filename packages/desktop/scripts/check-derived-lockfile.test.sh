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

EXPECTED_CASES=7
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
#    package.json's range (^2.0.0). npm itself must reject it (offline this reports ENOTCACHED, not EUSAGE: npm tries to re-resolve the range).
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


# 6. The npm invocation. A stub npm on PATH records its argv and whether the
#    --cache directory it was handed was empty. This is what pins the flags: a
#    real npm cannot tell us, because without network access dropping
#    --offline or --cache changes no verdict (the good case never touches the
#    cache or the registry, and a drifted one fails either way). Also poisons
#    NPM_CONFIG_CACHE to prove the explicit --cache wins over the environment.
mkdir -p "$TMP_DIR/stubbin"
cat > "$TMP_DIR/stubbin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_ARGV"
prev=''
for a in "$@"; do
    if [ "$prev" = "--cache" ]; then
        if [ -d "$a" ] && [ -z "$(ls -A "$a")" ]; then echo "cache-empty:$a" >> "$STUB_ARGV"; fi
    fi
    prev="$a"
done
exit 0
EOF
chmod +x "$TMP_DIR/stubbin/npm"
STUB_ARGV="$TMP_DIR/argv.txt"
rc=0
PATH="$TMP_DIR/stubbin:$PATH" STUB_ARGV="$STUB_ARGV" NPM_CONFIG_CACHE="/nonexistent/chroxy-cache-$$" \
    bash "$SCRIPT_DIR/check-derived-lockfile.sh" >/dev/null 2>&1 || rc=$?
flags_ok=yes
for want in ci --omit=dev --ignore-scripts --dry-run --offline; do
    grep -qxF -- "$want" "$STUB_ARGV" 2>/dev/null || flags_ok=no
done
grep -q '^cache-empty:' "$STUB_ARGV" 2>/dev/null || flags_ok=no
if grep -q 'nonexistent/chroxy-cache' "$STUB_ARGV" 2>/dev/null; then flags_ok=no; fi
if [ "$rc" -eq 0 ] && [ "$flags_ok" = yes ]; then
    echo "ok   - npm is run with ci --omit=dev --ignore-scripts --dry-run --offline and a fresh empty --cache (not NPM_CONFIG_CACHE)"
    PASS=$((PASS + 1))
else
    echo "FAIL - npm invocation (exit $rc, flags_ok=$flags_ok)" >&2
    sed 's/^/       | /' "$STUB_ARGV" >&2 || true
    FAIL=$((FAIL + 1))
fi

# 7. The shared strip helper itself, asserted directly: postinstall and
#    devDependencies are removed, @chroxy/* dependencies removed, everything
#    else kept. Under --ignore-scripts a leftover postinstall is invisible to
#    npm, so only a direct assertion can pin it.
cat > "$TMP_DIR/strip-in.json" <<'EOF'
{"name":"s","dependencies":{"@chroxy/protocol":"*","foo":"^1.0.0"},"devDependencies":{"d":"1"},"scripts":{"postinstall":"node x.js","start":"node y.js"}}
EOF
rc=0
node "$SCRIPT_DIR/strip-server-package-json.mjs" "$TMP_DIR/strip-in.json" || rc=$?
if [ "$rc" -eq 0 ] && node -e "
  const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const ok = !('devDependencies' in p) && !('postinstall' in p.scripts) && p.scripts.start === 'node y.js'
    && !('@chroxy/protocol' in p.dependencies) && p.dependencies.foo === '^1.0.0';
  process.exit(ok ? 0 : 1);
" "$TMP_DIR/strip-in.json"; then
    echo "ok   - strip helper removes @chroxy/*, devDependencies and scripts.postinstall, keeps the rest"
    PASS=$((PASS + 1))
else
    echo "FAIL - strip helper output wrong (exit $rc)" >&2
    cat "$TMP_DIR/strip-in.json" >&2
    FAIL=$((FAIL + 1))
fi

echo ""
echo "check-derived-lockfile tests: $PASS passed, $FAIL failed"

BROKEN=0
if [ "$FAIL" -gt 0 ]; then
    BROKEN=1
fi
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
    echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
    BROKEN=1
fi
[ "$BROKEN" -eq 0 ] || exit 1
