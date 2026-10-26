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
#       [--retries N] [--timeout SECS] [--no-reset] \
#       [--flow <name-from-run-all.yaml>] [--max-failures N] \
#       [--shard-index INDEX --shard-count COUNT]
#
# Env overrides:
#   MAESTRO_DEVICE   simulator UDID (default: first booted device)
#   MAX_RETRIES      per-flow retry count on failure (default: 1)
#   FLOW_TIMEOUT     per-flow timeout in seconds (default: 300)
#   MAX_FAILURES     stop after N failed flows (default: 0, run every flow)
#   SIM_RESET_PHASE_TIMEOUT  shutdown/boot phase ceiling in seconds (default: 60)
#   SIM_BOOTSTATUS_TIMEOUT   bootstatus ceiling in seconds (default: 120)
#   MAESTRO_ARTIFACT_DIR  optional current-run diagnostics under RUNNER_TEMP
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
MAX_FAILURES="${MAX_FAILURES:-0}"
ONLY_FLOW=""
SHARD_INDEX=0
SHARD_COUNT=1
SHARD_INDEX_SET=0
SHARD_COUNT_SET=0
RESET_ON_FAIL=1
MAESTRO_ARTIFACT_DIR="${MAESTRO_ARTIFACT_DIR:-}"
SIM_RESET_PHASE_TIMEOUT="${SIM_RESET_PHASE_TIMEOUT:-60}"
SIM_BOOTSTATUS_TIMEOUT="${SIM_BOOTSTATUS_TIMEOUT:-120}"

need_val() { [ $# -ge 2 ] || { echo "ERROR: $1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --device) need_val "$@"; DEVICE="$2"; shift 2 ;;
    --no-mock) START_MOCK=0; shift ;;
    --retries) need_val "$@"; MAX_RETRIES="$2"; shift 2 ;;
    --timeout) need_val "$@"; FLOW_TIMEOUT="$2"; shift 2 ;;
    --flow) need_val "$@"; ONLY_FLOW="$2"; [ -n "$ONLY_FLOW" ] || { echo 'ERROR: --flow needs a nonempty name' >&2; exit 2; }; shift 2 ;;
    --shard-index) need_val "$@"; SHARD_INDEX="$2"; SHARD_INDEX_SET=1; shift 2 ;;
    --shard-count) need_val "$@"; SHARD_COUNT="$2"; SHARD_COUNT_SET=1; shift 2 ;;
    --max-failures) need_val "$@"; MAX_FAILURES="$2"; shift 2 ;;
    --no-reset) RESET_ON_FAIL=0; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Numeric guards so a bad --retries/--timeout fails fast, not mid-loop.
case "$MAX_RETRIES" in (*[!0-9]*|'') echo "ERROR: --retries must be a non-negative integer" >&2; exit 2 ;; esac
case "$FLOW_TIMEOUT" in (*[!0-9]*|'') echo "ERROR: --timeout must be a positive integer (seconds)" >&2; exit 2 ;; esac
case "$MAX_FAILURES" in (*[!0-9]*|'') echo "ERROR: --max-failures must be a non-negative integer" >&2; exit 2 ;; esac
if [ "$SHARD_INDEX_SET" -ne "$SHARD_COUNT_SET" ]; then
  echo 'ERROR: --shard-index and --shard-count must be supplied together' >&2
  exit 2
fi
if [ -n "$ONLY_FLOW" ] && [ "$SHARD_INDEX_SET" -eq 1 ]; then
  echo 'ERROR: --flow cannot be combined with shard selection' >&2
  exit 2
fi
# Canonical decimal spelling avoids Bash interpreting a leading zero as octal.
# Bound digit length before integer comparison so hostile CLI input cannot
# overflow Bash's signed integer parser.
if [[ ! "$SHARD_INDEX" =~ ^(0|[1-9][0-9]*)$ ]] || [ "${#SHARD_INDEX}" -gt 9 ]; then
  echo 'ERROR: --shard-index must be a non-negative decimal integer' >&2
  exit 2
fi
if [[ ! "$SHARD_COUNT" =~ ^[1-9][0-9]*$ ]] || [ "${#SHARD_COUNT}" -gt 9 ]; then
  echo 'ERROR: --shard-count must be a positive decimal integer' >&2
  exit 2
