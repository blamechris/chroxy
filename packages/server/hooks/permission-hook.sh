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
#
# SECURITY: All tool parameters arrive via stdin as JSON (never as shell arguments).
# Claude Code's hooks mechanism always passes hook data through stdin, not positional
# args. Do NOT use $1/$2/etc for tool parameters — they are untrusted and could
# contain shell metacharacters that execute arbitrary commands.

# If CHROXY_PORT is not set, this isn't a Chroxy session — exit silently
# so Claude Code uses its normal permission flow without showing a hook prompt.
if [ -z "$CHROXY_PORT" ]; then
  exit 0
fi

PORT="$CHROXY_PORT"
TOKEN="$CHROXY_HOOK_SECRET"
# Permission mode resolution order:
#   1. CHROXY_PERMISSION_MODE_FILE — if set AND readable AND non-empty.
#      ClaudeTuiSession writes this sidecar file when setPermissionMode()
#      is called mid-session, since env vars on a running PTY can't be
#      mutated from outside (#4013).
#   2. CHROXY_PERMISSION_MODE env var — the value at session-spawn time.
#      Used by CliSession (which restarts on mode change) and as the
#      initial value for TUI sessions.
#   3. "approve" — default if nothing else is set.
PERM_MODE=""
if [ -n "$CHROXY_PERMISSION_MODE_FILE" ] && [ -r "$CHROXY_PERMISSION_MODE_FILE" ]; then
  PERM_MODE=$(tr -d '[:space:]' < "$CHROXY_PERMISSION_MODE_FILE" 2>/dev/null)
fi
if [ -z "$PERM_MODE" ]; then
  PERM_MODE="${CHROXY_PERMISSION_MODE:-approve}"
fi

# Sanitize: PORT must be numeric
case "$PORT" in
  ''|*[!0-9]*) exit 0 ;;
esac

# Sanitize: PERM_MODE must be a known value
case "$PERM_MODE" in
  approve|auto|acceptEdits|plan) ;;
  *) PERM_MODE="approve" ;;
esac

# #4648 (v0.9.24): refuse multi-question AskUserQuestion forms before any
# mode-specific routing. Chroxy's PTY-keystroke driver for multi-question
# forms has a 0% production success rate (per chroxy.log forensic, 2026-05-31
# /swarm-audit consensus). Denying here forces the model to re-emit as N
# sequential single-question calls, each driven by the empirically-validated
# single-question happy path that has worked since v0.9.4. Defense in depth:
# the v0.9.23 _onAskUserQuestionStall teardown still catches anything that
# slips through. See docs/audit-results/tui-form-delivery-rethink/ for the
# full audit (6 agents, unanimous on this path).
#
# Reads stdin once at the top because the deny check must apply regardless
# of permission mode — auto/plan modes previously exited early without
# touching the payload. Modes below that need the payload reuse $REQUEST.
REQUEST=$(cat -)
TOOL_NAME=$(echo "$REQUEST" | grep -o '"tool_name":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$TOOL_NAME" = "AskUserQuestion" ]; then
  # Count `questions[]` length via python3 (stock macOS has it at /usr/bin/python3
  # 3.9.6; Homebrew at /opt/homebrew/bin). On parse failure or python3 absence
  # we get empty output → fall through to normal handling rather than
  # crash/deny-everything. Worst case: same as today (the v0.9.23 watchdog
  # catches the wedge), so this defaults safe.
  QUESTION_COUNT=$(printf '%s' "$REQUEST" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    q = d.get("tool_input", {}).get("questions", [])
    print(len(q) if isinstance(q, list) else 0)
except Exception:
    pass
' 2>/dev/null)
  if [ -n "$QUESTION_COUNT" ] && [ "$QUESTION_COUNT" -gt 1 ]; then
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Chroxy currently delivers AskUserQuestion forms one question at a time. Please re-issue this call as separate AskUserQuestion tool calls, one per question, and the user will answer each in turn."}}
EOF
    exit 0
  fi
fi

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
  # $REQUEST and $TOOL_NAME already populated at top of script (#4648).
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
# $REQUEST already populated at top of script (#4648).
route_to_phone
