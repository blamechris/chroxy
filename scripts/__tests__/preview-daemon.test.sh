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
#   - --config-patch merges into the scratch config (0600 kept), refuses every
#     non-allowlisted key / invalid JSON / non-object before creating anything; and
#     --stub-provider registers the keyless smoke-stub provider (#9189)
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
EXPECTED_CASES=119

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
mkdir -p "$HOME_T" "$WORK/stubs" "$WORK/hooks"
# A hostile caller git config: a failing pre-commit hook, forced signing with a
# bogus key, and a template dir. The fixture commit must be immune to all three.
printf '#!/bin/sh\ntouch "%s/hook-fired"\nexit 1\n' "$WORK" >"$WORK/hooks/pre-commit"
chmod +x "$WORK/hooks/pre-commit"
printf '[core]\n\thooksPath = %s/hooks\n[commit]\n\tgpgsign = true\n[user]\n\tsigningkey = BOGUSKEY\n' "$WORK" >"$HOME_T/.gitconfig"
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
if (cfg.port === 8765) { console.error('stub: refusing to bind 8765'); process.exit(9) }
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
# Not stat(1): BSD `stat -f %Lp` and GNU `stat -f` (filesystem status) diverge, and
# on Linux the GNU form succeeds with the wrong text, so a `||` fallback never runs.
MODE_BITS="$(node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$CFG")"
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
# The ONLY name tolerated beyond the allowlist is __CF_USER_TEXT_ENCODING, which
# the macOS kernel/libc injects into every exec (env -i or not). Its VALUE is
# asserted below, so a secret smuggled under that name would still fail.
GOT="$(printf '%s\n' $ENV_KEYS | grep -vxE '__CF_USER_TEXT_ENCODING' | tr '\n' ' ' | sed 's/ $//')"
[ "$GOT" = "$WANT" ] && pass "the daemon sees exactly the allowlisted variables" || fail "the daemon sees exactly the allowlisted variables" "got:  $GOT
         want: $WANT"
ok "keychain is disabled in both layers" "$(cat "$ENVJ")" -- \
  node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(e.CHROXY_DISABLE_KEYCHAIN!=="1"||e.CHROXY_CRED_DISABLE_KEYCHAIN!=="1")process.exit(1)' "$ENVJ"
ok "CHROXY_CONFIG_DIR is \$SMOKE/config and HOME is a fixture dir under \$SMOKE" "$(cat "$ENVJ")" -- \
  node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=process.argv[2];if(e.CHROXY_CONFIG_DIR!==s+"/config"||!e.HOME.startsWith(s+"/")||!e.TMPDIR.startsWith(s+"/"))process.exit(1)' "$ENVJ" "$SMOKE"
ok "__CF_USER_TEXT_ENCODING, if present, carries only the macOS encoding triple" "value leaked" -- \
  node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).__CF_USER_TEXT_ENCODING;if(e!==undefined&&!/^0x[0-9A-Fa-f]+:(0x)?[0-9A-Fa-f]+:(0x)?[0-9A-Fa-f]+$/.test(e))process.exit(1)' "$ENVJ"
ok "PATH is exactly the node-only dir plus the system dirs" "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).PATH)' "$ENVJ")" -- \
  node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(e.PATH!==process.argv[2]+"/bin:/usr/bin:/bin:/usr/sbin:/sbin")process.exit(1)' "$ENVJ" "$SMOKE"
ok "the node-only dir holds node (v22) and nothing but node/npm/npx" "$(ls "$SMOKE/bin")" -- \
  bash -c '[[ "$("$1/bin/node" -v)" == v22.* ]] && [ -z "$(ls "$1/bin" | grep -vxE "node|npm|npx")" ]' _ "$SMOKE"
ok "the stub daemon refuses to bind 8765 itself" "stub did not refuse" -- \
  bash -c 'printf "{\"port\":8765,\"host\":\"127.0.0.1\"}" >"$2/c8765.json"; node "$1" -c "$2/c8765.json"; [ $? -eq 9 ]' _ "$STUB_OK" "$WORK"
