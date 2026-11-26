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
#   scripts/preview-daemon.sh start [--expect-head <sha>] [--config-patch <file.json>]
#                                   [--stub-provider <port>] [--stub-acp]
#       Prints SMOKE=<dir>, URL=<origin> and HEAD=<sha>. Pass the SMOKE dir to
#       the other subcommands (or export PREVIEW_DAEMON_DIR).
#       --config-patch  deep-merges a JSON object into the scratch config.json
#                       before launch (objects merge, arrays and scalars replace).
#                       ALLOWLIST, fail closed: only these TOP-LEVEL keys may be
#                       set; any other key (apiToken, port, host, tunnel, noAuth,
#                       dangerouslySkipPermissions, externalUrl, mcpServers,
#                       codexBinary, notifications, ...) is refused with exit 2
#                       before anything is created. Only top-level keys and the
#                       providers rules are inspected.
#                         providers  register stub/proxy endpoints (object form; only
#                                    providers.anthropicCompatible, an array of HTTP
#                                    endpoint entries; entry fields limited to id label
#                                    baseUrl defaultModel models pricing contextWindow.
#                                    apiKeyEnv/credentialsKey (credentials) and
#                                    modelDiscovery are refused: a keyless stub needs none)
#                         provider   which registered provider new sessions default to
#                         model      the default model name
#                       A baseUrl to a real API is an explicit opt-in: it only
#                       egresses; no key reaches the daemon (env -i), so keyless.
#       --stub-provider registers a keyless providers.anthropicCompatible entry
#                       named smoke-stub at http://127.0.0.1:<port> (appended after
#                       any --config-patch entries). The stub server is yours to run.
#       --stub-acp      registers a keyless providers.acp entry, id smoke-acp, that
#                       spawns this checkout's scripted ACP agent
#                       (packages/server/tests/fixtures/fake-acp-agent.js) with the
#                       resolved Node binary, both as absolute paths. No network, no
#                       credentials. Unlike smoke-stub (a BYOK session, which refuses
#                       mid-turn input) an ACP session QUEUES input sent while a turn
#                       runs, so queued badges, the auto-flush and Stop discarding
#                       queued follow-ups (message_dequeued reason interrupted) can
#                       be smoked. It is registered, not selected: pass
#                       --config-patch with {"provider":"smoke-acp"} (or create the
#                       session with provider smoke-acp). To hold a turn busy, send a
#                       prompt containing HANG_UNTIL_CANCEL; the agent then waits
#                       until session/cancel (Stop). Queue follow-ups, then press
#                       Stop only once the held turn shows as busy: the agent arms
#                       its cancel wait when it receives the prompt, and a cancel
#                       that arrives earlier is ignored (the turn then hangs). Any other prompt streams a short reply and ends. A
#                       --config-patch still cannot set providers.acp; only this
#                       flag registers it, and only this fixture. Refused (exit 2,
#                       nothing created) if the fixture file is missing.
#   scripts/preview-daemon.sh url    <smoke-dir>   print the daemon origin
#   scripts/preview-daemon.sh status <smoke-dir>   exit 0 only if it is up and healthy
#   scripts/preview-daemon.sh stop   <smoke-dir>   SIGTERM the recorded PID, PID-guarded
#   scripts/preview-daemon.sh clean  <smoke-dir>   stop, then remove the dir (it holds the token)
#   scripts/preview-daemon.sh sweep  [--dry-run] [--force]   reap ABANDONED previews (#8742)
#       Looks at every preview dir directly under the previews root. AGE is what
#       reaps automatically: a preview older than PREVIEW_DAEMON_MAX_AGE seconds
#       (default 21600, 6 h) is stopped (PID-guarded) and removed. A preview whose
#       recorded daemon PID is not running is just removed (nothing is signalled).
#       The recorded LAUNCHER (launcher_pid + launcher_started in preview.json) is
#       ADVISORY only: it is the immediate parent of `start`, which is often a
#       short-lived shell (every agent tool call is its own shell; `$(...)` and
#       pipes fork a subshell that exits when start returns), so a gone launcher
#       does not prove the run is over. By default a gone or PID-reused launcher is
#       only REPORTED. --force additionally stops+removes such a preview, but only
#       once it is at least PREVIEW_DAEMON_FORCE_MIN_AGE seconds old (default 1800,
#       30 min), so even a forced sweep cannot reap a smoke that just started.
#       Records without launcher fields are only ever reaped by age or a dead
#       daemon (their age is the preview.json mtime). If the recorded PID now
#       belongs to ANOTHER process the preview is dead: it is reported, and once
#       stale (older than max age, or --force past the grace with a gone launcher)
#       its dir is removed WITHOUT signalling anything. Stops only go through the
#       PID-guarded stop. One line per preview; exit 0 if all were handled, 4 if a
#       stop was refused, 1 on any other failure. --dry-run changes nothing.
#       `start` does NOT sweep on its own.
#
# Then:  node packages/server/tests/smoke-test.mjs --preview <smoke-dir>/preview.json
#
# Smoke recipe with a keyless stub provider (no credentials, no CLI wrapper):
#   node my-stub.mjs 18470 &                       # any Anthropic /v1/messages SSE stub
#   scripts/preview-daemon.sh start --stub-provider 18470   # -> SMOKE=<dir>
#   # create a session with provider "smoke-stub" over WS or the dashboard, send a turn
#   scripts/preview-daemon.sh clean <dir>; kill %1
# Or hand-roll the overlay:  --config-patch patch.json  where patch.json is
#   {"providers":{"anthropicCompatible":[{"id":"smoke-stub","label":"smoke-stub",
#     "baseUrl":"http://127.0.0.1:18470","defaultModel":"stub","models":["stub"]}]}}
#
# Exit codes: 0 ok, 1 failure, 2 usage / refused configuration,
#             3 --expect-head mismatch, 4 stop/clean refused (PID is not ours;
#             for sweep: any preview's stop was refused).
#
# Safety properties (each is proven by scripts/__tests__/preview-daemon.test.sh):
#   - The daemon starts under `env -i` with an ALLOWLIST (HOME USER TERM LANG
#     TMPDIR PATH CHROXY_CONFIG_DIR CHROXY_DISABLE_KEYCHAIN
#     CHROXY_CRED_DISABLE_KEYCHAIN). Nothing the caller exported reaches it.
#   - Keychain access is off in both layers; HOME is a fixture dir under the
#     scratch dir, so nothing reads the real ~/.claude or ~/.chroxy.
#   - The daemon's PATH is a node-only symlink dir under $SMOKE plus
#     /usr/bin:/bin:/usr/sbin:/sbin, so gh/claude/codex (which keep their own
#     login-keychain items that CHROXY_*_DISABLE_KEYCHAIN does not cover) are not
#     reachable. RESIDUAL: a CLI installed under /usr/bin or /bin is still on
#     PATH, and a smoke that genuinely needs a provider CLI must get an explicit
#     opt-in flag, never the default.
#   - It never uses port 8765, 3131, 8080 or 3000. The port is picked just before
#     launch, from 20000-31999 (below the Linux 32768+ and macOS 49152+ ephemeral
#     ranges), and must be free.
#   - An interrupted or failed `start` kills the daemon it launched and removes
#     the scratch dir (it holds the token) via an EXIT/INT/TERM trap.
#   - stop only signals the recorded PID after `ps` shows the exact launched
#     command shape (`start -c $SMOKE/config/config.json`) for that process. Never a pattern kill, never SIGKILL.
#   - clean refuses to remove anything that is not a dir this script created,
#     directly under the previews root ($PREVIEW_DAEMON_PARENT or
#     $HOME/chroxy-previews; pass the same env as at start).
#   - --expect-head also refuses a tree with tracked modifications: the preview
#     serves the working tree, so a dirty tree would make the head label a lie.
#
#   - A --config-patch can never weaken the isolation: the guarded keys above are
#     refused up front (top-level key presence, however nested the value), and
#     the patched config is rewritten mode 0600. When unsure a key is guarded.
#
# Test hooks (not for normal use): PREVIEW_DAEMON_CLI (daemon entry point),
# PREVIEW_DAEMON_PORT (fixed port), PREVIEW_DAEMON_SKIP_BUILD=1,
# PREVIEW_DAEMON_HEALTH_TIMEOUT (seconds), PREVIEW_DAEMON_PARENT,
# PREVIEW_DAEMON_NODE_DIR, PREVIEW_DAEMON_LAUNCHER_PID (record this PID as the
# launcher instead of the script's parent; use when `start` runs under a
# short-lived wrapper), PREVIEW_DAEMON_MAX_AGE (sweep max age, seconds),
# PREVIEW_DAEMON_FORCE_MIN_AGE (sweep --force grace, seconds).

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

