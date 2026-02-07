#!/bin/bash
# Chroxy permission hook — bridges Claude Code permission requests to the mobile app.
#
# Claude Code calls this via its hooks system (PreToolUse event). The script:
# 1. Reads the hook input JSON from stdin (contains tool_name, tool_input, etc.)
# 2. POSTs it to the Chroxy HTTP server (long-poll, blocks until user responds)
# 3. Translates the response into Claude Code's hookSpecificOutput format

REQUEST=$(cat -)
RESPONSE=$(curl -s -X POST "http://localhost:${CHROXY_PORT}/permission" \
  -H "Content-Type: application/json" \
  -d "$REQUEST" \
  --max-time 300)
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
