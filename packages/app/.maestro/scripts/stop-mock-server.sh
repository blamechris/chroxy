#!/bin/bash
# Stop the mock Chroxy server.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.mock-server.pid"

if [ -f "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    # Verify PID belongs to the mock server (guard against PID reuse)
    cmdline=$(ps -p "$pid" -o args= 2>/dev/null || true)
    if ! echo "$cmdline" | grep -q 'mock-server.mjs'; then
      echo "[mock] PID $pid does not appear to be the mock server (cmdline: $cmdline)"
      echo "[mock] Treating PID file as stale"
    else
      echo "[mock] Stopping mock server (PID $pid)"
      kill "$pid" 2>/dev/null || true
      # Wait briefly for clean exit
      for i in 1 2 3; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      # Force kill if still alive
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    fi
  else
    echo "[mock] Server already stopped (stale PID $pid)"
  fi
  rm -f "$PID_FILE"
else
  echo "[mock] No PID file found — server not running"
fi