# A missing lsof must never read as "port free": refuse up front.
preflight() {
  local t missing=''
  for t in lsof curl git ps; do
    command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
  done
  [ -z "$missing" ] || die "required tool(s) not on PATH:$missing" 1
}

port_listener_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

is_banned_port() {
  local p
  for p in $BANNED_PORTS; do [ "$1" = "$p" ] && return 0; done
  return 1
}

# Validate the test-hook override early (before anything is created).
validate_port_override() {
  [ -n "${PREVIEW_DAEMON_PORT:-}" ] || return 0
  case "$PREVIEW_DAEMON_PORT" in ''|*[!0-9]*) die "PREVIEW_DAEMON_PORT is not a number: $PREVIEW_DAEMON_PORT" 2 ;; esac
  is_banned_port "$PREVIEW_DAEMON_PORT" && die "port $PREVIEW_DAEMON_PORT is reserved (production/common dev port); refusing" 2
  return 0
}

# Called immediately before launch, so the window between "free" and "bound" is
# as small as it can be. Range 20000-31999 avoids both ephemeral ranges.
pick_port() {
  local p tries=0
  if [ -n "${PREVIEW_DAEMON_PORT:-}" ]; then
    p="$PREVIEW_DAEMON_PORT"
    [ -z "$(port_listener_pids "$p")" ] || die "port $p already has a listener; refusing" 2
    echo "$p"; return 0
  fi
  while [ "$tries" -lt 50 ]; do
    p=$((20000 + RANDOM % 12000))
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
# Ours means the exact launched shape, not merely a command line mentioning the dir.
pid_ownership() {
  local pid="$1" smoke="$2" cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *" start -c $smoke/config/config.json "*) return 0 ;;
    *) return 4 ;;
  esac
}

