#!/bin/bash
# Run every E2E flow as its OWN `maestro test` invocation, with per-flow timeout
# and simulator reset on failure (#6091).
#
# The problem: `run-all.yaml` nests every flow under `runFlow:` inside a SINGLE
# `maestro test` process. When the iOS driver throws a transient
# `kAXErrorInvalidUIElement` viewHierarchy 500 (it can hit ANY flow, even on the
# first assertion of a fresh launch — it is environmental XCUITest/CoreSimulator
# instability, never a flow-assertion defect), that one crash aborts the whole
# process, killing every flow after it. Each flow is individually green; the
# suite-level single-process run is the flaky part.
#
# Worse: once that error fires, CoreSimulator's accessibility state stays wedged,
# so a naive retry against the SAME booted simulator hangs indefinitely (a fresh
# `maestro test` still can't read the view hierarchy). Process isolation alone is
# not enough.
#
# This runner therefore:
#   1. Runs each flow in its OWN `maestro test` process (a crash costs one flow,
#      not the rest of the suite).
#   2. Bounds every flow with a timeout, so a wedged driver can never hang the
#      run (the symptom that motivated the timeout: a retry hung ~54 minutes).
#   3. On any flow failure, RESETS the simulator (shutdown + boot) before the
#      retry / next flow, clearing the wedged accessibility state. This is the
#      only reliable recovery from kAXErrorInvalidUIElement.
# A genuine assertion failure still fails across retries and is reported.
#
# The flow inventory + ordering is parsed from run-all.yaml (single source of
# truth).
#
# Usage:
#   bash run-all-sequential.sh [--device <udid>] [--no-mock] \
#       [--retries N] [--timeout SECS] [--no-reset]
#
# Env overrides:
#   MAESTRO_DEVICE   simulator UDID (default: first booted device)
#   MAX_RETRIES      per-flow retry count on failure (default: 1)
#   FLOW_TIMEOUT     per-flow timeout in seconds (default: 300)
#   MOCK_PORT        mock-server port (default: 9876)
#   JAVA_HOME        validated; falls back to the Homebrew openjdk@21 symlink

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAESTRO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_ALL="$MAESTRO_DIR/run-all.yaml"

DEVICE="${MAESTRO_DEVICE:-}"
START_MOCK=1
MAX_RETRIES="${MAX_RETRIES:-1}"
FLOW_TIMEOUT="${FLOW_TIMEOUT:-300}"
RESET_ON_FAIL=1

need_val() { [ $# -ge 2 ] || { echo "ERROR: $1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --device) need_val "$@"; DEVICE="$2"; shift 2 ;;
    --no-mock) START_MOCK=0; shift ;;
    --retries) need_val "$@"; MAX_RETRIES="$2"; shift 2 ;;
    --timeout) need_val "$@"; FLOW_TIMEOUT="$2"; shift 2 ;;
    --no-reset) RESET_ON_FAIL=0; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Numeric guards so a bad --retries/--timeout fails fast, not mid-loop.
case "$MAX_RETRIES" in (*[!0-9]*|'') echo "ERROR: --retries must be a non-negative integer" >&2; exit 2 ;; esac
case "$FLOW_TIMEOUT" in (*[!0-9]*|'') echo "ERROR: --timeout must be a positive integer (seconds)" >&2; exit 2 ;; esac

# maestro needs Java. A JAVA_HOME inherited from the user's profile is often a
# pinned Cellar version path (e.g. openjdk@21/21.0.9) that goes stale on the next
# brew upgrade — so VALIDATE it (must contain bin/java), don't just check it's set.
# Fall back to the version-independent Homebrew symlink, then to java_home.
java_ok() { [ -n "${1:-}" ] && [ -x "$1/bin/java" ]; }
if ! java_ok "${JAVA_HOME:-}"; then
  for cand in \
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
    "$(/usr/libexec/java_home -v 21 2>/dev/null)"; do
    if java_ok "$cand"; then
      export JAVA_HOME="$cand"
      break
    fi
  done
fi
if ! java_ok "${JAVA_HOME:-}"; then
  echo "ERROR: no valid JAVA_HOME (need a JDK 21 with bin/java). Install: brew install openjdk@21" >&2
  exit 1
fi
export PATH="$PATH:$HOME/.maestro/bin"

if ! command -v maestro >/dev/null 2>&1; then
  echo "ERROR: maestro not on PATH (expected ~/.maestro/bin). Install: curl -Ls https://get.maestro.mobile.dev | bash" >&2
  exit 1
fi

# Default to the first booted simulator if no device was specified.
if [ -z "$DEVICE" ]; then
  DEVICE=$(xcrun simctl list devices booted 2>/dev/null \
    | grep -oE '\(([0-9A-F-]{36})\) \(Booted\)' \
    | grep -oE '[0-9A-F-]{36}' | head -1)
fi
if [ -z "$DEVICE" ]; then
  echo "ERROR: no booted simulator found and no --device given. Boot one: xcrun simctl boot <udid>" >&2
  exit 1
fi

# Parse the ordered flow list from run-all.yaml (single source of truth).
if [ ! -f "$RUN_ALL" ]; then
  echo "ERROR: $RUN_ALL not found" >&2
  exit 1
fi
FLOWS=()
while IFS= read -r flow; do
  [ -n "$flow" ] && FLOWS+=("$flow")
done < <(grep -oE 'runFlow:[[:space:]]*[^[:space:]]+\.yaml' "$RUN_ALL" | sed -E 's/runFlow:[[:space:]]*//')

