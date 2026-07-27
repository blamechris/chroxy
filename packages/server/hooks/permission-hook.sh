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
# In the lenient modes (auto / acceptEdits) it decides locally instead of routing
# to the phone — but FIRST asks POST /permission-floor whether the protected-path /
# secret-read floor covers the target (#7004). A floored target (.env, key material,
# a write into .git/.claude/.vscode) is routed to the normal prompt rather than
# auto-allowed, so the floor holds on this path exactly as it does in-process. The
# floor logic itself lives only in the daemon — see floor_forces_prompt below and
# docs/security/permission-floor.md.
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
# Where the daemon's HTTP endpoints live, from this process's point of view.
# `localhost` is right for a host-spawned session, but NOT from inside a
# container: DockerSession forwards CHROXY_HOST=host.docker.internal precisely so
# the callback can reach the host, and the hook has been ignoring it — meaning a
# containerized CliSession's /permission POST went to the container's own
# localhost and always failed (fail-closed deny). #7004 makes that reachability
# load-bearing for auto/acceptEdits too, so honour it: CHROXY_HOOK_HOST (dedicated)
# first, then CHROXY_HOST (what DockerSession already sets, and which on the host
# names the interface the daemon actually bound), else localhost.
HOOK_HOST="${CHROXY_HOOK_HOST:-$CHROXY_HOST}"
# Sanitize: a hostname/IPv4 literal only. Anything else — an empty value, an IPv6
# literal, a URL, or anything carrying shell/URL metacharacters — falls back to
# localhost rather than being interpolated into the curl target.
case "$HOOK_HOST" in
  ''|*[!A-Za-z0-9.-]*|[!A-Za-z0-9]*) HOOK_HOST="localhost" ;;
