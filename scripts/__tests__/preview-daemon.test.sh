#!/usr/bin/env bash
#
# preview-daemon.test.sh — harness for scripts/preview-daemon.sh (#8305).
#
# The script is exercised against a STUB daemon (a tiny node server injected via
# PREVIEW_DAEMON_CLI) so no real daemon, build or network is needed. The stub
# answers /health, logs the same `Config/state root:` line the real daemon logs,
# and dumps the environment it was given so the allowlist can be asserted. Every
# case runs against a throwaway HOME; nothing here touches ~/.chroxy, the
# keychain or port 8765.
#
# What is proven (mutation-checked in the PR, see docs/false-safety-guards.md):
#   - start's three assertions each fail closed (log names $SMOKE/config, port
#     is not a reserved one, the listener PID equals the launched PID)
#   - caller-exported CHROXY_DISCORD_WEBHOOK_URL / API_TOKEN / PORT never reach
#     the daemon, and the daemon sees EXACTLY the allowlisted variables
#   - stop refuses (non-zero, kills nothing) when the recorded PID's command
#     line lacks $SMOKE
#   - clean removes $SMOKE and refuses a directory it did not create
#   - --expect-head refuses a mismatching head before creating anything
#   - smoke-test.mjs accepts the script's preview.json (the override half of #8225)
#
# Run from anywhere:  bash scripts/__tests__/preview-daemon.test.sh
# Exit status: 0 if all cases pass, 1 otherwise.

set -uo pipefail

# shellcheck disable=SC1007 # deliberate CDPATH= reset for this one command
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
PD="$REPO_ROOT/scripts/preview-daemon.sh"

# Every case below must run. Without this, a harness whose cases stop executing
# prints "passed: 0  failed: 0" and exits 0 — "all cases passed" and "no case
# executed" are the same observable outcome (#7653). Asserted EQUAL, not -ge.
EXPECTED_CASES=58

PASS=0
FAIL=0
FAILED_TESTS=()

pass() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("$1")
  echo "  FAIL - $1"
  [ -n "${2:-}" ] && echo "         $2"
}
# ok <name> <detail-on-failure> -- <command...>: pass iff the command succeeds.
ok() {
  local name="$1" detail="$2"; shift 3
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name" "$detail"; fi
}

echo "preview-daemon.sh (#8305)"

# Preconditions fail LOUDLY: a missing tool must not turn into skipped cases.
for tool in lsof curl node git ps; do
  command -v "$tool" >/dev/null 2>&1 || { echo "HARNESS BROKEN: required tool missing: $tool" >&2; exit 1; }
done

WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
HOME_T="$WORK/home"
mkdir -p "$HOME_T" "$WORK/stubs"
DECOY_PID=''
LISTENER_PID=''
cleanup() {
  [ -n "$DECOY_PID" ] && kill "$DECOY_PID" 2>/dev/null
  [ -n "$LISTENER_PID" ] && kill "$LISTENER_PID" 2>/dev/null
  # Any stub daemon a failing case left behind: only ones whose command line is
  # under WORK (never a pattern kill outside it).
  local p
  for p in $(pgrep -f "$WORK/" 2>/dev/null); do [ "$p" = "$$" ] || kill "$p" 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- the stub daemon -------------------------------------------------------
make_stub() { # <mode> -> path
  local mode="$1" f="$WORK/stubs/stub-$1.js"
  cat >"$f" <<'JS'
const fs = require('fs'), http = require('http'), path = require('path')
const { spawn } = require('child_process')
const MODE = '__MODE__'
const isChild = process.argv.includes('--child')
const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('-c') + 1], 'utf8'))
const dir = process.env.CHROXY_CONFIG_DIR
const serve = () => http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}')
}).listen(cfg.port, cfg.host)
if (isChild) {
  const parent = Number(process.argv[process.argv.indexOf('--child') + 1])
  setInterval(() => { try { process.kill(parent, 0) } catch { process.exit(0) } }, 200)
  serve()
} else {
  console.log('Config/state root: ' + (MODE === 'wrongroot' ? '/somewhere/else' : dir) + ' (from CHROXY_CONFIG_DIR)')
  fs.writeFileSync(path.join(dir, 'stub-env.json'), JSON.stringify(process.env))
  fs.writeFileSync(path.join(dir, 'stub-argv.json'), JSON.stringify(process.argv))
  if (MODE === 'nohealth') setInterval(() => {}, 1000)
  else if (MODE === 'childlistener') {
    spawn(process.execPath, [__filename, '-c', process.argv[process.argv.indexOf('-c') + 1], '--child', String(process.pid)],
      { stdio: 'ignore', detached: true }).unref()
    setInterval(() => {}, 1000)
  } else serve()
}
JS
  sed -i.bak "s/__MODE__/$mode/" "$f" && rm -f "$f.bak"
  echo "$f"
}
STUB_OK="$(make_stub ok)"
STUB_WRONGROOT="$(make_stub wrongroot)"
STUB_CHILD="$(make_stub childlistener)"
STUB_NOHEALTH="$(make_stub nohealth)"

