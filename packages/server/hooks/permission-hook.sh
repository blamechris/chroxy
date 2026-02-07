#!/bin/bash
# Chroxy permission hook — bridges Claude Code permission requests to the mobile app.
#
# Claude Code calls this via its hooks system (PreToolUse event). The script:
# 1. Checks if this is a Chroxy-spawned session (CHROXY_PORT env var present)
# 2. Reads the hook input JSON from stdin (contains tool_name, tool_input, etc.)
# 3. POSTs it to the Chroxy HTTP server with Bearer auth (long-poll, blocks until user responds)
# 4. Translates the response into Claude Code's hookSpecificOutput format
#
# Non-Chroxy Claude sessions don't have CHROXY_PORT set, so the hook immediately
# falls through to Claude's normal permission prompt.

# If CHROXY_PORT is not set, this isn't a Chroxy session — fall through
if [ -z "$CHROXY_PORT" ]; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}
EOF
  exit 0
fi

PORT="$CHROXY_PORT"
TOKEN="$CHROXY_TOKEN"
PERM_MODE="${CHROXY_PERMISSION_MODE:-approve}"

# Auto mode — allow everything without routing to the phone
if [ "$PERM_MODE" = "auto" ]; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
EOF
  exit 0
fi

# Plan mode — let Claude handle permission (read-only self-restriction)
if [ "$PERM_MODE" = "plan" ]; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}
EOF
  exit 0
fi

# Approve mode (default) — route to phone via HTTP
REQUEST=$(cat -)

# Build curl args — omit Authorization header when token is empty (--no-auth mode)
CURL_ARGS=(-s -X POST "http://localhost:${PORT}/permission" -H "Content-Type: application/json" -d "$REQUEST" --max-time 300)
if [ -n "$TOKEN" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
fi

RESPONSE=$(curl "${CURL_ARGS[@]}")
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  # Timeout or connection failure — ask Claude's normal permission prompt
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}
EOF
  exit 0
fi

# Extract decision from server response
DECISION=$(echo "$RESPONSE" | grep -o '"decision":"[^"]*"' | head -1 | cut -d'"' -f4)

case "$DECISION" in
  allow|allowAlways)
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
EOF
    ;;
  deny)
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Denied by user via Chroxy mobile app"}}
EOF
    ;;
  *)
    # Unknown decision — fall through to Claude's normal prompt
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}
EOF
    ;;
esac
exit 0