esac
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
  # Parse `questions[]` length AND whether any question is multiSelect via
  # python3 (stock macOS has it at /usr/bin/python3 3.9.6; Homebrew at
  # /opt/homebrew/bin). On parse failure or python3 absence we get empty
  # output → fall through to normal handling rather than crash/deny-everything.
  # Worst case: same as today (the v0.9.23 watchdog + the form-driver multiSelect
  # guard catch the wedge), so this defaults safe.
  #
  # #5771: deny single-question multiSelect too. claude TUI is keyboard-only and
  # has no reliable multi-toggle+submit keystroke sequence (0/7 production
  # success — swarm audit 2026-06-13). Single-select single-questions stay on the
  # empirically-validated happy path; everything multiSelect is refused here so
  # the model decomposes into single-select asks. Output is "<count> <hasMulti>".
  PARSED=$(printf '%s' "$REQUEST" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    q = d.get("tool_input", {}).get("questions", [])
    if not isinstance(q, list):
        q = []
    has_multi = 1 if any(isinstance(x, dict) and x.get("multiSelect") is True for x in q) else 0
    print(f"{len(q)} {has_multi}")
except Exception:
    pass
' 2>/dev/null)
  QUESTION_COUNT=$(printf '%s' "$PARSED" | cut -d' ' -f1)
  HAS_MULTISELECT=$(printf '%s' "$PARSED" | cut -d' ' -f2)
  if [ -n "$QUESTION_COUNT" ] && [ "$QUESTION_COUNT" -gt 1 ]; then
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Chroxy currently delivers AskUserQuestion forms one question at a time. Please re-issue this call as separate AskUserQuestion tool calls, ONE AT A TIME — issue the next one only after the previous one's tool_result has been returned. Do NOT issue multiple AskUserQuestion tool_use blocks in parallel within the same assistant turn."}}
EOF
    exit 0
  fi
  if [ "$QUESTION_COUNT" = "1" ] && [ "$HAS_MULTISELECT" = "1" ]; then
    # #5776 (Phase 0) — when the multi-select reinject spike is enabled, the
    # Chroxy client renders the multi-select form itself and delivers the user's
    # selection as a follow-up message. Steer the model to STOP and wait for that
    # message rather than decompose into single-select asks. Still a deny (that is
    # what suppresses claude TUI's own un-drivable form); only the reason differs.
    if [ "$CHROXY_TUI_MULTISELECT_REINJECT" = "1" ]; then
      cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The Chroxy client is collecting this multi-select choice from the user directly. Do NOT re-ask, do NOT decompose into single-select questions, and do NOT call any further tools. Stop here — the user's selection will arrive as your next user message; continue from it then."}}
EOF
      exit 0
    fi
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Chroxy's TUI provider does not support multi-select questions (multiSelect:true). Re-issue this as a single-select question (multiSelect:false), or — if the user genuinely needs to choose several items — ask one single-select AskUserQuestion per item (e.g. an include/skip choice for each), ONE AT A TIME, issuing the next only after the previous tool_result returns."}}
EOF
    exit 0
  fi

  # #4668 (short-term): deny when another AskUserQuestion is already pending
  # in this session. The model interprets #4648's "separate AskUserQuestion
  # tool calls" as "parallel within the same turn" — empirically, claude TUI
  # was emitting 4 parallel AskUserQuestion tool_use blocks in one turn,
  # which overwrote chroxy's single `_pendingUserAnswer` field and routed all
  # user answers to the wrong question (chroxy.log forensic 2026-05-31 on
  # v0.9.26 session 9ea82aed). Forcing true serialization at the hook layer
  # restores the single-pending invariant that the existing keystroke driver
  # was built around. The PostToolUse hook in writeHookSettings()
  # (claude-tui-session.js) clears this lock when the active AskUserQuestion
  # completes, so sequential AskUserQuestions are unaffected.
  #
  # mkdir IS the atomic claim — not a follow-up to a separate existence
  # check. POSIX guarantees mkdir is atomic across concurrent processes: at
  # most one caller per parent directory wins; the rest see EEXIST. Pre-v1
  # of this fix used `if [ -d "$LOCK" ]; then deny; else mkdir; fi` which
  # is TOCTOU-broken: parallel hooks (chroxy's exact case — 4 AskUserQuestion
  # hooks firing within milliseconds) can all observe "not exists" before
  # any of them mkdir. The mkdir-first structure here eliminates that
  # window: the race-winner gets through, every other caller sees the dir
  # already there and falls into the stale-check / deny branch.
  if [ -n "$CHROXY_SINK_DIR" ] && [ -d "$CHROXY_SINK_DIR" ]; then
    SIBLING_LOCK="${CHROXY_SINK_DIR}/askuserquestion-active"
    if ! mkdir "$SIBLING_LOCK" 2>/dev/null; then
      # mkdir failed because the dir already exists (EEXIST — the only
      # plausible cause once CHROXY_SINK_DIR is verified writable above).
      # Inspect the existing lock's age to decide: fresh sibling (deny) or
      # stale leftover (reclaim).
      #
      # stat flag portability: macOS uses BSD stat (-f %m, mtime as epoch
      # seconds); Linux uses GNU stat (-c %Y). The platform branch keeps
      # the wrong invocation from succeeding accidentally — GNU stat -f
      # silently switches to filesystem-info mode and returns a mount-point
      # string, which then breaks the arithmetic below (assigns LOCK_AGE
      # to empty → the [ -lt 60 ] check evaluates falsy → would skip the
      # deny path and bypass the fix entirely on Linux CI).
      case "$(uname -s)" in
        Darwin) LOCK_MTIME=$(stat -f %m "$SIBLING_LOCK" 2>/dev/null) ;;
        *)      LOCK_MTIME=$(stat -c %Y "$SIBLING_LOCK" 2>/dev/null) ;;
      esac
      LOCK_AGE=$(($(date +%s) - ${LOCK_MTIME:-0}))
      if [ "$LOCK_AGE" -ge 0 ] && [ "$LOCK_AGE" -lt 60 ]; then
        cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Another AskUserQuestion is already pending in this session. Wait for the user's answer (tool_result) before issuing the next AskUserQuestion. Do NOT issue multiple AskUserQuestion tool_use blocks in parallel within the same assistant turn — chroxy delivers them serially."}}