# Start time of a process as ps prints it (1 s resolution), whitespace-normalised;
# empty when the process does not exist. Used to tell a launcher from a later
# process that reused its PID.
proc_lstart() {
  ps -o lstart= -p "$1" 2>/dev/null | sed -e 's/^ *//' -e 's/ *$//' -e 's/  */ /g'
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
    die "REFUSING to stop pid $pid: its command line is not \"start -c $smoke/config/config.json\" (stale pid reused by another process?). Nothing was killed." 4
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

# Refuse (exit 4) unless $1 (a canonical path) is a dir this script created,
# directly under the previews root. Shared by clean and the sweep's no-signal remove.
guard_removable() {
  local smoke="$1" base
  base="$(basename "$smoke")"
  case "$base" in "$MARKER"*) ;; *) die "REFUSING to remove $smoke: not a $MARKER* dir" 4 ;; esac
  [ -f "$smoke/preview.json" ] && [ -d "$smoke/config" ] \
    || die "REFUSING to remove $smoke: no preview.json/config (not created by this script)" 4
  local want_parent; want_parent="$(cd "${PREVIEW_DAEMON_PARENT:-${HOME:-/nonexistent}/chroxy-previews}" 2>/dev/null && pwd -P)" \
    || die "REFUSING to remove $smoke: the previews root does not exist" 4
  [ "$(dirname "$smoke")" = "$want_parent" ] \
    || die "REFUSING to remove $smoke: not directly under the previews root $want_parent" 4
}

cmd_clean() {
  local smoke
  smoke="$(canonical_dir "${1:-${PREVIEW_DAEMON_DIR:-}}")" || exit $?
  guard_removable "$smoke"
  cmd_stop "$smoke"   # exits non-zero (leaving $smoke) if the daemon cannot be stopped
  rm -rf -- "$smoke"
  echo "removed $smoke"
}

# Remove a preview dir whose daemon is already gone, signalling NOTHING (the
# recorded PID now belongs to another process). Same removal guards as clean.
cmd_remove_dead() {
  local smoke
  smoke="$(canonical_dir "${1:-}")" || exit $?
  guard_removable "$smoke"
  rm -rf -- "$smoke"
  echo "removed $smoke"
}