ok "the picked port is below both ephemeral ranges (20000-31999)" "port=$PORT_N" -- \
  bash -c '[ "$1" -ge 20000 ] && [ "$1" -le 31999 ]' _ "$PORT_N"
[ ! -e "$WORK/hook-fired" ] && pass "the caller's git hooks never fire for the fixture commit" || fail "the caller's git hooks never fire for the fixture commit" "pre-commit hook ran"
ok "the fixture commit ignores the caller's signing config (author is the fixture identity)" "$(git -C "$SMOKE/fixture" log -1 --format='%an <%ae> %G?' 2>&1)" -- \
  bash -c '[ "$(git -C "$1" log -1 --format="%an <%ae>")" = "preview <preview@localhost>" ]' _ "$SMOKE/fixture"
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
# A decoy whose command line merely MENTIONS $SMOKE/ is still not ours.
node -e "setTimeout(() => {}, 300000)" "$SMOKE/config/config.json" & MENTION_PID=$!
node -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f,"utf8"));r.pid=Number(process.argv[2]);require("fs").writeFileSync(f,JSON.stringify(r))' "$PJ" "$MENTION_PID"
pd stop "$SMOKE" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 4 ] && kill -0 "$MENTION_PID" 2>/dev/null && pass "stop refuses a PID whose command line only mentions \$SMOKE (exact shape required)" || fail "stop refuses a PID whose command line only mentions \$SMOKE (exact shape required)" "rc=$RC"
kill "$MENTION_PID" 2>/dev/null; wait "$MENTION_PID" 2>/dev/null
node -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f,"utf8"));r.pid=Number(process.argv[2]);require("fs").writeFileSync(f,JSON.stringify(r))' "$PJ" "$DECOY_PID"
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
# The match and dirty cases run the script from a COPY inside a throwaway git
# repo, so they do not depend on whether this working tree happens to be clean.
EH="$WORK/ehrepo"
mkdir -p "$EH/scripts" && cp "$PD" "$EH/scripts/preview-daemon.sh" && echo base >"$EH/tracked.txt"
( cd "$EH" && git init -q . && git add . \
  && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --no-verify -m base ) >/dev/null 2>&1
EH_HEAD="$(git -C "$EH" rev-parse HEAD)"
pd_eh() { env HOME="$HOME_T" PREVIEW_DAEMON_SKIP_BUILD=1 PREVIEW_DAEMON_CLI="$STUB_OK" bash "$EH/scripts/preview-daemon.sh" "$@"; }
OUT="$(pd_eh start --expect-head "${EH_HEAD:0:12}" 2>/dev/null)"; RC=$?
S3="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"
[ "$RC" -eq 0 ] && [ -d "$S3" ] && pass "--expect-head accepts the matching head (abbreviated) on a clean tree" || fail "--expect-head accepts the matching head (abbreviated) on a clean tree" "rc=$RC"
[ -n "$S3" ] && pd_eh clean "$S3" >/dev/null 2>&1
echo changed >"$EH/tracked.txt"
BEFORE="$(count_smoke_dirs)"
pd_eh start --expect-head "${EH_HEAD:0:12}" >/dev/null 2>"$WORK/dirty.err"; RC=$?
[ "$RC" -eq 3 ] && grep -q "tracked modifications" "$WORK/dirty.err" && [ "$(count_smoke_dirs)" = "$BEFORE" ] \
  && pass "--expect-head refuses a matching head on a dirty tree (exit 3, nothing created)" \
  || fail "--expect-head refuses a matching head on a dirty tree (exit 3, nothing created)" "rc=$RC $(cat "$WORK/dirty.err")"

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