EOF
        exit 0
      fi
      # Stale lock (>60s old OR mtime unreadable — LOCK_MTIME defaulted to
      # 0 so LOCK_AGE ≈ epoch seconds, well past 60 → treated as stale and
      # reclaimed; explicit "fall back to reclaim" semantics for the
      # belt-and-suspenders case where stat fails for an unexpected reason).
      # Reclaim by removing + recreating so mtime resets and our new claim
      # is the active sibling. If a concurrent hook also detected staleness
      # and reclaimed first, our mkdir fails — deny ourselves so we don't
      # bypass the single-pending invariant the recovery is trying to
      # preserve.
      rm -rf "$SIBLING_LOCK" 2>/dev/null
      if ! mkdir "$SIBLING_LOCK" 2>/dev/null; then
        cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Another AskUserQuestion is already pending in this session. Wait for the user's answer (tool_result) before issuing the next AskUserQuestion. Do NOT issue multiple AskUserQuestion tool_use blocks in parallel within the same assistant turn — chroxy delivers them serially."}}
EOF
        exit 0
      fi
    fi
  fi
fi

# #5330: fallback decision when chroxy cannot obtain an explicit user decision
# (the daemon is unreachable, or the response is unparseable). The OLD behavior
# emitted permissionDecision:"ask", which makes claude prompt at the PTY — but
# in chroxy's model the user is on their phone, not at the keyboard, so "ask"
# wedges the session on a dialog no one can answer. Default to "deny" (fail
# closed): the tool is blocked with a reason claude can report/recover from,
# instead of an indefinite hang. Set CHROXY_HOOK_UNREACHABLE_DECISION=ask to
# restore the old behavior for a local-at-the-PTY setup.
FALLBACK_DECISION="${CHROXY_HOOK_UNREACHABLE_DECISION:-deny}"
case "$FALLBACK_DECISION" in
  ask|deny) ;;
  *) FALLBACK_DECISION="deny" ;;
esac

# Emit the fail-closed fallback ($1 = static reason string, no quotes/backslashes
# so it stays valid JSON) and exit.
emit_unreachable_fallback() {
  if [ "$FALLBACK_DECISION" = "ask" ]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}'
  else
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  fi
  exit 0
}

# ---- Shared: route a permission request to the phone via HTTP ----
# Expects $REQUEST to contain the JSON body to POST.
# Outputs the appropriate hookSpecificOutput JSON and exits.
route_to_phone() {
  # The payload goes over STDIN (`--data-binary @-`), not as an argv string. A
  # tool input can be large — a `Write` carries its whole `content` — and Linux
  # caps a SINGLE argv string at 128KB (MAX_ARG_STRLEN), so `-d "$REQUEST"` made
  # curl fail with E2BIG on a big write and the hook then reported the
  # fail-closed deny instead of prompting. Identical bytes either way for a
  # normal payload.
  CURL_ARGS=(-s -X POST "http://${HOOK_HOST}:${PORT}/permission" -H "Content-Type: application/json" --data-binary @- --max-time 300)
  if [ -n "$TOKEN" ]; then
    CURL_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
  fi

  RESPONSE=$(printf '%s' "$REQUEST" | curl "${CURL_ARGS[@]}")
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    # Daemon unreachable / curl timeout — the request never reached the phone.
    emit_unreachable_fallback "Chroxy could not reach the daemon to request your approval; the request never reached your phone. Failing closed (denied). Retry once Chroxy is reachable."
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
      # Reached the daemon but got no recognizable decision — also unanswerable
      # at the PTY, so fail closed rather than wedge on "ask".
      emit_unreachable_fallback "Chroxy received an unrecognized permission response from the daemon. Failing closed (denied)."
      ;;
  esac
  exit 0
}

