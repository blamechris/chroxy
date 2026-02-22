#!/bin/bash
# Start the mock Chroxy server for Maestro E2E tests.
# Polls until the server is healthy, then returns.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOCK_SERVER="$SCRIPT_DIR/../mock-server.mjs"
PID_FILE="$SCRIPT_DIR/.mock-server.pid"
PORT="${MOCK_PORT:-9876}"
MAX_WAIT=10  # seconds

# Kill existing mock server if running
if [ -f "$PID_FILE" ]; then
  old_pid=$(cat "$PID_FILE")
  if kill -0 "$old_pid" 2>/dev/null; then
    echo "[mock] Stopping existing mock server (PID $old_pid)"
    kill "$old_pid" 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

echo "[mock] Starting mock server on port $PORT..."
node "$MOCK_SERVER" --port "$PORT" &
echo $! > "$PID_FILE"

# Poll until healthy
for i in $(seq 1 $MAX_WAIT); do
  if curl -s "http://localhost:$PORT/" | grep -q '"status":"ok"'; then
    echo "[mock] Server ready (PID $(cat "$PID_FILE"))"
    exit 0
  fi
  sleep 1
done

echo "[mock] ERROR: Server failed to start within ${MAX_WAIT}s"
# Clean up
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
fi
exit 1