# Run the script the way a hostile shell would: production-looking secrets
# exported in the caller's environment.
pd() {
  env HOME="$HOME_T" \
    CHROXY_DISCORD_WEBHOOK_URL="https://discord.invalid/api/webhooks/leak-canary" \
    API_TOKEN="leak-canary-token" \
    PORT="1" \
    PREVIEW_DAEMON_SKIP_BUILD=1 \
    PREVIEW_DAEMON_CLI="${CLI:-$STUB_OK}" \
    PREVIEW_DAEMON_HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-20}" \
    bash "$PD" "$@"
}
json() { node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];process.stdout.write(String(v))' "$1" "$2"; }
count_smoke_dirs() { find "$HOME_T/chroxy-previews" -maxdepth 1 -name 'chroxy-smoke.*' 2>/dev/null | wc -l | tr -d ' '; }

# =========================================================================
# 1. start (happy path)
# =========================================================================
OUT="$(pd start 2>"$WORK/start.err")"; RC=$?
[ "$RC" -eq 0 ] && pass "start exits 0" || fail "start exits 0" "rc=$RC; $(cat "$WORK/start.err")"
SMOKE="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"
URL="$(printf '%s\n' "$OUT" | sed -n 's/^URL=//p')"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
ok "start prints SMOKE= under \$HOME/chroxy-previews/chroxy-smoke.*" "SMOKE='$SMOKE'" -- \
  bash -c '[[ "$1" == "$2"/chroxy-previews/chroxy-smoke.* ]] && [ -d "$1" ]' _ "$SMOKE" "$HOME_T"
ok "start prints URL= on 127.0.0.1" "URL='$URL'" -- bash -c '[[ "$1" =~ ^http://127\.0\.0\.1:[0-9]+$ ]]' _ "$URL"
ok "start prints HEAD= equal to the repo head" "$OUT" -- bash -c 'grep -qx "HEAD=$2" <<<"$1"' _ "$OUT" "$HEAD_SHA"

# preview.json
PJ="$SMOKE/preview.json"
PID="$(json "$PJ" pid)"; PORT_N="$(json "$PJ" port)"
ok "preview.json records pid, port, configDir, fixture, head" "$(cat "$PJ" 2>&1)" -- \
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of ["pid","port","configDir","fixture","head"])if(r[k]===undefined)process.exit(1)' "$PJ"
[ "$(json "$PJ" configDir)" = "$SMOKE/config" ] && pass "preview.json configDir is \$SMOKE/config" || fail "preview.json configDir is \$SMOKE/config" "$(json "$PJ" configDir)"
[ "$(json "$PJ" head)" = "$HEAD_SHA" ] && pass "preview.json head is the repo head" || fail "preview.json head is the repo head"
[ "$(json "$PJ" fixture)" = "$SMOKE/fixture" ] && pass "preview.json fixture is \$SMOKE/fixture" || fail "preview.json fixture is \$SMOKE/fixture"