# Reap abandoned previews (#8742). Only ever acts on dirs directly under the
# previews root that carry a preview.json; stops only via cmd_stop's PID guard.
cmd_sweep() {
  local dry=0 force=0 minage parent d name pid lp ls_rec started now age maxage cur action reason rc out worst=0 n=0 dstate lgone stale forceable note
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1; shift ;;
      --force) force=1; shift ;;
      *) usage ;;
    esac
  done
  maxage="${PREVIEW_DAEMON_MAX_AGE:-21600}"
  case "$maxage" in ''|*[!0-9]*) die "PREVIEW_DAEMON_MAX_AGE is not a number: $maxage" 2 ;; esac
  [ "$maxage" -ge 1 ] || die "PREVIEW_DAEMON_MAX_AGE must be at least 1: $maxage" 2
  minage="${PREVIEW_DAEMON_FORCE_MIN_AGE:-1800}"
  case "$minage" in ''|*[!0-9]*) die "PREVIEW_DAEMON_FORCE_MIN_AGE is not a number: $minage" 2 ;; esac
  [ "$minage" -ge 1 ] || die "PREVIEW_DAEMON_FORCE_MIN_AGE must be at least 1: $minage" 2
  NODE_BIN="$(resolve_node_dir)" || die "no Node 22 found (set PREVIEW_DAEMON_NODE_DIR)" 1
  parent="${PREVIEW_DAEMON_PARENT:-${HOME:-/nonexistent}/chroxy-previews}"
  if [ ! -d "$parent" ]; then echo "no previews root at $parent; nothing to sweep"; return 0; fi
  parent="$(cd "$parent" && pwd -P)" || die "cannot enter $parent" 1
  now="$(date +%s)"

  for d in "$parent/$MARKER"*; do
    [ -e "$d" ] || [ -L "$d" ] || continue
    name="$(basename "$d")"
    if [ -L "$d" ]; then echo "$name: skip (symlink; never touched)"; continue; fi
    [ -d "$d" ] || continue
    if [ ! -f "$d/preview.json" ]; then echo "$name: skip (no preview.json)"; continue; fi
    n=$((n + 1))
    pid="$(rec "$d" pid 2>/dev/null)"
    case "$pid" in ''|*[!0-9]*) echo "$name: FAILED (preview.json has no usable pid; not touching it)"; [ "$worst" -eq 4 ] || worst=1; continue ;; esac

    # Age: started_at (epoch s), else the record's mtime for legacy files.
    started="$(rec "$d" started_at 2>/dev/null)"
    case "$started" in ''|*[!0-9]*) started="$("$NODE_BIN/node" -e 'process.stdout.write(String(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs/1000)))' "$d/preview.json" 2>/dev/null)" ;; esac
    case "$started" in ''|*[!0-9]*) started="$now" ;; esac
    age=$((now - started))

    pid_ownership "$pid" "$d"; dstate=$?
    action=''; reason=''; lgone=''
    lp="$(rec "$d" launcher_pid 2>/dev/null)"; ls_rec="$(rec "$d" launcher_started 2>/dev/null)"
    case "$lp" in ''|*[!0-9]*) lp='' ;; esac
    # The launcher is ADVISORY (the immediate parent of start, often a short-lived
    # shell): a gone one is reported, never grounds for a signal by itself.
    if [ -n "$lp" ] && [ -n "$ls_rec" ]; then
      cur="$(proc_lstart "$lp")"
      if [ -z "$cur" ]; then lgone="launcher pid $lp is gone"
      elif [ "$cur" != "$ls_rec" ]; then lgone="launcher pid $lp was reused (started \"$cur\", recorded \"$ls_rec\")"
      fi
    fi
    stale=0; [ "$age" -gt "$maxage" ] && stale=1
    forceable=0; [ "$force" -eq 1 ] && [ -n "$lgone" ] && [ "$age" -ge "$minage" ] && forceable=1
    if [ "$dstate" -eq 1 ]; then
      action="clean"; reason="daemon pid $pid is not running"
    elif [ "$dstate" -eq 4 ]; then
      note="daemon pid $pid now belongs to another process; the preview is dead"
      if [ "$stale" -eq 1 ]; then action="remove"; reason="$note; older than max age (${age}s > ${maxage}s)"
      elif [ "$forceable" -eq 1 ]; then action="remove"; reason="$note; $lgone, --force past ${minage}s"
      else echo "$name: report: $note (dir kept until older than ${maxage}s, age ${age}s)"; continue; fi
    elif [ "$stale" -eq 1 ]; then
      action="stop+clean"; reason="older than max age (${age}s > ${maxage}s)"
    elif [ "$forceable" -eq 1 ]; then
      action="stop+clean"; reason="$lgone, --force past ${minage}s (age ${age}s)"
    elif [ -n "$lgone" ]; then
      if [ "$force" -eq 1 ]; then echo "$name: report: $lgone; --force grace not reached (age ${age}s < ${minage}s); kept"
      else echo "$name: report: $lgone (advisory; pass --force to stop+clean once older than ${minage}s); kept"; fi
      continue
    else
      if [ -n "$lp" ] && [ -n "$ls_rec" ]; then echo "$name: keep (launcher pid $lp alive, age ${age}s <= ${maxage}s)"
      else echo "$name: keep (legacy record without launcher fields; daemon alive, age ${age}s <= ${maxage}s)"; fi
      continue
    fi

    if [ "$dry" -eq 1 ]; then echo "$name: would $action ($reason)"; continue; fi
    if [ "$action" = remove ]; then out="$( ( cmd_remove_dead "$d" ) 2>&1 )"; rc=$?
    else out="$( ( cmd_clean "$d" ) 2>&1 )"; rc=$?; fi
    if [ "$rc" -eq 0 ]; then
      echo "$name: $action ($reason): ok"
    else
      echo "$name: $action ($reason): FAILED rc=$rc: $(printf '%s' "$out" | tail -n 1)"
      if [ "$rc" -eq 4 ]; then worst=4; elif [ "$worst" -ne 4 ]; then worst=1; fi
    fi
  done
  [ "$n" -gt 0 ] || echo "no previews to sweep under $parent"
  return "$worst"
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

