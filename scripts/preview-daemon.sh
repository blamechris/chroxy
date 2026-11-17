#!/usr/bin/env bash
#
# preview-daemon.sh — one tested recipe to set up, launch and tear down an
# isolated chroxy preview daemon for agent smoke runs (#8305).
#
# Every smoke run used to re-derive this by hand, and each copy missed
# something: a prose recipe once used an `env -u` DENYLIST and left the
# keychain on, which would let the preview daemon resolve the production API
# token, identity key and Discord webhook (environment beats config.json in
# mergeConfig; the OS keychain is machine-global, not scoped by
# CHROXY_CONFIG_DIR). This script is the single implementation.
#
# Usage:
#   scripts/preview-daemon.sh start [--expect-head <sha>]
#       Prints SMOKE=<dir>, URL=<origin> and HEAD=<sha>. Pass the SMOKE dir to
#       the other subcommands (or export PREVIEW_DAEMON_DIR).
#   scripts/preview-daemon.sh url    <smoke-dir>   print the daemon origin
#   scripts/preview-daemon.sh status <smoke-dir>   exit 0 only if it is up and healthy
#   scripts/preview-daemon.sh stop   <smoke-dir>   SIGTERM the recorded PID, PID-guarded
#   scripts/preview-daemon.sh clean  <smoke-dir>   stop, then remove the dir (it holds the token)
#
# Then:  node packages/server/tests/smoke-test.mjs --preview <smoke-dir>/preview.json
#
# Exit codes: 0 ok, 1 failure, 2 usage / refused configuration,
#             3 --expect-head mismatch, 4 stop/clean refused (PID is not ours).
#
# Safety properties (each is proven by scripts/__tests__/preview-daemon.test.sh):
#   - The daemon starts under `env -i` with an ALLOWLIST (HOME USER TERM LANG
#     TMPDIR PATH CHROXY_CONFIG_DIR CHROXY_DISABLE_KEYCHAIN
#     CHROXY_CRED_DISABLE_KEYCHAIN). Nothing the caller exported reaches it.
#   - Keychain access is off in both layers; HOME is a fixture dir under the
#     scratch dir, so nothing reads the real ~/.claude or ~/.chroxy.
#   - It never uses port 8765, 3131, 8080 or 3000, and the chosen port must be
#     free before launch.
#   - stop only signals the recorded PID after `ps` shows the scratch dir in
#     that process's command line. Never a pattern kill, never SIGKILL.
#   - clean refuses to remove anything that is not a dir this script created.
#
# Test hooks (not for normal use): PREVIEW_DAEMON_CLI (daemon entry point),
# PREVIEW_DAEMON_PORT (fixed port), PREVIEW_DAEMON_SKIP_BUILD=1,
# PREVIEW_DAEMON_HEALTH_TIMEOUT (seconds), PREVIEW_DAEMON_PARENT,
# PREVIEW_DAEMON_NODE_DIR.

set -uo pipefail

CDPATH=''
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)" || { echo "preview-daemon: cannot resolve repo root" >&2; exit 1; }

BANNED_PORTS="8765 3131 8080 3000"
MARKER='chroxy-smoke.'

die() { echo "preview-daemon: $*" >&2; exit "${2:-1}"; }

usage() {
  sed -n '2,/^$/p' "$0" | sed -n '/^# Usage:/,/^# Then:/p' | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# --- Node 22 --------------------------------------------------------------
# The daemon requires Node 22. Resolve a directory whose `node` is v22.
resolve_node_dir() {
  local cand v
  for cand in "${PREVIEW_DAEMON_NODE_DIR:-}" \
              "$(dirname "$(command -v node 2>/dev/null || echo /nonexistent/node)")" \
              /opt/homebrew/opt/node@22/bin; do
    [ -n "$cand" ] && [ -x "$cand/node" ] || continue
    v="$("$cand/node" -v 2>/dev/null || true)"
    case "$v" in v22.*) ( cd "$cand" && pwd -P ); return 0 ;; esac
  done
  return 1
}

port_listener_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

is_banned_port() {
  local p
  for p in $BANNED_PORTS; do [ "$1" = "$p" ] && return 0; done
  return 1
}