# config.json
CFG="$SMOKE/config/config.json"
MODE_BITS="$(stat -f '%Lp' "$CFG" 2>/dev/null || stat -c '%a' "$CFG")"
[ "$MODE_BITS" = "600" ] && pass "config.json is chmod 600" || fail "config.json is chmod 600" "mode=$MODE_BITS"
ok "config.json: loopback host, tunnel none, CI watch off, no provider" "$(cat "$CFG")" -- \
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(c.host!=="127.0.0.1"||c.tunnel!=="none"||c.sessionCi.watch!==false||c.controlRoomRunnerIncludeGithub!==false||"provider" in c)process.exit(1)' "$CFG"
ok "config.json: cwd and workspaceRoots are the fixture" "$(cat "$CFG")" -- \
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const f=process.argv[2];if(c.cwd!==f||JSON.stringify(c.workspaceRoots)!==JSON.stringify([f]))process.exit(1)' "$CFG" "$SMOKE/fixture"
ok "config.json: random apiToken of at least 32 chars, not the caller's API_TOKEN" "token check" -- \
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(typeof c.apiToken!=="string"||c.apiToken.length<32||c.apiToken==="leak-canary-token")process.exit(1)' "$CFG"
ok "config.json: port is the recorded port and not reserved" "port=$PORT_N" -- \
  bash -c '[ "$(node -e "process.stdout.write(String(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).port))" "$1")" = "$2" ] && case "$2" in 8765|3131|8080|3000) exit 1;; esac' _ "$CFG" "$PORT_N"

# fixture repo
ok "fixture is a git repo with exactly one commit" "$(git -C "$SMOKE/fixture" log --oneline 2>&1)" -- \
  bash -c '[ "$(git -C "$1" rev-list --count HEAD)" = 1 ] && [ -f "$1/README.md" ]' _ "$SMOKE/fixture"

# The three start assertions, observed independently of the script.
ok "log names Config/state root: \$SMOKE/config" "$(cat "$SMOKE/daemon.log")" -- grep -qF "Config/state root: $SMOKE/config" "$SMOKE/daemon.log"
[ "$PORT_N" != 8765 ] && pass "port is not 8765" || fail "port is not 8765"
LP="$(lsof -nP -iTCP:"$PORT_N" -sTCP:LISTEN -t 2>/dev/null | head -1)"
[ -n "$PID" ] && [ "$LP" = "$PID" ] && pass "lsof listener PID equals the launched PID" || fail "lsof listener PID equals the launched PID" "listener=$LP pid=$PID"
ok "/health answers on the printed URL" "$URL" -- curl -fsS --max-time 3 "$URL/health"

# Environment: nothing the caller exported reaches the daemon.
ENVJ="$SMOKE/config/stub-env.json"
ENV_KEYS="$(node -e 'process.stdout.write(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).sort().join(" "))' "$ENVJ")"
ok "caller's CHROXY_DISCORD_WEBHOOK_URL / API_TOKEN / PORT do not reach the daemon" "daemon env keys: $ENV_KEYS" -- \
  node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of ["CHROXY_DISCORD_WEBHOOK_URL","API_TOKEN","PORT"])if(k in e)process.exit(1);if(JSON.stringify(e).includes("leak-canary"))process.exit(1)' "$ENVJ"
# The OS/`env` itself may add PWD/SHLVL/_ and, on macOS, __CF_USER_TEXT_ENCODING at exec; the allowlist is checked as a subset-and-superset of the eight names.
WANT="CHROXY_CONFIG_DIR CHROXY_CRED_DISABLE_KEYCHAIN CHROXY_DISABLE_KEYCHAIN HOME LANG PATH TERM TMPDIR USER"
GOT="$(printf '%s\n' $ENV_KEYS | grep -vE '^(PWD|SHLVL|_|OLDPWD|__CF_USER_TEXT_ENCODING)$' | tr '\n' ' ' | sed 's/ $//')"
[ "$GOT" = "$WANT" ] && pass "the daemon sees exactly the allowlisted variables" || fail "the daemon sees exactly the allowlisted variables" "got:  $GOT
         want: $WANT"