fi
if [ "$SHARD_INDEX" -ge "$SHARD_COUNT" ]; then
  echo 'ERROR: --shard-index must be less than --shard-count' >&2
  exit 2
fi
for reset_timeout in "$SIM_RESET_PHASE_TIMEOUT" "$SIM_BOOTSTATUS_TIMEOUT"; do
  case "$reset_timeout" in (*[!0-9]*|'') echo "ERROR: simulator reset timeouts must be 1-300 seconds" >&2; exit 2 ;; esac
  if [ "$reset_timeout" -lt 1 ] || [ "$reset_timeout" -gt 300 ]; then
    echo "ERROR: simulator reset timeouts must be 1-300 seconds" >&2
    exit 2
  fi
done
if [ -n "$MAESTRO_ARTIFACT_DIR" ]; then
  if [ -z "${RUNNER_TEMP:-}" ] || [[ "$RUNNER_TEMP" != /* ]] || \
    [ "$MAESTRO_ARTIFACT_DIR" != "${RUNNER_TEMP%/}/maestro-diagnostics" ]; then
    echo "ERROR: MAESTRO_ARTIFACT_DIR must be this run's RUNNER_TEMP/maestro-diagnostics" >&2
    exit 2
  fi
fi

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

# Launch selection is explicit in CI, with the existing development default.
LAUNCH_MODE="${CHROXY_MAESTRO_LAUNCH_MODE-dev-client}"
if [ "${CHROXY_MAESTRO_RUNTIME_CACHE+x}" = x ] || [ "${CHROXY_MAESTRO_RUNTIME_VERSION+x}" = x ]; then
  echo 'ERROR: Retired Maestro runtime inputs must be removed' >&2
  exit 2
fi
MAESTRO_LAUNCH_ARGS=("-e" "CHROXY_MAESTRO_LAUNCH_MODE=$LAUNCH_MODE")
case "$LAUNCH_MODE" in
  dev-client)
    if [ "${CHROXY_MAESTRO_BUILD_MODE+x}" = x ] || [ "${CHROXY_MAESTRO_VERIFIED_RUNTIME+x}" = x ]; then
      echo 'ERROR: Development launch must not use bundled artifact inputs' >&2
      exit 2
    fi
    ;;
  bundled)
    if [ "${CHROXY_MAESTRO_BUILD_MODE:-}" != bundled ] || { [ "${CI:-}" != 1 ] && [ "${CI:-}" != true ]; } ||
      [[ ! "${CHROXY_MAESTRO_VERIFIED_RUNTIME:-}" =~ ^[0-9a-f]{40}$ ]]; then
      echo 'ERROR: Bundled launch requires CI and the verified artifact runtime' >&2
      exit 2
    fi
    MAESTRO_LAUNCH_ARGS+=("-e" "CHROXY_MAESTRO_BUILD_MODE=bundled" "-e" "CHROXY_MAESTRO_CI=1"
      "-e" "CHROXY_MAESTRO_VERIFIED_RUNTIME=$CHROXY_MAESTRO_VERIFIED_RUNTIME")
    ;;
  *) echo 'ERROR: Launch mode must be dev-client or bundled' >&2; exit 2 ;;
esac

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
INVENTORY_COUNT=${#FLOWS[@]}
if [ -n "$ONLY_FLOW" ]; then
  found=0
  for flow in "${FLOWS[@]}"; do
    if [ "$flow" = "$ONLY_FLOW" ]; then found=1; break; fi
  done
  if [ "$found" -ne 1 ]; then
    echo "ERROR: --flow must name a flow in run-all.yaml: $ONLY_FLOW" >&2
    exit 2
  fi
  FLOWS=("$ONLY_FLOW")
elif [ "$SHARD_COUNT" -gt 1 ]; then
  if [ "$SHARD_COUNT" -gt "$INVENTORY_COUNT" ]; then
    echo "ERROR: --shard-count $SHARD_COUNT exceeds $INVENTORY_COUNT inventoried flows (empty shard)" >&2
    exit 2
  fi
  SELECTED_FLOWS=()
  for ((inventory_index = 0; inventory_index < INVENTORY_COUNT; inventory_index++)); do
    if [ "$((inventory_index % SHARD_COUNT))" -eq "$SHARD_INDEX" ]; then
      SELECTED_FLOWS+=("${FLOWS[inventory_index]}")
    fi
  done
  FLOWS=("${SELECTED_FLOWS[@]}")
fi
if [ "${#FLOWS[@]}" -eq 0 ]; then
  echo "ERROR: shard $SHARD_INDEX/$SHARD_COUNT selected no flows from $INVENTORY_COUNT inventoried flows" >&2
  exit 2
fi

# Run a command with a wall-clock timeout, portably (macOS has no `timeout`).
# Returns the command's exit code, or 124 if it was killed for exceeding SECS.
run_with_timeout() {
  local secs="$1"; shift
  # Marker file the watchdog writes IFF it actually fired (the command was still
  # alive at the deadline). `wait` on a SIGTERM/SIGKILL-ed child returns 143/137,
  # not 124, so we can't infer a timeout from the exit status — the marker does.
  local marker; marker="$(mktemp)"
  "$@" &
  local cmd_pid=$!
  (
    sleep "$secs"
    # Only signal if the command is still the live process (guards the tiny
    # window where it exits right as the timeout fires — avoids PID reuse).
    if kill -0 "$cmd_pid" 2>/dev/null; then
      printf 'timeout' > "$marker"
      kill -TERM "$cmd_pid" 2>/dev/null
      sleep 5
      kill -0 "$cmd_pid" 2>/dev/null && kill -KILL "$cmd_pid" 2>/dev/null
    fi
  ) &
  local wd_pid=$!
  local rc=0
  wait "$cmd_pid" 2>/dev/null || rc=$?
  # Cancel the watchdog if the command finished on its own.
  kill "$wd_pid" 2>/dev/null
  wait "$wd_pid" 2>/dev/null || true
  # Normalize a watchdog-induced kill to the conventional timeout code.
  [ -s "$marker" ] && rc=124
  rm -f "$marker"
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
  local shutdown_rc=0
  reset_phase 'shutdown' "$SIM_RESET_PHASE_TIMEOUT" xcrun simctl shutdown "$DEVICE" || shutdown_rc=$?
  # A simulator already in Shutdown makes simctl shutdown return nonzero. The
  # following boot + bootstatus still prove recovery; a timed-out shutdown does
  # not, so stop on its deadline.
  [ "$shutdown_rc" -ne 124 ] || return 1
  reset_phase 'boot' "$SIM_RESET_PHASE_TIMEOUT" xcrun simctl boot "$DEVICE" || return 1
  reset_phase 'bootstatus' "$SIM_BOOTSTATUS_TIMEOUT" xcrun simctl bootstatus "$DEVICE" -b || return 1
}

reset_phase() {
  local name="$1" secs="$2"; shift 2
  local started=$SECONDS rc=0
  echo "[runner] reset $name started (limit ${secs}s)"
  run_with_timeout "$secs" "$@" || rc=$?
  echo "[runner] reset $name finished in $((SECONDS - started))s (exit $rc)"
  if [ "$rc" -ne 0 ]; then
    if [ "$name" = shutdown ] && [ "$rc" -ne 124 ]; then
      echo "[runner] reset shutdown returned $rc; boot and bootstatus will verify recovery" >&2
    else
      echo "ERROR: simulator reset $name failed (exit $rc)" >&2
    fi
    return "$rc"
  fi
}

echo "================================================================"
echo " Maestro per-flow runner (#6091)"
echo " Device:   $DEVICE"
echo " Inventory: $INVENTORY_COUNT flows from run-all.yaml"
echo " Selection: ${#FLOWS[@]} flows; shard $SHARD_INDEX/$SHARD_COUNT"
echo " Retries:  $MAX_RETRIES per flow on failure"
echo " Timeout:  ${FLOW_TIMEOUT}s per flow"
echo " Stop:     $([ "$MAX_FAILURES" -eq 0 ] && echo 'no early stop' || echo "after $MAX_FAILURES failed flows")"
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
    # Fail fast: a dead mock server would otherwise cascade into a wall of
    # session-flow failures that look like flow defects.
    if ! bash "$SCRIPT_DIR/start-mock-server.sh"; then
      echo "ERROR: mock server failed to start on port $MOCK_PORT; aborting." >&2
      exit 1
    fi
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

flow_index=0
for flow in "${FLOWS[@]}"; do
  flow_index=$((flow_index + 1))
  flow_path="$MAESTRO_DIR/$flow"
  if [ ! -f "$flow_path" ]; then
    echo "[runner] SKIP (missing file): $flow"
    FAILED+=("$flow (missing)")
    if [ "$MAX_FAILURES" -gt 0 ] && [ "${#FAILED[@]}" -ge "$MAX_FAILURES" ]; then
      echo "[runner] Stopping after ${#FAILED[@]} failed flows; remaining inventory not run."
      break
    fi
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
    MAESTRO_OUTPUT_ARGS=()
    if [ -n "$MAESTRO_ARTIFACT_DIR" ]; then
      # Use numbered per-attempt directories so a retry cannot overwrite the
      # first failure's screenshot or hierarchy. Both Maestro output streams
      # go here directly; nothing is copied from ~/.maestro/tests.
      artifact_path="$MAESTRO_ARTIFACT_DIR/flow-$((${#PASSED[@]} + ${#FAILED[@]} + 1))-attempt-$attempt"
      mkdir -p "$artifact_path"
      MAESTRO_OUTPUT_ARGS=("--test-output-dir=$artifact_path" "--debug-output=$artifact_path")
    fi
    rc=0
    run_with_timeout "$FLOW_TIMEOUT" maestro test --device "$DEVICE" "${MAESTRO_LAUNCH_ARGS[@]}" "${MAESTRO_OUTPUT_ARGS[@]+"${MAESTRO_OUTPUT_ARGS[@]}"}" "$flow_path" || rc=$?
    if [ "$rc" -eq 0 ]; then
      ok=1
      break
    fi
    if [ "$rc" -eq 124 ]; then
      echo "[runner] TIMEOUT (${FLOW_TIMEOUT}s): $flow"
      # Reap orphaned driver children now, in case reset is disabled.
      kill_maestro_children
    fi
    # Reset only if an attempt or later flow will actually run. A final failed
    # flow (including the --max-failures boundary) needs no further simulator.
    if [ "$attempt" -le "$MAX_RETRIES" ] || {
      [ "$flow_index" -lt "${#FLOWS[@]}" ] &&
      { [ "$MAX_FAILURES" -eq 0 ] || [ "$((${#FAILED[@]} + 1))" -lt "$MAX_FAILURES" ]; }
    }; then
      reset_simulator || exit 1
    fi
  done

  if [ "$ok" -eq 1 ]; then
    PASSED+=("$flow")
    echo "[runner] PASS: $flow"
  else
    FAILED+=("$flow")
    echo "[runner] FAIL (after $((MAX_RETRIES + 1)) attempts): $flow"
  fi
  if [ "$MAX_FAILURES" -gt 0 ] && [ "${#FAILED[@]}" -ge "$MAX_FAILURES" ]; then
    echo "[runner] Stopping after ${#FAILED[@]} failed flows; remaining inventory not run."
    break
  fi
done

echo "================================================================"
attempted=$((${#PASSED[@]} + ${#FAILED[@]}))
if [ "$attempted" -eq "${#FLOWS[@]}" ]; then
  echo " Summary: ${#PASSED[@]} passed, ${#FAILED[@]} failed (of ${#FLOWS[@]} selected; $INVENTORY_COUNT inventoried; shard $SHARD_INDEX/$SHARD_COUNT)"
else
  echo " Summary: ${#PASSED[@]} passed, ${#FAILED[@]} failed ($attempted attempted of ${#FLOWS[@]} selected; $((${#FLOWS[@]} - attempted)) not run; $INVENTORY_COUNT inventoried; shard $SHARD_INDEX/$SHARD_COUNT)"
fi
echo "================================================================"
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf ' FAIL  %s\n' "${FAILED[@]}"
  exit 1
fi
echo " All ${#FLOWS[@]} selected flows passed (shard $SHARD_INDEX/$SHARD_COUNT of $INVENTORY_COUNT inventoried)."
exit 0