pick_port() {
  local p tries=0
  if [ -n "${PREVIEW_DAEMON_PORT:-}" ]; then
    p="$PREVIEW_DAEMON_PORT"
    case "$p" in ''|*[!0-9]*) die "PREVIEW_DAEMON_PORT is not a number: $p" 2 ;; esac
    is_banned_port "$p" && die "port $p is reserved (production/common dev port); refusing" 2
    [ -z "$(port_listener_pids "$p")" ] || die "port $p already has a listener; refusing" 2
    echo "$p"; return 0
  fi
  while [ "$tries" -lt 50 ]; do
    p=$((20000 + (RANDOM * 32768 + RANDOM) % 40000))
    tries=$((tries + 1))
    is_banned_port "$p" && continue
    [ -z "$(port_listener_pids "$p")" ] || continue
    echo "$p"; return 0
  done
  return 1
}

# --- preview.json access --------------------------------------------------
# Field reader. Uses the resolved node; the record is JSON this script wrote.
rec() { "$NODE_BIN/node" -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  const v = r[process.argv[2]]
  if (v === undefined || v === null) process.exit(3)
  process.stdout.write(String(v))' "$1/preview.json" "$2"; }

canonical_dir() {
  [ -n "${1:-}" ] || die "missing <smoke-dir> (or set PREVIEW_DAEMON_DIR)" 2
  [ -d "$1" ] || die "not a directory: $1" 2
  ( cd "$1" && pwd -P )
}

# Is the recorded pid ours? 0 = ours, 1 = no such process, 4 = alive but NOT ours.
pid_ownership() {
  local pid="$1" smoke="$2" cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *"$smoke/"*) return 0 ;;
    *) return 4 ;;
  esac
}

# --- subcommands ----------------------------------------------------------
cmd_stop() {
  local smoke pid port rc i
  smoke="$(canonical_dir "${1:-${PREVIEW_DAEMON_DIR:-}}")" || exit $?
  NODE_BIN="$(resolve_node_dir)" || die "no Node 22 found (set PREVIEW_DAEMON_NODE_DIR)" 1
  [ -f "$smoke/preview.json" ] || die "no preview.json in $smoke; nothing to stop" 1
  pid="$(rec "$smoke" pid)" || die "preview.json has no pid" 1
  port="$(rec "$smoke" port)" || die "preview.json has no port" 1
  case "$pid" in ''|*[!0-9]*) die "recorded pid is not a number: $pid" 1 ;; esac

  pid_ownership "$pid" "$smoke"; rc=$?
  if [ "$rc" -eq 4 ]; then
    die "REFUSING to stop pid $pid: its command line does not contain $smoke/ (stale pid reused by another process?). Nothing was killed." 4
  fi
  if [ "$rc" -eq 0 ]; then
    kill -TERM "$pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 75 ]; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2; i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      die "pid $pid did not exit within 15s of SIGTERM; not escalating to SIGKILL" 1
    fi
    echo "stopped pid $pid"
  else
    echo "pid $pid is not running"
  fi
  if [ -n "$(port_listener_pids "$port")" ]; then
    die "port $port still has a listener after stop" 1
  fi
  echo "port $port is free"
}

cmd_clean() {
  local smoke base
  smoke="$(canonical_dir "${1:-${PREVIEW_DAEMON_DIR:-}}")" || exit $?
  base="$(basename "$smoke")"
  case "$base" in "$MARKER"*) ;; *) die "REFUSING to remove $smoke: not a $MARKER* dir" 4 ;; esac
  [ -f "$smoke/preview.json" ] && [ -d "$smoke/config" ] \
    || die "REFUSING to remove $smoke: no preview.json/config (not created by this script)" 4
  cmd_stop "$smoke" || die "stop failed; leaving $smoke in place" 4
  rm -rf -- "$smoke"
  echo "removed $smoke"
}

cmd_url() {
  local smoke port
  smoke="$(canonical_dir "${1:-${PREVIEW_DAEMON_DIR:-}}")" || exit $?
  NODE_BIN="$(resolve_node_dir)" || die "no Node 22 found" 1
  port="$(rec "$smoke" port)" || die "preview.json has no port" 1
  echo "http://127.0.0.1:$port"
}