ok "keychain is disabled in both layers" "$(cat "$ENVJ")" -- \
  node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(e.CHROXY_DISABLE_KEYCHAIN!=="1"||e.CHROXY_CRED_DISABLE_KEYCHAIN!=="1")process.exit(1)' "$ENVJ"
ok "CHROXY_CONFIG_DIR is \$SMOKE/config and HOME is a fixture dir under \$SMOKE" "$(cat "$ENVJ")" -- \
  node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=process.argv[2];if(e.CHROXY_CONFIG_DIR!==s+"/config"||!e.HOME.startsWith(s+"/")||!e.TMPDIR.startsWith(s+"/"))process.exit(1)' "$ENVJ" "$SMOKE"
ok "PATH puts a Node 22 first" "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).PATH)' "$ENVJ")" -- \
  bash -c 'p="$(node -e "process.stdout.write(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).PATH)" "$1")"; first="${p%%:*}"; [[ "$("$first/node" -v)" == v22.* ]]' _ "$ENVJ"
ok "daemon argv carries the isolation flags" "$(cat "$SMOKE/config/stub-argv.json")" -- \
  node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).join(" ");for(const f of ["--tunnel none","--skip-checks","--no-supervisor","--host 127.0.0.1","-c "+process.argv[2]+"/config/config.json"])if(!a.includes(f))process.exit(1)' "$SMOKE/config/stub-argv.json" "$SMOKE"

# =========================================================================
# 2. url / status / smoke-test hand-off
# =========================================================================
[ "$(pd url "$SMOKE" 2>/dev/null)" = "$URL" ] && pass "url prints the same origin start printed" || fail "url prints the same origin start printed"
pd status "$SMOKE" >"$WORK/status.out" 2>&1; RC=$?
[ "$RC" -eq 0 ] && pass "status exits 0 for a healthy daemon" || fail "status exits 0 for a healthy daemon" "rc=$RC $(cat "$WORK/status.out")"
ok "status output never contains the token" "token leaked into status" -- \
  bash -c '! grep -qF "$(node -e "process.stdout.write(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).apiToken)" "$1")" "$2"' _ "$CFG" "$WORK/status.out"
# smoke-test.mjs --preview takes the script's record (closes the override half of #8225).
DRY="$(env HOME="$HOME_T" node "$REPO_ROOT/packages/server/tests/smoke-test.mjs" --dry-run --preview "$PJ" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && grep -qF "would target $URL" <<<"$DRY" \
  && pass "smoke-test.mjs --preview accepts the script's preview.json (URL and token)" \
  || fail "smoke-test.mjs --preview accepts the script's preview.json (URL and token)" "rc=$RC $DRY"
TOKEN_LEN="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).apiToken.length))' "$CFG")"
grep -qF "token $TOKEN_LEN chars" <<<"$DRY" && pass "smoke-test.mjs read the token from the scratch config" || fail "smoke-test.mjs read the token from the scratch config" "$DRY"

# =========================================================================
# 3. stop
# =========================================================================
# 3a. PID guard: point the record at a process whose command line lacks $SMOKE.
sleep 300 & DECOY_PID=$!
cp "$PJ" "$WORK/preview.json.bak"
node -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f,"utf8"));r.pid=Number(process.argv[2]);require("fs").writeFileSync(f,JSON.stringify(r))' "$PJ" "$DECOY_PID"
pd stop "$SMOKE" >"$WORK/stop.out" 2>&1; RC=$?
[ "$RC" -eq 4 ] && pass "stop exits non-zero (4) when the recorded PID's command lacks \$SMOKE" || fail "stop exits non-zero (4) when the recorded PID's command lacks \$SMOKE" "rc=$RC $(cat "$WORK/stop.out")"
kill -0 "$DECOY_PID" 2>/dev/null && pass "stop killed nothing when it refused (decoy still alive)" || fail "stop killed nothing when it refused (decoy still alive)"
kill -0 "$PID" 2>/dev/null && pass "the real daemon is untouched by a refused stop" || fail "the real daemon is untouched by a refused stop"
pd clean "$SMOKE" >/dev/null 2>&1; RC=$?
[ "$RC" -ne 0 ] && [ -d "$SMOKE" ] && pass "clean also refuses and leaves \$SMOKE in place on a PID mismatch" || fail "clean also refuses and leaves \$SMOKE in place on a PID mismatch" "rc=$RC"
kill "$DECOY_PID" 2>/dev/null; wait "$DECOY_PID" 2>/dev/null; DECOY_PID=''
cp "$WORK/preview.json.bak" "$PJ"

