#!/bin/bash
# Chroxy permission hook — bridges Claude Code permission requests to the mobile app.
#
# Claude Code calls this via its hooks system (PreToolUse event). The script:
# 1. Checks if this is a Chroxy-spawned session (CHROXY_PORT env var present)
# 2. Reads the hook input JSON from stdin (contains tool_name, tool_input, etc.)
# 3. POSTs it to the Chroxy HTTP server with per-session hook secret auth
#    (long-poll, blocks until user responds). CHROXY_HOOK_SECRET is a short-lived
#    random secret specific to this session — never the primary API token.
# 4. Translates the response into Claude Code's hookSpecificOutput format
#
# Non-Chroxy Claude sessions don't have CHROXY_PORT set, so the hook immediately
# falls through to Claude's normal permission prompt.

# If CHROXY_PORT is not set, this isn't a Chroxy session — exit silently
# so Claude Code uses its normal permission flow without showing a hook prompt.
if [ -z "$CHROXY_PORT" ]; then
  exit 0
fi

PORT="$CHROXY_PORT"
TOKEN="$CHROXY_HOOK_SECRET"
PERM_MODE="${CHROXY_PERMISSION_MODE:-approve}"

# Sanitize: PORT must be numeric
case "$PORT" in
  ''|*[!0-9]*) exit 0 ;;
esac

# Sanitize: PERM_MODE must be a known value
case "$PERM_MODE" in
  approve|auto|acceptEdits|plan) ;;
  *) PERM_MODE="approve" ;;
esac

# ---- Shared: route a permission request to the phone via HTTP ----
# Expects $REQUEST to contain the JSON body to POST.
# Outputs the appropriate hookSpecificOutput JSON and exits.
route_to_phone() {
  CURL_ARGS=(-s -X POST "http://localhost:${PORT}/permission" -H "Content-Type: application/json" -d "$REQUEST" --max-time 300)
  if [ -n "$TOKEN" ]; then
    CURL_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
  fi

  RESPONSE=$(curl "${CURL_ARGS[@]}")
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}
EOF
    exit 0
  fi

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
      cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}
EOF
      ;;
  esac
  exit 0
}

# Auto mode — allow everything without routing to the phone
if [ "$PERM_MODE" = "auto" ]; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
EOF
  exit 0
fi

# Accept Edits mode — auto-approve file operations, route everything else to phone
if [ "$PERM_MODE" = "acceptEdits" ]; then
  REQUEST=$(cat -)
  TOOL_NAME=$(echo "$REQUEST" | grep -o '"tool_name":"[^"]*"' | head -1 | cut -d'"' -f4)
  case "$TOOL_NAME" in
    Read|Write|Edit|NotebookEdit|Glob|Grep)
      cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
EOF
      exit 0 ;;
  esac
  # Non-file tool — route to phone
  route_to_phone
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
route_to_phone