cmd_status() {
  local smoke pid port head listener rc health=down
  smoke="$(canonical_dir "${1:-${PREVIEW_DAEMON_DIR:-}}")" || exit $?
  NODE_BIN="$(resolve_node_dir)" || die "no Node 22 found" 1
  [ -f "$smoke/preview.json" ] || die "no preview.json in $smoke" 1
  pid="$(rec "$smoke" pid)"; port="$(rec "$smoke" port)"; head="$(rec "$smoke" head)"
  pid_ownership "$pid" "$smoke"; rc=$?
  listener="$(port_listener_pids "$port" | head -1)"
  curl -fsS --max-time 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1 && health=ok
  echo "smoke:    $smoke"
  echo "pid:      $pid ($([ "$rc" -eq 0 ] && echo alive || echo "not running or not ours"))"
  echo "port:     $port (listener pid: ${listener:-none})"
  echo "head:     $head"
  echo "health:   $health"
  [ "$rc" -eq 0 ] && [ "$listener" = "$pid" ] && [ "$health" = ok ]
}

cmd_start() {
  local expect_head='' head parent smoke port token cfg log pid i timeout cli rc
  while [ $# -gt 0 ]; do
    case "$1" in
      --expect-head) [ $# -ge 2 ] || usage; expect_head="$2"; shift 2 ;;
      *) usage ;;
    esac
  done

  NODE_BIN="$(resolve_node_dir)" || die "no Node 22 found (install node@22 or set PREVIEW_DAEMON_NODE_DIR)" 1
  head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || die "cannot read git HEAD of $ROOT" 1
  if [ -n "$expect_head" ]; then
    case "$expect_head" in ''|*[!0-9a-fA-F]*) die "--expect-head must be a hex sha: $expect_head" 2 ;; esac
    [ "${#expect_head}" -ge 7 ] || die "--expect-head needs at least 7 hex chars" 2
    case "$head" in
      "$expect_head"*) ;;
      *) die "REFUSING: HEAD is $head, expected $expect_head" 3 ;;
    esac
  fi

  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not a directory" 1
  local home_real; home_real="$(cd "$HOME" && pwd -P)"
  parent="${PREVIEW_DAEMON_PARENT:-$HOME/chroxy-previews}"
  mkdir -p -- "$parent" || die "cannot create $parent" 1
  parent="$(cd "$parent" && pwd -P)"
  case "$parent/" in
    "$home_real"/*) ;;
    *) die "scratch parent $parent is not under \$HOME ($home_real); Browse could not list it" 2 ;;
  esac

  cli="${PREVIEW_DAEMON_CLI:-$ROOT/packages/server/src/cli.js}"
  [ -f "$cli" ] || die "daemon entry point not found: $cli" 1
  port="$(pick_port)"; rc=$?
  [ "$rc" -eq 0 ] && [ -n "$port" ] || die "port selection failed (rc=$rc)" "$([ "$rc" -eq 2 ] && echo 2 || echo 1)"
  case "$port" in 8765) die "port 8765 selected; refusing" 2 ;; esac

  if [ "${PREVIEW_DAEMON_SKIP_BUILD:-0}" != 1 ]; then
    echo "building protocol + dashboard at $head ..." >&2
    ( cd "$ROOT" && PATH="$NODE_BIN:$PATH" npm run build -w @chroxy/protocol >&2 \
        && PATH="$NODE_BIN:$PATH" npm run build -w @chroxy/dashboard >&2 ) \
      || die "build failed" 1
  fi

  smoke="$(mktemp -d "$parent/${MARKER}XXXXXX")" || die "mktemp failed" 1
  smoke="$(cd "$smoke" && pwd -P)"
  mkdir -p "$smoke/config" "$smoke/home" "$smoke/tmp" "$smoke/fixture" || die "mkdir failed" 1

  # Fixture repo: one committed file, no dependence on the caller's git config.
  ( cd "$smoke/fixture" \
    && git init -q . \
    && echo "# preview fixture" > README.md \
    && git add README.md \
    && git -c user.name=preview -c user.email=preview@localhost -c commit.gpgsign=false commit -q -m "fixture" ) \
    >/dev/null 2>&1 || { rm -rf -- "$smoke"; die "could not create the fixture repo" 1; }

  token="$("$NODE_BIN/node" -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
  cfg="$smoke/config/config.json"
  ( umask 077
    "$NODE_BIN/node" -e '
      const [, cfg, token, port, fixture] = process.argv
      require("fs").writeFileSync(cfg, JSON.stringify({
        apiToken: token,
        port: Number(port),
        host: "127.0.0.1",
        tunnel: "none",
        cwd: fixture,
        workspaceRoots: [fixture],
        sessionCi: { watch: false },
        controlRoomRunnerIncludeGithub: false,
      }, null, 2) + "\n", { mode: 0o600 })' "$cfg" "$token" "$port" "$smoke/fixture" ) \
    || { rm -rf -- "$smoke"; die "could not write config.json" 1; }
  chmod 600 "$cfg"

  log="$smoke/daemon.log"
  # The allowlist. `env -i` empties the environment; only these names exist in
  # the daemon. Do NOT turn this into an `env -u` denylist (#8305).
  nohup env -i \
    HOME="$smoke/home" \
    USER="${USER:-preview}" \
    TERM="${TERM:-dumb}" \
    LANG="${LANG:-en_US.UTF-8}" \
    TMPDIR="$smoke/tmp" \
    PATH="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
    CHROXY_CONFIG_DIR="$smoke/config" \
    CHROXY_DISABLE_KEYCHAIN=1 \
    CHROXY_CRED_DISABLE_KEYCHAIN=1 \
    "$NODE_BIN/node" "$cli" start -c "$cfg" --tunnel none --skip-checks --no-supervisor --host 127.0.0.1 \
    </dev/null >"$log" 2>&1 &
  pid=$!

  fail_start() {
    echo "preview-daemon: start failed: $1" >&2
    echo "--- last log lines ---" >&2
    tail -n 20 "$log" 2>/dev/null | sed -E 's/[0-9a-f]{32,}/<redacted>/g' >&2
    if pid_ownership "$pid" "$smoke"; then
      kill -TERM "$pid" 2>/dev/null || true
      i=0; while [ "$i" -lt 50 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.2; i=$((i + 1)); done
    fi
    # A survivor of SIGTERM keeps the dir (and token) so it can be inspected
    # and stopped; do not delete the directory under a live process.
    if kill -0 "$pid" 2>/dev/null; then
      echo "preview-daemon: pid $pid survived SIGTERM; leaving $smoke in place" >&2
    else
      rm -rf -- "$smoke"
    fi
    exit 1
  }

  timeout="${PREVIEW_DAEMON_HEALTH_TIMEOUT:-60}"
  i=0
  until curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
    kill -0 "$pid" 2>/dev/null || fail_start "daemon exited before /health answered"
    i=$((i + 1))
    [ "$i" -le $((timeout * 5)) ] || fail_start "/health did not answer within ${timeout}s"
    sleep 0.2
  done

  # Assertion 1: the daemon opened OUR config root.
  grep -qF "Config/state root: $smoke/config" "$log" \
    || fail_start "log does not name Config/state root: $smoke/config"
  # Assertion 2: not the production port, and it is the one we picked.
  is_banned_port "$port" && fail_start "port $port is reserved"
  # Assertion 3: the listener on the port is the process we launched ($!).
  local listeners; listeners="$(port_listener_pids "$port")"
  [ "$listeners" = "$pid" ] \
    || fail_start "listener on :$port is [${listeners:-none}], not the launched pid $pid"

  "$NODE_BIN/node" -e '
    const [, out, pid, port, configDir, fixture, head] = process.argv
    require("fs").writeFileSync(out, JSON.stringify({
      pid: Number(pid), port: Number(port), configDir, fixture, head,
    }, null, 2) + "\n")' "$smoke/preview.json" "$pid" "$port" "$smoke/config" "$smoke/fixture" "$head" \
    || fail_start "could not write preview.json"

  echo "SMOKE=$smoke"
  echo "URL=http://127.0.0.1:$port"
  echo "HEAD=$head"
}

case "${1:-}" in
  start)  shift; cmd_start "$@" ;;
  url)    shift; cmd_url "$@" ;;
  status) shift; cmd_status "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  clean)  shift; cmd_clean "$@" ;;
  *)      usage ;;
esac