# ---- Shared: does the protected-path / secret-read FLOOR cover this call? ----
# #7004. Returns 0 ("must prompt") when the daemon says the target is floored —
# and ALSO whenever the answer is anything other than an explicit `"floor":false`.
# So every failure mode (daemon unreachable, rate limited, unauthorized,
# unparseable body, 5xx) FAILS CLOSED into the normal prompt path instead of
# silently auto-allowing a `.env` / `id_rsa` / `.git` target.
#
# The floor is deliberately NOT reimplemented here. It is non-trivial path logic
# (lexical scan + an open(2)-faithful symlink component-walk, fail-closed on any
# resolution error) that lives in ONE place — packages/server/src/permission-floor.js
# — and is applied by the in-process providers through the very same function. A
# shell copy would be a second source of truth and would drift; this hook only
# asks the question. Expects $REQUEST to hold the PreToolUse payload.
#
# The `case` below is a FAST NEGATIVE PRE-FILTER, not a floor decision. The floor's
# verdict is a pure function of whether the tool input carries a path-NAMING field
# — PROTECTED_PATH_INPUT_FIELDS (file_path / path / notebook_path) or the codex
# `changes[]` array (see permission-floor.js `_matchesFloor`) — so a payload
# carrying NONE of them provably cannot be floored, and skipping the probe keeps a
# path-less tool (Bash / Task / WebFetch / WebSearch / AskUserQuestion / an MCP
# tool) on its exact pre-#7004 behavior: no round trip, no new daemon dependency,
# no added latency. It is a substring scan over the RAW payload, so it also matches
# nested keys and OVER-matches a literal `"path"` sitting in a value — over-probing
# is harmless (the daemon just answers floor:false); under-probing would not be,
# which is why the list must stay in sync. It IS kept in sync mechanically:
# tests/permission-hook-floor.test.js asserts this pattern covers every
# PROTECTED_PATH_INPUT_FIELDS entry, so extending the floor's field list without
# updating this line fails CI.
#
# #7020 — the pre-filter's soundness argument ("naming no path field provably
# cannot be floored") holds only over a COMPLETE, escape-free payload. Two guards
# below narrow that premise before the negative filter is trusted; both resolve
# toward the PROBE (fail closed), never toward the skip. Each guard states exactly
# what it PROVES — neither is a completeness proof, and #7043 tracks the residual:
#   1. LAST-BYTE SHAPE CHECK. A PreToolUse payload is always a JSON object, so a
#      complete one ends in `}` once trailing whitespace is discarded. A body that
#      does NOT is definitely unusable, and an unusable body proves nothing about
#      path fields, so it leaves the auto-allow path immediately — no probe,
#      because that way the guard holds even when the daemon is unreachable.
#      (`route_to_phone` then POSTs it to /permission, which cannot parse it
#      either and answers its 400 deny.) This catches the shapes that motivated
#      the guard — an EMPTY body and a PREFIX truncation (`{"tool_name":"Read"` …)
#      — and nothing more. It is a cheap heuristic, NOT a completeness check: a
#      truncation that happens to land on a `}` (`…,"permission_suggestions":{}`)
#      still looks complete here and still skips the probe. Tracked in #7043.
#      Trailing whitespace is trimmed first: `REQUEST=$(cat -)` strips trailing
#      NEWLINES only, so a `}\r\n`- or `} `-terminated payload would otherwise
#      fail this check and route EVERY auto/acceptEdits call to a phone prompt —
#      fail-closed, but it would destroy the lenient modes.
#   2. UNICODE ESCAPES. The pre-filter is a BYTE-level substring scan while the
#      daemon does a JSON-SEMANTIC field lookup, so a path-naming key spelled with
#      an escape parses to file_path server-side yet never matches the pattern
#      below. A `u`-escape of the letter f (byte sequence backslash-u-0-0-6-6,
#      followed by `ile_path`) is such a key. `\uXXXX` is the ONLY escape in the
#      JSON grammar that can spell one of these keys — the rest
#      (`\" \\ \/ \b \f \n \r \t`) yields none of `[a-z_]` — so probing whenever
#      the raw body contains `\u` closes the VALID-ESCAPE key-spelling gap on the
#      floor's own semantics rather than on an assumption about the producer's
#      serializer. That is the whole of what it proves. An INVALID escape (`\U`,
#      `\x`) is not covered: it does not match this arm, so the pre-filter takes
#      `return 1` and the daemon is never asked — the byte-scan-vs-semantic-lookup
#      divergence remains for bodies no JSON parser would accept. Also #7043
#      (which lists the candidate fixes: probe on any backslash, or a real
#      structural check). Over-probing here is harmless; a `\n` / `\"`-only
#      payload keeps the no-round-trip path.
floor_forces_prompt() {
  case "$REQUEST" in
    *'"file_path"'*|*'"path"'*|*'"notebook_path"'*|*'"changes"'*) ;;
    # (1) a \uXXXX escape may spell a path-naming key the byte scan cannot see.
    *'\u'*) ;;
    # (2) #7043: an INVALID escape can hide one too, and never reaches the
    # daemon's fail-closed parse because this pre-filter short-circuits first.
    # `\U0066ile_path` is the worked example: the `\u` arm above is
    # case-SENSITIVE, so it missed. Rather than enumerate malformed escapes,
    # match "a backslash NOT starting one of JSON's valid non-unicode escapes"
    # (`" \ / b f n r t`). That covers `\U`, `\x` and every other invalid form,
    # while deliberately KEEPING the `\n` / `\"` fast path the Bash tool relies
    # on - those cannot spell a key, and #7035 pinned that they stay fast.
    *'\'[!\"\\/bfnrt]*) ;;
    *)
      # Fast-path candidate. ONLY here is a completeness proof load-bearing, so
      # only here is it paid for - running it earlier would scan large payloads
      # that were going to probe anyway (a 200KB Write blew the hook's timeout
      # and got SIGKILLed, which is a dead hook, not a slow one).
      #
      # The pre-filter's justification is that a payload naming no path field
      # PROVABLY cannot be floored. That proof needs all the bytes, and #7043
      # showed a last-byte `}` test does not establish it: a truncation can land
      # on `}` (`..."permission_suggestions":{}`), carry no key literal, and take
      # the skip. Shape + brace balance instead.
      REQUEST_TRIMMED=${REQUEST%"${REQUEST##*[![:space:]]}"}
      case "$REQUEST_TRIMMED" in
        '{'*'}') ;;
        *) return 0 ;;
      esac
      # Bash pattern substitution is superlinear on long strings, so the scan is
      # size-bounded. Past the bound the proof is simply not attempted and the
      # call falls through to a prompt - declining to claim a proof is the whole
      # point. A >64KB payload naming no path field is rare; a dead hook is not
      # an acceptable price for auto-allowing one.
      if [ ${#REQUEST_TRIMMED} -gt 65536 ]; then
        return 0
      fi
      # Counts braces inside strings too, so `awk '{print}'` is judged on its
      # literal braces rather than its structure. That is an over-approximation
      # in the SAFE direction: a miscount can only ever ADD a probe/prompt, never
      # skip one. RESIDUAL, precisely: this is not a parse. A truncation whose
      # literal brace counts happen to balance is still not detected; closing
      # that needs a structural walk costing about what the probe costs (#7043).
      FLOOR_OPEN=${REQUEST_TRIMMED//[!\{]/}
      FLOOR_CLOSE=${REQUEST_TRIMMED//[!\}]/}
      if [ ${#FLOOR_OPEN} -ne ${#FLOOR_CLOSE} ]; then
        return 0
      fi
      # A COMPLETE, escape-clean payload naming no path field: the floor cannot apply.
      return 1
      ;;
  esac
  # Payload over STDIN, not argv — see route_to_phone's note on MAX_ARG_STRLEN.
  # Here it matters doubly: an argv failure on a large `Write` would fail closed
  # into a prompt for a file the floor never covered.
  FLOOR_ARGS=(-s -X POST "http://${HOOK_HOST}:${PORT}/permission-floor" -H "Content-Type: application/json" --data-binary @- --max-time 10)
  if [ -n "$TOKEN" ]; then
    FLOOR_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
  fi
  FLOOR_RESPONSE=$(printf '%s' "$REQUEST" | curl "${FLOOR_ARGS[@]}")
  FLOOR_EXIT=$?
  if [ $FLOOR_EXIT -ne 0 ]; then
    return 0
  fi
  # ONLY an unambiguous, TOP-LEVEL `"floor":false` clears the short-circuit.
  # Anything else — `true`, an error body, an empty response, or a body a real
  # JSON parser cannot make sense of — keeps the prompt.
  #
  # #7017 — this is a real parse (via `node -e`), not a substring grep. A grep
  # keyed on the FIRST `"floor"` occurrence anywhere in the body is foolable by
  # a NESTED key (`{"nested":{"floor":false},"floor":true}`), an ARRAY-nested
  # key (`{"a":[{"floor":false}],"floor":true}`), or a DUPLICATE top-level key
  # (`{"floor":true,"floor":false}` — note `JSON.parse`'s own last-write-wins
  # would silently clear this one too, so a raw occurrence count is checked
  # BEFORE ever parsing, rather than trusting which duplicate `JSON.parse`
  # keeps). `node` is a safe dependency here: this hook only ever runs inside a
  # chroxy-spawned session (the CHROXY_PORT guard at the top of this file), and
  # the daemon that spawned it IS a node process, so `node` is on PATH by
  # construction — no new dependency is introduced.
  #
  # Clearance requires ALL of:
  #   1. the literal substring `"floor"` appears EXACTLY ONCE in the raw body
  #      (this alone rules out nested / array-nested / duplicate-key, without
  #      needing to trust which value a parser would pick for a duplicate)
  #   2. the body parses as JSON
  #   3. the parsed value is a plain object (not an array, not a scalar)
  #   4. its single top-level `floor` property is `=== false`
  # A parse failure, a non-object top level, or `node` itself being
  # unavailable all make the substitution empty, which fails the `= "false"`
  # comparison below and prompts — fail-closed by construction, not by a
  # special case.
  FLOOR_VALUE=$(printf '%s' "$FLOOR_RESPONSE" | node -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  try {
    const marker = "\"floor\"";
    let count = 0;
    let idx = 0;
    while ((idx = data.indexOf(marker, idx)) !== -1) {
      count++;
      idx += marker.length;
    }
    if (count !== 1) {
      process.stdout.write("true");
      return;
    }
    const parsed = JSON.parse(data);
    const cleared = parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.floor === false;
    process.stdout.write(cleared ? "false" : "true");
  } catch {
    process.stdout.write("true");
  }
});
' 2>/dev/null)
  if [ "$FLOOR_VALUE" = "false" ]; then
    return 1
  fi
  return 0
}

# Auto mode — allow everything without routing to the phone, EXCEPT a target the
# protected-path / secret-read floor covers (#7004). #6794/#6803 gave that floor
# precedence over every lenient mode for the in-process providers, but this hook
# decides auto/acceptEdits itself and never reaches permission-manager.js — so
# claude-tui (the DEFAULT provider) and cli-session were auto-allowing `.env` /
# `id_rsa` reads and `.git`/`.claude` writes with no prompt. A floored target is
# never DENIED here; it is routed to the normal prompt, exactly as the in-process
# path falls through to one.
if [ "$PERM_MODE" = "auto" ]; then
  if floor_forces_prompt; then
    route_to_phone
  fi
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
      # #7004 — same floor precedence as auto above. Mirrors permission-manager.js,
      # whose acceptEdits short-circuit is likewise gated on the floor.
      if floor_forces_prompt; then
        route_to_phone
      fi
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