HEALTH_TIMEOUT=abc pd start >/dev/null 2>&1; RC=$?
[ "$RC" -eq 2 ] && [ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "a non-numeric health timeout is refused before anything is launched" || fail "a non-numeric health timeout is refused before anything is launched" "rc=$RC"

# Preflight: a missing lsof must be a loud refusal, never "port free".
mkdir -p "$WORK/nolsof"
for t in dirname curl git ps; do ln -sf "$(command -v "$t")" "$WORK/nolsof/$t"; done
env -i HOME="$HOME_T" PATH="$WORK/nolsof" /bin/bash "$PD" start >"$WORK/nolsof.out" 2>&1; RC=$?
[ "$RC" -ne 0 ] && grep -q "lsof" "$WORK/nolsof.out" && pass "a missing lsof is refused with a clear error" || fail "a missing lsof is refused with a clear error" "rc=$RC $(cat "$WORK/nolsof.out")"
[ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "the missing-lsof refusal created no scratch dir" || fail "the missing-lsof refusal created no scratch dir"

# Trap: killing a start that is waiting on /health removes the dir and the daemon.
( exec env HOME="$HOME_T" PREVIEW_DAEMON_SKIP_BUILD=1 PREVIEW_DAEMON_CLI="$STUB_NOHEALTH" PREVIEW_DAEMON_HEALTH_TIMEOUT=60 bash "$PD" start ) >/dev/null 2>&1 &
SP=$!
for _ in $(seq 1 100); do ls "$HOME_T"/chroxy-previews/chroxy-smoke.*/config/stub-argv.json >/dev/null 2>&1 && break; sleep 0.1; done
STUB_PID="$(pgrep -f "$WORK/stubs/stub-nohealth.js" | head -1)"
kill -TERM "$SP" 2>/dev/null; wait "$SP" 2>/dev/null; RC=$?
[ "$RC" -eq 143 ] && pass "an interrupted start exits 143" || fail "an interrupted start exits 143" "rc=$RC"
[ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "an interrupted start removes the scratch dir (the token)" || fail "an interrupted start removes the scratch dir (the token)"
[ -n "$STUB_PID" ] && ! kill -0 "$STUB_PID" 2>/dev/null && pass "an interrupted start kills the daemon it launched" || fail "an interrupted start kills the daemon it launched" "stub=$STUB_PID"

# clean's parent guard: a well-formed smoke dir outside the previews root is refused.
mkdir -p "$WORK/elsewhere/chroxy-smoke.zzzzzz/config" && echo '{"pid":1}' >"$WORK/elsewhere/chroxy-smoke.zzzzzz/preview.json"
pd clean "$WORK/elsewhere/chroxy-smoke.zzzzzz" >/dev/null 2>&1; RC=$?
[ "$RC" -eq 4 ] && [ -d "$WORK/elsewhere/chroxy-smoke.zzzzzz" ] && pass "clean refuses a smoke-shaped dir that is not directly under the previews root" || fail "clean refuses a smoke-shaped dir that is not directly under the previews root" "rc=$RC"

# A planted gh/claude in the CALLER's node dir must not be reachable.
mkdir -p "$WORK/fakenode"
RN="$(dirname "$(command -v node)")"; [[ "$("$RN/node" -v)" == v22.* ]] || RN=/opt/homebrew/opt/node@22/bin
ln -sf "$RN/node" "$WORK/fakenode/node"
printf '#!/bin/sh\ntouch "%s/gh-ran"\n' "$WORK" >"$WORK/fakenode/gh"; chmod +x "$WORK/fakenode/gh"
OUT="$(PREVIEW_DAEMON_NODE_DIR="$WORK/fakenode" pd start 2>/dev/null)"; S4="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"
ok "a planted gh in the caller's node dir is not on the daemon's PATH" "PATH: $(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).PATH)' "$S4/config/stub-env.json" 2>&1)" -- \
  node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).PATH;if(p.split(":").includes(process.argv[2]))process.exit(1)' "$S4/config/stub-env.json" "$WORK/fakenode"
[ -n "$S4" ] && PREVIEW_DAEMON_NODE_DIR="$WORK/fakenode" pd clean "$S4" >/dev/null 2>&1

# Ambient GIT_* (as under a git hook or `rebase -x`) must not aim the fixture
# git calls at the caller's repo.
CALLER="$WORK/callerrepo"
mkdir -p "$CALLER" && ( cd "$CALLER" && git init -q . && echo c >c.txt && git add c.txt \
  && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --no-verify -m caller ) >/dev/null 2>&1
snap() { git --git-dir="$CALLER/.git" rev-list --all --count; git --git-dir="$CALLER/.git" count-objects; git --git-dir="$CALLER/.git" rev-parse HEAD; cksum <"$CALLER/.git/index"; }
SNAP_BEFORE="$(snap)"
OUT="$(GIT_DIR="$CALLER/.git" GIT_WORK_TREE="$CALLER" GIT_INDEX_FILE="$CALLER/.git/index" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=intruder pd start 2>/dev/null)"; RC=$?
S5="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"
[ "$(snap)" = "$SNAP_BEFORE" ] && pass "ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE leave the caller's repo untouched" || fail "ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE leave the caller's repo untouched" "caller repo changed (rc=$RC)"
[ "$RC" -eq 0 ] && [ "$(git -C "$S5/fixture" rev-list --count HEAD 2>/dev/null)" = 1 ] \
  && [ "$(git -C "$S5/fixture" log -1 --format=%an 2>/dev/null)" = preview ] && [ -f "$S5/fixture/README.md" ] \
  && pass "with ambient GIT_* set, the fixture is still its own correct one-commit repo" \
  || fail "with ambient GIT_* set, the fixture is still its own correct one-commit repo" "rc=$RC"
[ -n "$S5" ] && pd clean "$S5" >/dev/null 2>&1

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
# 6b. --config-patch / --stub-provider (#9189)
# =========================================================================
cfg_get() { node -e 'let v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of process.argv[2].split("."))v=v?.[k];process.stdout.write(JSON.stringify(v===undefined?null:v))' "$1" "$2"; }
mode_of() { node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }
PATCH_DIR="$WORK/patches"; mkdir -p "$PATCH_DIR"
printf '%s' '{"providers":{"anthropicCompatible":[{"id":"smoke-stub","label":"smoke-stub","baseUrl":"http://127.0.0.1:18470","defaultModel":"stub","models":["stub"]}]}}' >"$PATCH_DIR/ok.json"
BEFORE="$(count_smoke_dirs)"
OUT="$(pd start --config-patch "$PATCH_DIR/ok.json" 2>"$WORK/cp.err")"; RC=$?
SP="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"; PCFG="$SP/config/config.json"
[ "$RC" -eq 0 ] && [ "$(cfg_get "$PCFG" providers.anthropicCompatible.0.id)" = '"smoke-stub"' ] && [ "$(cfg_get "$PCFG" providers.anthropicCompatible.0.models.0)" = '"stub"' ] \
  && pass "--config-patch: the provider entry lands in the scratch config.json" || fail "--config-patch: the provider entry lands in the scratch config.json" "rc=$RC $(cat "$WORK/cp.err")"
ok "--config-patch: the script's own keys survive the merge" "$(cat "$PCFG" 2>&1)" -- \
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(c.host!=="127.0.0.1"||c.tunnel!=="none"||typeof c.apiToken!=="string"||c.apiToken.length<32||c.sessionCi.watch!==false||c.port!==JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")).port)process.exit(1)' "$PCFG" "$SP/preview.json"
[ "$(mode_of "$PCFG")" = 600 ] && pass "--config-patch: the patched config.json stays mode 0600" || fail "--config-patch: the patched config.json stays mode 0600" "mode=$(mode_of "$PCFG")"
[ -n "$SP" ] && pd clean "$SP" >/dev/null 2>&1

for K in apiToken port host tunnel tunnelName cwd workspaceRoots sessionCi controlRoomRunnerIncludeGithub notifications \
  noAuth dangerouslySkipPermissions skipPermissions allowAutoPermissionMode externalUrl tunnelHostname mcpServers codexBinary repoMemoryBin controlRoomRoot totallyUnknownKey; do
  printf '{"providers":{},"%s":{"x":1}}' "$K" >"$PATCH_DIR/guard-$K.json"
  BEFORE="$(count_smoke_dirs)"
  pd start --config-patch "$PATCH_DIR/guard-$K.json" >/dev/null 2>"$WORK/g.err"; RC=$?
  [ "$RC" -eq 2 ] && grep -q "not in the allowlist" "$WORK/g.err" && grep -q "$K" "$WORK/g.err" && [ "$(count_smoke_dirs)" = "$BEFORE" ] && [ -z "$(pgrep -f "$WORK/stubs/stub-ok.js" 2>/dev/null)" ] \
    && pass "--config-patch refuses non-allowlisted key $K (exit 2, no scratch dir, nothing launched)" \
    || fail "--config-patch refuses non-allowlisted key $K (exit 2, no scratch dir, nothing launched)" "rc=$RC $(cat "$WORK/g.err")"
done

printf '{not json' >"$PATCH_DIR/bad.json"; printf '[1,2]' >"$PATCH_DIR/arr.json"
BEFORE="$(count_smoke_dirs)"
pd start --config-patch "$PATCH_DIR/bad.json" >/dev/null 2>"$WORK/b.err"; RC=$?
[ "$RC" -eq 2 ] && grep -q "not valid JSON" "$WORK/b.err" && [ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "--config-patch rejects invalid JSON (exit 2, no scratch dir)" || fail "--config-patch rejects invalid JSON (exit 2, no scratch dir)" "rc=$RC $(cat "$WORK/b.err")"
pd start --config-patch "$PATCH_DIR/arr.json" >/dev/null 2>"$WORK/b.err"; RC=$?
[ "$RC" -eq 2 ] && grep -q "must be a JSON object" "$WORK/b.err" && [ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "--config-patch rejects a non-object patch (exit 2, no scratch dir)" || fail "--config-patch rejects a non-object patch (exit 2, no scratch dir)" "rc=$RC $(cat "$WORK/b.err")"
pd start --config-patch "$PATCH_DIR/missing.json" >/dev/null 2>"$WORK/b.err"; RC=$?
[ "$RC" -eq 2 ] && grep -q "not found" "$WORK/b.err" && [ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "--config-patch rejects a missing file (exit 2, no scratch dir)" || fail "--config-patch rejects a missing file (exit 2, no scratch dir)" "rc=$RC $(cat "$WORK/b.err")"

# Allowlisted keys are accepted; provider entries naming a binary/command/env are not.
printf '%s' '{"provider":"smoke-stub","model":"stub"}' >"$PATCH_DIR/allowed.json"
OUT="$(pd start --config-patch "$PATCH_DIR/allowed.json" 2>/dev/null)"; RC=$?
SP="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"
[ "$RC" -eq 0 ] && [ "$(cfg_get "$SP/config/config.json" provider)" = '"smoke-stub"' ] && [ "$(cfg_get "$SP/config/config.json" model)" = '"stub"' ] \
  && pass "--config-patch accepts the allowlisted provider and model keys" || fail "--config-patch accepts the allowlisted provider and model keys" "rc=$RC"
[ -n "$SP" ] && pd clean "$SP" >/dev/null 2>&1
printf '%s' '{"providers":{"anthropicCompatible":[{"id":"a","label":"a","baseUrl":"http://127.0.0.1:1","defaultModel":"m","models":["m"],"pricing":{"input":1,"output":2},"contextWindow":1000}]}}' >"$PATCH_DIR/fields.json"
OUT="$(pd start --config-patch "$PATCH_DIR/fields.json" 2>/dev/null)"; RC=$?
SP="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"
[ "$RC" -eq 0 ] && [ "$(cfg_get "$SP/config/config.json" providers.anthropicCompatible.0.contextWindow)" = 1000 ] && [ "$(cfg_get "$SP/config/config.json" providers.anthropicCompatible.0.pricing.output)" = 2 ] \
  && pass "--config-patch accepts every allowed provider entry field" || fail "--config-patch accepts every allowed provider entry field" "rc=$RC"
[ -n "$SP" ] && pd clean "$SP" >/dev/null 2>&1
# Each refusal body is paired with the cause it must name (a grep -E pattern), so a
# patch refused for an unrelated reason does not pass (#9193).
n=0
while IFS='|' read -r BODY CAUSE; do
  n=$((n + 1)); printf '%s' "$BODY" >"$PATCH_DIR/prov$n.json"
  BEFORE="$(count_smoke_dirs)"
  pd start --config-patch "$PATCH_DIR/prov$n.json" >/dev/null 2>"$WORK/pv.err"; RC=$?
  [ "$RC" -eq 2 ] && grep -q "REFUSING" "$WORK/pv.err" && grep -Eq "$CAUSE" "$WORK/pv.err" && [ "$(count_smoke_dirs)" = "$BEFORE" ] \
    && pass "--config-patch refuses provider shape $n naming its cause (exit 2, no scratch dir)" || fail "--config-patch refuses provider shape $n naming its cause (exit 2, no scratch dir)" "rc=$RC want=$CAUSE got=$(cat "$WORK/pv.err")"
done <<'SHAPES'
{"providers":{"anthropicCompatible":[{"id":"x","command":"/bin/sh"}]}}|entry allowlist \(.*\): command$
{"providers":{"anthropicCompatible":[{"id":"x","apiKeyEnv":"SECRET"}]}}|entry allowlist \(.*\): apiKeyEnv$
{"providers":{"anthropicCompatible":[{"id":"x","credentialsKey":"k"}]}}|entry allowlist \(.*\): credentialsKey$
{"providers":{"anthropicCompatible":[{"id":"x","modelDiscovery":true}]}}|entry allowlist \(.*\): modelDiscovery$
{"providers":{"anthropicCompatible":[{"id":"x","surprise":1}]}}|entry allowlist \(.*\): surprise$
{"providers":{"acp":[{"id":"x"}]}}|may only contain anthropicCompatible, not: acp$
{"providers":["claude-sdk"]}|providers must be an object
{"providers":{"anthropicCompatible":["smoke"]}}|anthropicCompatible\[0\] must be an object
{"providers":{"anthropicCompatible":[null]}}|anthropicCompatible\[0\] must be an object
{"providers":{"anthropicCompatible":[["x"]]}}|anthropicCompatible\[0\] must be an object
SHAPES

OUT="$(pd start --stub-provider 18471 2>"$WORK/sp.err")"; RC=$?
SP="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"; PCFG="$SP/config/config.json"
[ "$RC" -eq 0 ] && [ "$(cfg_get "$PCFG" providers.anthropicCompatible.0.baseUrl)" = '"http://127.0.0.1:18471"' ] && [ "$(cfg_get "$PCFG" providers.anthropicCompatible.0.id)" = '"smoke-stub"' ] \
  && pass "--stub-provider registers a keyless smoke-stub anthropicCompatible entry" || fail "--stub-provider registers a keyless smoke-stub anthropicCompatible entry" "rc=$RC $(cat "$WORK/sp.err")"
[ "$(mode_of "$PCFG")" = 600 ] && pass "--stub-provider: the config.json stays mode 0600" || fail "--stub-provider: the config.json stays mode 0600" "mode=$(mode_of "$PCFG")"
[ -n "$SP" ] && pd clean "$SP" >/dev/null 2>&1
BEFORE="$(count_smoke_dirs)"
pd start --stub-provider notaport >/dev/null 2>"$WORK/sp.err"; RC=$?
[ "$RC" -eq 2 ] && [ "$(count_smoke_dirs)" = "$BEFORE" ] && pass "--stub-provider rejects a non-numeric port (exit 2, no scratch dir)" || fail "--stub-provider rejects a non-numeric port (exit 2, no scratch dir)" "rc=$RC"
printf '%s' '{"providers":{"anthropicCompatible":[{"id":"other","baseUrl":"http://127.0.0.1:1","models":["m"]}]}}' >"$PATCH_DIR/other.json"
OUT="$(pd start --config-patch "$PATCH_DIR/other.json" --stub-provider 18472 2>/dev/null)"
SP="$(printf '%s\n' "$OUT" | sed -n 's/^SMOKE=//p')"
[ "$(cfg_get "$SP/config/config.json" providers.anthropicCompatible.length)" = 2 ] && [ "$(cfg_get "$SP/config/config.json" providers.anthropicCompatible.1.id)" = '"smoke-stub"' ] \
  && pass "--stub-provider appends after the --config-patch providers" || fail "--stub-provider appends after the --config-patch providers"
[ -n "$SP" ] && pd clean "$SP" >/dev/null 2>&1

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