# State for the EXIT/INT/TERM trap armed by cmd_start.
SMOKE_G=''
PID_G=''
START_OK=0

cleanup_start() {
  [ "$START_OK" = 1 ] && return 0
  [ -n "$SMOKE_G" ] || return 0
  local i=0
  if [ -n "$PID_G" ] && pid_ownership "$PID_G" "$SMOKE_G"; then
    kill -TERM "$PID_G" 2>/dev/null || true
    while [ "$i" -lt 50 ] && kill -0 "$PID_G" 2>/dev/null; do sleep 0.2; i=$((i + 1)); done
  fi
  # A survivor of SIGTERM keeps the dir (and token) so it can be inspected and
  # stopped; never delete the directory under a live process.
  if [ -n "$PID_G" ] && kill -0 "$PID_G" 2>/dev/null; then
    echo "preview-daemon: pid $PID_G survived SIGTERM; leaving $SMOKE_G in place" >&2
  else
    rm -rf -- "$SMOKE_G"
  fi
}

# ALLOWLIST of top-level keys a --config-patch may set (fail closed, #9189). A
# denylist beside a growing config schema is the false-safety shape: every new
# escape key (noAuth, *SkipPermissions, externalUrl, mcpServers, *Binary ...)
# would be silently allowed. Add a key here only with a reason (see usage text).
ALLOWED_KEYS="providers provider model"
# Fields a providers.anthropicCompatible entry may set. apiKeyEnv, credentialsKey
# (credentials) and modelDiscovery (network discovery against the endpoint) are
# deliberately absent: a keyless smoke stub needs neither.
ALLOWED_ENTRY_FIELDS="id label baseUrl defaultModel models pricing contextWindow"