# 3b. stop success
pd stop "$SMOKE" >"$WORK/stop.out" 2>&1; RC=$?
[ "$RC" -eq 0 ] && pass "stop exits 0 for a daemon whose command line contains \$SMOKE" || fail "stop exits 0 for a daemon whose command line contains \$SMOKE" "rc=$RC $(cat "$WORK/stop.out")"
kill -0 "$PID" 2>/dev/null && fail "stop ended the daemon process" "pid $PID still alive" || pass "stop ended the daemon process"
[ -z "$(lsof -nP -iTCP:"$PORT_N" -sTCP:LISTEN -t 2>/dev/null)" ] && pass "the port is free after stop" || fail "the port is free after stop"
pd status "$SMOKE" >/dev/null 2>&1; RC=$?
[ "$RC" -ne 0 ] && pass "status exits non-zero once stopped" || fail "status exits non-zero once stopped"
pd stop "$SMOKE" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ] && pass "stop is idempotent on an already-stopped daemon" || fail "stop is idempotent on an already-stopped daemon" "rc=$RC"

# =========================================================================
# 4. clean
# =========================================================================
pd clean "$SMOKE" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ] && [ ! -e "$SMOKE" ] && pass "clean removes \$SMOKE (it holds the token)" || fail "clean removes \$SMOKE (it holds the token)" "rc=$RC exists=$([ -e "$SMOKE" ] && echo y || echo n)"

# clean on a running daemon stops it first.
OUT="$(pd start 2>/dev/null)"; S2="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"; P2="$(json "$S2/preview.json" pid)"
pd clean "$S2" >/dev/null 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ ! -e "$S2" ] && ! kill -0 "$P2" 2>/dev/null; then pass "clean stops a running daemon, then removes \$SMOKE"; else fail "clean stops a running daemon, then removes \$SMOKE" "rc=$RC"; fi

# clean refuses a dir it did not create (unmarked name, and marked name without the record).
# It carries a preview.json and config/ on purpose: the NAME guard must fire on
# its own, not be masked by the record guard behind it.
mkdir -p "$WORK/precious/config" && echo keep >"$WORK/precious/canary" && echo '{}' >"$WORK/precious/preview.json"
pd clean "$WORK/precious" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 4 ] && [ -f "$WORK/precious/canary" ] && pass "clean refuses a directory without the chroxy-smoke. name" || fail "clean refuses a directory without the chroxy-smoke. name" "rc=$RC"
mkdir -p "$HOME_T/chroxy-previews/chroxy-smoke.forged" && echo keep >"$HOME_T/chroxy-previews/chroxy-smoke.forged/canary"
pd clean "$HOME_T/chroxy-previews/chroxy-smoke.forged" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 4 ] && [ -f "$HOME_T/chroxy-previews/chroxy-smoke.forged/canary" ] && pass "clean refuses a marked name that has no preview.json/config" || fail "clean refuses a marked name that has no preview.json/config" "rc=$RC"
rm -rf "$HOME_T/chroxy-previews/chroxy-smoke.forged"