if [ "${#FLOWS[@]}" -eq 0 ]; then
  echo "ERROR: no '- runFlow:' entries parsed from run-all.yaml" >&2
  exit 1
fi

# Run a command with a wall-clock timeout, portably (macOS has no `timeout`).
# Returns the command's exit code, or 124 if it was killed for exceeding SECS.
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local cmd_pid=$!
  (
    sleep "$secs"
    # Only signal if the command is still the live process (guards the tiny
    # window where it exits right as the timeout fires — avoids PID reuse).
    kill -0 "$cmd_pid" 2>/dev/null && kill -TERM "$cmd_pid" 2>/dev/null
    sleep 5
    kill -0 "$cmd_pid" 2>/dev/null && kill -KILL "$cmd_pid" 2>/dev/null
  ) &
  local wd_pid=$!
  local rc=0
  wait "$cmd_pid" 2>/dev/null || rc=$?
  # Cancel the watchdog if the command finished on its own.
  kill "$wd_pid" 2>/dev/null
  wait "$wd_pid" 2>/dev/null || true
  return "$rc"
}

# Reap maestro's iOS driver children (xcodebuild + the XCUITest runner app).
# Killing only the maestro JVM on a timeout can orphan these, leaving the sim's
# accessibility state busy; reset_simulator also calls this, but we reap on every
# timeout so the orphan window is closed even when --no-reset is set.
kill_maestro_children() {
  pkill -f "maestro.cli.AppKt test" 2>/dev/null || true
  pkill -f "maestro-driver-iosUITests-Runner" 2>/dev/null || true
  pkill -f "xcodebuild test-without-building.*maestro" 2>/dev/null || true
}

# Clear a wedged simulator accessibility state (the only reliable recovery from
# kAXErrorInvalidUIElement): kill any maestro driver, shutdown + boot the sim,
# wait for boot to settle.
reset_simulator() {
  [ "$RESET_ON_FAIL" -eq 1 ] || return 0
  echo "[runner] resetting simulator $DEVICE (clearing wedged a11y state)..."
  kill_maestro_children
  xcrun simctl shutdown "$DEVICE" 2>/dev/null || true
  xcrun simctl boot "$DEVICE" 2>/dev/null || true
  # bootstatus -b blocks until the device is fully booted (best-effort).
  xcrun simctl bootstatus "$DEVICE" -b >/dev/null 2>&1 || true
}

echo "================================================================"
echo " Maestro per-flow runner (#6091)"
echo " Device:   $DEVICE"
echo " Flows:    ${#FLOWS[@]}  (from run-all.yaml)"
echo " Retries:  $MAX_RETRIES per flow on failure"
echo " Timeout:  ${FLOW_TIMEOUT}s per flow"
echo " Reset:    $([ "$RESET_ON_FAIL" -eq 1 ] && echo 'shutdown+boot on failure' || echo 'disabled')"
echo "================================================================"

MOCK_PORT="${MOCK_PORT:-9876}"
MOCK_STARTED=0
if [ "$START_MOCK" -eq 1 ]; then
  # Reuse an already-healthy mock server (avoids an EADDRINUSE crash when one is
  # already bound from a prior run); only start + own teardown if none is up.
  if curl -s "http://localhost:$MOCK_PORT/" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "[runner] Reusing healthy mock server already on port $MOCK_PORT"
  else
    echo "[runner] Starting mock server..."
    bash "$SCRIPT_DIR/start-mock-server.sh"
    MOCK_STARTED=1
  fi
fi

cleanup() {
  if [ "$MOCK_STARTED" -eq 1 ]; then
    echo "[runner] Stopping mock server..."
    bash "$SCRIPT_DIR/stop-mock-server.sh" || true
  fi
}
trap cleanup EXIT

PASSED=()
FAILED=()

for flow in "${FLOWS[@]}"; do
  flow_path="$MAESTRO_DIR/$flow"
  if [ ! -f "$flow_path" ]; then
    echo "[runner] SKIP (missing file): $flow"
    FAILED+=("$flow (missing)")
    continue
  fi

  attempt=0
  ok=0
  while [ "$attempt" -le "$MAX_RETRIES" ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 1 ]; then
      echo "[runner] retry $((attempt - 1))/$MAX_RETRIES: $flow"
    else
      echo "[runner] ----> $flow"
    fi
    # Each invocation is its own JVM + XCUITest session, time-bounded so a wedged
    # driver can't hang the whole run.
    rc=0
    run_with_timeout "$FLOW_TIMEOUT" maestro test --device "$DEVICE" "$flow_path" || rc=$?
    if [ "$rc" -eq 0 ]; then
      ok=1
      break
    fi
    if [ "$rc" -eq 124 ]; then
      echo "[runner] TIMEOUT (${FLOW_TIMEOUT}s): $flow"
      # Reap orphaned driver children now, in case reset is disabled.
      kill_maestro_children
    fi
    # Failure (crash, timeout, or assertion): reset the sim before the next
    # attempt / next flow so a wedged a11y state doesn't poison what follows.
    reset_simulator
  done

  if [ "$ok" -eq 1 ]; then
    PASSED+=("$flow")
    echo "[runner] PASS: $flow"
  else
    FAILED+=("$flow")
    echo "[runner] FAIL (after $((MAX_RETRIES + 1)) attempts): $flow"
  fi
done

echo "================================================================"
echo " Summary: ${#PASSED[@]} passed, ${#FAILED[@]} failed (of ${#FLOWS[@]})"
echo "================================================================"
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf ' FAIL  %s\n' "${FAILED[@]}"
  exit 1
fi
echo " All flows passed."
exit 0