# Validate a patch file: readable, valid JSON, a plain object, only allowlisted
# top-level keys, and only allowlisted fields on each provider entry. Every refusal
# names its cause (the offending key, field or entry index) on stderr, exit 2.
check_patch() {
  [ -f "$1" ] || die "--config-patch file not found: $1" 2
  "$NODE_BIN/node" -e '
    const [, f, allowed, ALLOWED_ENTRY] = process.argv
    let v
    try { v = JSON.parse(require("fs").readFileSync(f, "utf8")) }
    catch (e) { console.error("preview-daemon: --config-patch is not valid JSON: " + e.message); process.exit(2) }
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      console.error("preview-daemon: --config-patch must be a JSON object"); process.exit(2) }
    const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x)
    const refuse = m => { console.error("preview-daemon: REFUSING --config-patch: " + m); process.exit(2) }
    const ok = allowed.split(" ")
    const bad = Object.keys(v).filter(k => !ok.includes(k))
    if (bad.length) refuse("key(s) not in the allowlist (" + ok.join(", ") + "): " + bad.join(", "))
    if ("provider" in v && typeof v.provider !== "string") refuse("provider must be a string")
    if ("model" in v && typeof v.model !== "string") refuse("model must be a string")
    if ("providers" in v) {
      if (!isObj(v.providers)) refuse("providers must be an object")
      const pk = Object.keys(v.providers).filter(k => k !== "anthropicCompatible")
      if (pk.length) refuse("providers may only contain anthropicCompatible, not: " + pk.join(", "))
      const list = v.providers.anthropicCompatible
      if (list !== undefined && !Array.isArray(list)) refuse("providers.anthropicCompatible must be an array")
      const fields = ALLOWED_ENTRY.split(" ")
      for (const [n, e] of (list || []).entries()) {
        if (!isObj(e)) refuse("providers.anthropicCompatible[" + n + "] must be an object")
        const xs = Object.keys(e).filter(k => !fields.includes(k))
        if (xs.length) refuse("providers.anthropicCompatible[" + n + "] field(s) not in the entry allowlist (" + fields.join(", ") + "): " + xs.join(", "))
      }
    }' \
    "$1" "$ALLOWED_KEYS" "$ALLOWED_ENTRY_FIELDS" || exit 2
}