# =========================================================================
# 5. --expect-head
# =========================================================================
BEFORE="$(count_smoke_dirs)"
pd start --expect-head deadbeefdeadbeef >/dev/null 2>"$WORK/eh.err"; RC=$?
[ "$RC" -eq 3 ] && pass "--expect-head refuses a mismatching head (exit 3)" || fail "--expect-head refuses a mismatching head (exit 3)" "rc=$RC $(cat "$WORK/eh.err")"
[ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "a refused --expect-head created no scratch dir and launched nothing" || fail "a refused --expect-head created no scratch dir and launched nothing"
OUT="$(pd start --expect-head "${HEAD_SHA:0:12}" 2>/dev/null)"; RC=$?
S3="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"
[ "$RC" -eq 0 ] && [ -d "$S3" ] && pass "--expect-head accepts the matching head (abbreviated)" || fail "--expect-head accepts the matching head (abbreviated)" "rc=$RC"
[ -n "$S3" ] && pd clean "$S3" >/dev/null 2>&1

# =========================================================================
# 6. start refuses / fails closed
# =========================================================================
BEFORE="$(count_smoke_dirs)"
PREVIEW_DAEMON_PORT=8765 pd start >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ] && [ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "start refuses port 8765 before creating anything" || fail "start refuses port 8765 before creating anything" "rc=$RC"
node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port)})' >"$WORK/busy.port" &
LISTENER_PID=$!
for _ in $(seq 1 50); do [ -s "$WORK/busy.port" ] && break; sleep 0.1; done
BUSY="$(cat "$WORK/busy.port")"
PREVIEW_DAEMON_PORT="$BUSY" pd start >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ] && [ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "start refuses a port that already has a listener" || fail "start refuses a port that already has a listener" "rc=$RC"
kill "$LISTENER_PID" 2>/dev/null; LISTENER_PID=''
PREVIEW_DAEMON_PARENT="$WORK/outside" pd start >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ] && pass "start refuses a scratch parent outside \$HOME" || fail "start refuses a scratch parent outside \$HOME" "rc=$RC"

CLI="$STUB_WRONGROOT" pd start >/dev/null 2>"$WORK/wr.err"; RC=$?
[ "$RC" -ne 0 ] && grep -q "Config/state root" "$WORK/wr.err" && pass "start fails when the log names a different config root" || fail "start fails when the log names a different config root" "rc=$RC $(cat "$WORK/wr.err")"
[ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "a failed start leaves no scratch dir (and no token) behind" || fail "a failed start leaves no scratch dir (and no token) behind"
[ -z "$(pgrep -f "$WORK/stubs/stub-wrongroot.js" 2>/dev/null)" ] && pass "a failed start leaves no daemon running" || fail "a failed start leaves no daemon running"

CLI="$STUB_CHILD" pd start >/dev/null 2>"$WORK/ch.err"; RC=$?
[ "$RC" -ne 0 ] && grep -q "not the launched pid" "$WORK/ch.err" && pass "start fails when the listener PID is not the launched PID" || fail "start fails when the listener PID is not the launched PID" "rc=$RC $(cat "$WORK/ch.err")"
sleep 0.5
[ -z "$(pgrep -f "$WORK/stubs/stub-childlistener.js" 2>/dev/null)" ] && pass "the launched PID and its stray listener are gone after the failed start" || fail "the launched PID and its stray listener are gone after the failed start"

HEALTH_TIMEOUT=2 CLI="$STUB_NOHEALTH" pd start >/dev/null 2>"$WORK/nh.err"; RC=$?
[ "$RC" -ne 0 ] && grep -q "did not answer" "$WORK/nh.err" && pass "start times out (non-zero) when /health never answers" || fail "start times out (non-zero) when /health never answers" "rc=$RC $(cat "$WORK/nh.err")"
[ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "a timed-out start cleans up its scratch dir" || fail "a timed-out start cleans up its scratch dir"

# =========================================================================
# 7. the script itself
# =========================================================================
ok "the script parses under bash -n" "syntax error" -- bash -n "$PD"
ok "the script is executable-by-bash with a usage exit 2 for no subcommand" "usage rc" -- \
  bash -c 'bash "$1" >/dev/null 2>&1; [ $? -eq 2 ]' _ "$PD"
ok "the daemon launch is an env -i allowlist, not an env -u denylist" "launch line" -- \
  bash -c 'grep -qE "^[[:space:]]*nohup env -i" "$1" && ! grep -qE "env -u " "$1"' _ "$PD"

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