cmd_start() {
  local expect_head='' head parent smoke port token cfg log pid timeout cli rc deadline patch='' stub_port='' stub_acp=0 acp_fixture=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --expect-head) [ $# -ge 2 ] || usage; expect_head="$2"; shift 2 ;;
      --config-patch) [ $# -ge 2 ] || usage; patch="$2"; shift 2 ;;
      --stub-provider) [ $# -ge 2 ] || usage; stub_port="$2"; shift 2 ;;
      --stub-acp) stub_acp=1; shift ;;
      *) usage ;;
    esac
  done
  if [ -n "$stub_port" ]; then
    case "$stub_port" in ''|*[!0-9]*) die "--stub-provider needs a port number: $stub_port" 2 ;; esac
    [ "$stub_port" -ge 1 ] && [ "$stub_port" -le 65535 ] || die "--stub-provider port out of range: $stub_port" 2
  fi

  timeout="${PREVIEW_DAEMON_HEALTH_TIMEOUT:-60}"
  case "$timeout" in ''|*[!0-9]*) die "PREVIEW_DAEMON_HEALTH_TIMEOUT is not a number: $timeout" 2 ;; esac
  validate_port_override
  NODE_BIN="$(resolve_node_dir)" || die "no Node 22 found (install node@22 or set PREVIEW_DAEMON_NODE_DIR)" 1
  [ -z "$patch" ] || check_patch "$patch"
  if [ "$stub_acp" -eq 1 ]; then
    acp_fixture="$ROOT/packages/server/tests/fixtures/fake-acp-agent.js"
    [ -f "$acp_fixture" ] || die "--stub-acp: fixture not found: $acp_fixture" 2
  fi
  head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || die "cannot read git HEAD of $ROOT" 1
  if [ -n "$expect_head" ]; then
    case "$expect_head" in ''|*[!0-9a-fA-F]*) die "--expect-head must be a hex sha: $expect_head" 2 ;; esac
    [ "${#expect_head}" -ge 7 ] || die "--expect-head needs at least 7 hex chars" 2
    case "$head" in
      "$expect_head"*) ;;
      *) die "REFUSING: HEAD is $head, expected $expect_head" 3 ;;
    esac
    [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ] \
      || die "REFUSING: HEAD matches but the tree has tracked modifications; the preview would not be $expect_head" 3
  fi

  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not a directory" 1
  local home_real; home_real="$(cd "$HOME" && pwd -P)"
  parent="${PREVIEW_DAEMON_PARENT:-$HOME/chroxy-previews}"
  mkdir -p -- "$parent" || die "cannot create $parent" 1
  parent="$(cd "$parent" && pwd -P)" || die "cannot enter $parent" 1
  case "$parent/" in
    "$home_real"/*) ;;
    *) die "scratch parent $parent is not under \$HOME ($home_real); Browse could not list it" 2 ;;
  esac

  cli="${PREVIEW_DAEMON_CLI:-$ROOT/packages/server/src/cli.js}"
  [ -f "$cli" ] || die "daemon entry point not found: $cli" 1

  if [ "${PREVIEW_DAEMON_SKIP_BUILD:-0}" != 1 ]; then
    echo "building protocol + dashboard at $head ..." >&2
    ( cd "$ROOT" && PATH="$NODE_BIN:$PATH" npm run build -w @chroxy/protocol >&2 \
        && PATH="$NODE_BIN:$PATH" npm run build -w @chroxy/dashboard >&2 ) \
      || die "build failed" 1
  fi

  # From here on, anything that goes wrong or interrupts us removes the scratch
  # dir (it holds the token) and the daemon we launched.
  trap cleanup_start EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  smoke="$(mktemp -d "$parent/${MARKER}XXXXXX")" || die "mktemp failed" 1
  SMOKE_G="$smoke"
  smoke="$(cd "$smoke" && pwd -P)" || die "cannot enter $smoke" 1
  SMOKE_G="$smoke"
  mkdir -p "$smoke/config" "$smoke/home" "$smoke/tmp" "$smoke/fixture" "$smoke/bin" || die "mkdir failed" 1

  # Fixture repo: one committed file. Ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/
  # GIT_CONFIG_PARAMETERS (git hooks, `rebase -x`) would aim these calls at the
  # CALLER's repo, so every repo-local variable git knows is unset first. The caller's git config (hooks, signing,
  # templates, identity) must not apply, so global/system config is switched off.
  ( cd "$smoke/fixture" \
    && local_env="$(git rev-parse --local-env-vars)" && [ -n "$local_env" ] \
    && unset $local_env XDG_CONFIG_HOME \
    && export HOME="$smoke/home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    && git -c init.templateDir= init -q . \
    && echo "# preview fixture" > README.md \
    && git add README.md \
    && git -c core.hooksPath=/dev/null -c user.name=preview -c user.email=preview@localhost \
         -c commit.gpgsign=false commit -q --no-verify -m "fixture" ) \
    >/dev/null 2>&1 || die "could not create the fixture repo" 1

  # Node-only PATH dir: node (and npm/npx when present), nothing else.
  local t
  for t in node npm npx; do
    [ -e "$NODE_BIN/$t" ] && ln -s "$NODE_BIN/$t" "$smoke/bin/$t"
  done
  [ -x "$smoke/bin/node" ] || die "could not link node into $smoke/bin" 1

  # The port is chosen as late as possible, right before launch.
  port="$(pick_port)"; rc=$?
  [ "$rc" -eq 0 ] && [ -n "$port" ] || exit "$([ "$rc" -eq 2 ] && echo 2 || echo 1)"
  case "$port" in 8765) die "port 8765 selected; refusing" 2 ;; esac

  token="$("$NODE_BIN/node" -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')" \
    || die "could not generate a token" 1
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
    || die "could not write config.json" 1
  chmod 600 "$cfg"

  # Overlay: deep-merge the (already validated) patch, then the stub provider.
  # Written through a temp file in the same 0600 dir, then renamed and re-chmodded.
  if [ -n "$patch" ] || [ -n "$stub_port" ] || [ "$stub_acp" -eq 1 ]; then
    ( umask 077
      "$NODE_BIN/node" -e '
        const fs = require("fs")
        const [, cfg, patch, stub, acpFixture, acpNode] = process.argv
        const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v)
        const merge = (a, b) => { for (const k of Object.keys(b)) {
          if (k === "__proto__") continue
          a[k] = isObj(a[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k] } return a }
        const c = JSON.parse(fs.readFileSync(cfg, "utf8"))
        if (patch) merge(c, JSON.parse(fs.readFileSync(patch, "utf8")))
        if (stub) {
          c.providers = isObj(c.providers) ? c.providers : {}
          const list = Array.isArray(c.providers.anthropicCompatible) ? c.providers.anthropicCompatible : []
          c.providers.anthropicCompatible = list.filter(e => !e || e.id !== "smoke-stub").concat([{
            id: "smoke-stub", label: "smoke-stub", baseUrl: "http://127.0.0.1:" + stub,
            defaultModel: "stub", models: ["stub"] }])
        }
        if (acpFixture) {
          c.providers = isObj(c.providers) ? c.providers : {}
          const list = Array.isArray(c.providers.acp) ? c.providers.acp : []
          c.providers.acp = list.filter(e => !e || e.id !== "smoke-acp").concat([{
            id: "smoke-acp", label: "Smoke ACP stub", command: acpNode, args: [acpFixture] }])
        }
        fs.writeFileSync(cfg + ".tmp", JSON.stringify(c, null, 2) + "\n", { mode: 0o600 })
        fs.renameSync(cfg + ".tmp", cfg)' "$cfg" "$patch" "$stub_port" "$acp_fixture" "$NODE_BIN/node" ) \
      || die "could not apply the config overlay" 1
    chmod 600 "$cfg"
  fi

  log="$smoke/daemon.log"
  # The allowlist. `env -i` empties the environment; only these names exist in
  # the daemon. Do NOT turn this into an `env -u` denylist (#8305).
  nohup env -i \
    HOME="$smoke/home" \
    USER="${USER:-preview}" \
    TERM="${TERM:-dumb}" \
    LANG="${LANG:-en_US.UTF-8}" \
    TMPDIR="$smoke/tmp" \
    PATH="$smoke/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    CHROXY_CONFIG_DIR="$smoke/config" \
    CHROXY_DISABLE_KEYCHAIN=1 \
    CHROXY_CRED_DISABLE_KEYCHAIN=1 \
    "$NODE_BIN/node" "$cli" start -c "$cfg" --tunnel none --skip-checks --no-supervisor --host 127.0.0.1 \
    </dev/null >"$log" 2>&1 &
  pid=$!
  PID_G="$pid"

  fail_start() {
    echo "preview-daemon: start failed: $1" >&2
    echo "--- last log lines ---" >&2
    tail -n 20 "$log" 2>/dev/null | sed -E 's/[0-9a-f]{32,}/<redacted>/g' >&2
    exit 1   # the EXIT trap kills the daemon and removes $smoke
  }

  deadline=$((SECONDS + timeout))
  until curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
    kill -0 "$pid" 2>/dev/null || fail_start "daemon exited before /health answered"
    [ "$SECONDS" -lt "$deadline" ] || fail_start "/health did not answer within ${timeout}s"
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

  # Launcher identity for `sweep` (#8742): the process that ran this script, plus its
  # start time so a reused PID is not mistaken for it. Omitted when ps cannot say.
  local launcher_pid launcher_started
  launcher_pid="${PREVIEW_DAEMON_LAUNCHER_PID:-$PPID}"
  case "$launcher_pid" in ''|*[!0-9]*) launcher_pid='' ;; esac
  launcher_started=''
  [ -z "$launcher_pid" ] || launcher_started="$(proc_lstart "$launcher_pid")"
  [ -n "$launcher_started" ] || launcher_pid=''
  "$NODE_BIN/node" -e '
    const [, out, pid, port, configDir, fixture, head, startedAt, lpid, lstart] = process.argv
    const rec = { pid: Number(pid), port: Number(port), configDir, fixture, head, started_at: Number(startedAt) }
    if (lpid && lstart) { rec.launcher_pid = Number(lpid); rec.launcher_started = lstart }
    require("fs").writeFileSync(out, JSON.stringify(rec, null, 2) + "\n")' \
    "$smoke/preview.json" "$pid" "$port" "$smoke/config" "$smoke/fixture" "$head" "$(date +%s)" "$launcher_pid" "$launcher_started" \
    || fail_start "could not write preview.json"

  START_OK=1
  trap - EXIT INT TERM
  echo "SMOKE=$smoke"
  echo "URL=http://127.0.0.1:$port"
  echo "HEAD=$head"
}

case "${1:-}" in
  start|url|status|stop|clean|sweep) preflight ;;
esac
case "${1:-}" in
  start)  shift; cmd_start "$@" ;;
  url)    shift; cmd_url "$@" ;;
  status) shift; cmd_status "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  clean)  shift; cmd_clean "$@" ;;
  sweep)  shift; cmd_sweep "$@" ;;
  *)      usage ;;
esac
