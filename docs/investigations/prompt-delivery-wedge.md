# Prompt Delivery Wedge — Investigation Tracker

**Status:** Active investigation — last live repro 2026-06-01 03:52 UTC on v0.9.29
**Owner:** @blamechris
**Related open issues:** #4668 (post-deny single-Q retry wedge), #4654 (long-term multi-Q support), #4635 (pure all-single-select keystroke validation), #4651 (Other / freeform answers)
**Related closed (but incomplete) issues:** #4678 (multi-line manifestation fixed by #4679; multi-session-restore manifestation still active)

## Why this doc exists

Chroxy's "prompt sent → no response" wedge has been chased across 20+ PRs over ~10 days. Each fix addressed a real manifestation but the symptom keeps recurring under new conditions, and several "shipped fixes" turned out to address adjacent bugs rather than the underlying mechanism. This doc captures what we actually know, what we're guessing, what's been tried, and what NOT to do — so the next fix is targeted instead of speculative.

## Current symptom (live repro 2026-06-01 03:52 UTC)

1. Chroxy starts with N≥2 sessions in `session-state.json` (from a prior run)
2. Sessions restore successfully; WS backpressure warning fires immediately at client auth (`bufferedAmount 65737 exceeds warning threshold (65536 bytes)`)
3. User creates a NEW (3rd+) TUI session via the `+` button
4. User sends a single-line prompt (string of ~250 chars, no embedded newlines)
5. Chroxy log shows `[ws-forwarding] Broadcasting stream_start: <id> (session ...)` within ~4 seconds
6. **Then nothing.** No further log entries for that session for minutes.
7. claude TUI process for the new session: ~0.3% CPU (sleeping), <3 seconds accumulated CPU time
8. Sink dir (`/var/folders/.../chroxy-claude-tui/s-<uuid>/`) contains only `permission-mode` and `settings.json` — no hook artifacts
9. Dashboard shows "Working… last activity Xs ago" — but this is chroxy's heartbeat, NOT actual TUI activity. Misleading.
10. The 5-min stream-stall watchdog (#4467) eventually fires and surfaces an error chip, but by then the user has retried 3 times.

## What we VERIFIED in the code path (not guessing)

From a code trace of `packages/server/src/claude-tui-session.js` (lines 747–944):

1. **`stream_start` is emitted at line 818, BEFORE the PTY write.** Its presence in the log proves the turn was initiated; it proves NOTHING about whether the prompt actually reached the PTY. (Per the `#4010` comment block.)
2. **`_writePtyTextThrottled` writes to `this._term`** — per-session, not a shared queue. The original #4678 "shared throttle starvation" hypothesis is **wrong**.
3. **`_waitForPrompt` polls the TUI's session file for `status=idle`** with 100ms sleeps and a `TURN_PROMPT_WAIT_MAX_MS` (5000ms) deadline. On timeout it logs a warning and **proceeds anyway** (line 835) — it cannot silently hang forever.
4. **Per-char throttle loop uses `setTimeout(..., PROMPT_CHAR_DELAY_MS)`** (~1ms per char). A 250-char prompt should complete in ~250ms.
5. **`this._term.write(ch)` is synchronous** into node-pty's xterm.js wrapper. node-pty does NOT block on drain — bytes queue into an internal buffer. There is no drain callback wired.
6. **Sink dir is per-session** with random UUID — cross-session reuse is astronomically unlikely.
7. **`_consumedFiles` Set is per-session** — no cross-session contamination of hook-file tracking.
8. **Hook poll loop has `HOOK_TIMEOUT_MS` deadline** (~30s default) — also cannot hang forever.

## What we DON'T have (observability gaps — the actual problem)

From a cross-cut of memory notes and prior issue triage:

1. **No per-stage timing in `sendMessage`.** We cannot tell whether the wedge sits in `_waitForPrompt`, in `_writePtyTextThrottled`, in the hook poll loop, or after the write completed.
2. **No log confirming the PTY write completed.** `_writePtyTextThrottled` returns `true` but doesn't log byte count or elapsed ms.
3. **No drain signal on `this._term.write()`.** node-pty buffers bytes silently if claude TUI's read end is back-pressured. No warning, no metric.
4. **No WS bufferedAmount correlation at sendMessage entry.** We see backpressure at auth time, but don't know whether subsequent broadcasts (incl. `stream_start`) were silently dropped per `ws-broadcaster.js:64-73`.
5. **No "prompt delivered to PTY" event.** Only `stream_start` (which fires pre-write at line 818) and `stream_end` (after Stop hook). The gap between them is invisible.
6. **No `_lastProbeSawStatus` log when degraded.** The "degraded probe" branch exists in `_waitForPrompt` but only fires its message on the timeout warning — not on routine timeouts.

## Wedge-point candidates (ranked by code-trace audit)

| Rank | Location | Plausibility | Evidence needed to confirm/refute |
|------|----------|--------------|-----------------------------------|
| 1 | `claude-tui-session.js:829` — `_waitForPrompt` degraded probe | **HIGH** | Log `_lastProbeSawStatus` on every call; check session file readability for 3rd+ session |
| 2 | `claude-tui-session.js:936-943` — hook poll loop never sees stop-file | **HIGH** | Log sink dir state at HOOK_TIMEOUT; check if claude PTY exited or hook process crashed |
| 3 | `ws-broadcaster.js:64-73` — backpressure drops post-restore broadcasts | **MEDIUM** | Log per-broadcast `bufferedAmount` + drop counter for first 5s after auth |
| 4 | `_writePtyTextThrottled` per-char buffer stall in node-pty | **MEDIUM** | Wrap `this._term.write()` with byte-count + elapsed-ms logging |
| 5 | Sink dir cross-contamination | **LOW** | UUID-named — astronomically unlikely but verifiable |

**Critical:** ranks 1 and 2 are roughly equal-plausibility. We cannot pick between them without instrumentation. The wedge symptom (`stream_start` then silence) is consistent with EITHER stage stalling.

## Historical waves — what's been tried

### Wave 1: paste-detector throttle (v0.9.2)
**PRs:** #4270, #4327, #4359
**Fix:** Wrap PTY writes in `\x1b[?2004l ... \x1b[?2004h` + per-char throttle to defeat claude TUI v2.1.x's byte-arrival-rate paste detector.
**Status:** Working; do not regress.

### Wave 2: stream-stall watchdog (v0.9.23–v0.9.25)
**PRs:** #4475, #4504, #4608, #4614, #4618, #4640, #4646
**Fix:** 5-min recovery watchdog on silence post-`stream_start`; emit synthetic `tool_result` to clear dashboard footer pill; full turn teardown on AskUserQuestion stall.
**Status:** Working — recovers from wedge but does NOT prevent it. By the time it fires the user has retried 3 times.

### Wave 3: AskUserQuestion permission-hook hardening (v0.9.26–v0.9.28)
**PRs:** #4649, #4669, #4675, #4666
**Fix:** Permission-hook denies multi-question forms (forces retry as singles); sibling-deny serializes parallel AskUserQuestion tool_uses in one turn; dashboard suppresses dead multi-question form UI.
**Status:** Mitigates multi-question parallel concurrency. #4668 still open — post-deny single-Q retry wedges anyway.

### Wave 4: multi-line bracketed paste (v0.9.29)
**PR:** #4679
**Fix:** Multi-line prompts (embedded `\n` from Shift+Enter) delivered as single bracketed-paste write.
**Status:** Fixes multi-line manifestation. **Does NOT fix the multi-session-restore single-line wedge** observed 2026-06-01.

## Why the proposed "option 3" fix would have been wrong

The proposed v0.9.30 fix was "bypass the per-char throttle for new-session first-prompt." From the audit:

- **Throttle is per-session.** It cannot be starved by other sessions. Bypassing for "first prompt" doesn't address a real mechanism.
- **Most plausible wedge points are rank 1 (`_waitForPrompt`) and rank 2 (hook poll loop) — not the throttle itself** (rank 4).
- **Bypassing the throttle would re-trigger paste-detector wedge** (Wave 1) — regression risk for a fix that doesn't address the actual cause.
- **Guess-fix without instrumentation** leaves us in the same situation next time the symptom recurs under different conditions: ship something plausible, watch it fail, ship something else.

## Recommended approach (phased)

### Phase 1 — Ship instrumentation as v0.9.30 (zero behavior change)
Goal: make the next repro diagnostic instead of opaque. Concrete adds:
1. `_waitForPrompt` — log entry/exit, elapsed ms, `_lastProbeSawStatus`, return value
2. `_writePtyTextThrottled` — log entry, byte count, code-point count, elapsed ms, completion
3. Hook poll loop — log iterations, sink dir entry count, files consumed per iteration
4. `ws-broadcaster.js` — log per-broadcast `bufferedAmount` and drop decisions during first 10s after each client auth
5. `sendMessage` — log a single summary line at completion: `sendMessage done sessionId=... messageId=... waitForPromptMs=... writeMs=... pollMs=... hookCount=...`

All new logs gated behind existing `[claude-tui-session]` / `[ws]` / `[ws-forwarding]` log levels — no new env vars, no debug flag. Verbose enough to diagnose, terse enough to live in prod.

### Phase 2 — Capture next live repro on v0.9.30
With instrumentation, a single repro tells us exactly which stage stalled. Reopen #4678 with the new evidence and the timing log.

### Phase 3 — Targeted fix for the confirmed cause
Only after Phase 2 evidence. Likely candidates depending on confirmed cause:
- If `_waitForPrompt` stalls on a degraded probe: surface degraded state earlier and fall back faster
- If hook poll loop never sees stop-file: check sink dir lifecycle on session create
- If WS backpressure drops broadcasts: queue critical broadcasts (incl. `stream_start`) through a drain-aware sender
- If node-pty buffer stalls: add drain callback + write timeout

## What NOT to do (footguns)

- **Don't bypass the per-char throttle.** Wave 1 history shows this re-triggers paste-detector wedge. The throttle is load-bearing.
- **Don't add "if N sessions restored, do X" heuristics.** Symptom-driven, not root-cause.
- **Don't touch the multi-line bracketed-paste path (#4679).** It's working; the current wedge is single-line.
- **Don't merge any behavioral fix without instrumentation logs proving it landed.** We've shipped 4 "fixes" that addressed adjacent bugs.
- **Don't trust the dashboard's "Working… last activity Xs ago" pill.** It's chroxy's heartbeat, not TUI activity. Use chroxy log + claude TUI CPU + sink dir state as the ground truth.

## Decision log

| Date | Decision | Reason |
|------|----------|--------|
| 2026-06-01 | Cut v0.9.29 with multi-line bracketed-paste fix (#4679) | Addressed multi-line manifestation only. Did NOT address multi-session-restore wedge. |
| 2026-06-01 | Pause; full audit before option 3 | User requested investigation rather than another guess-fix. |
| 2026-06-01 | Plan v0.9.30 as instrumentation-only release | Audit showed proposed "bypass throttle for first prompt" fix aimed at wrong layer (rank 4); rank 1 and 2 are higher-plausibility but require evidence to discriminate. |
| 2026-06-01 | **v0.9.30 instrumentation produced a complete diagnosis on first repro.** | The wedge is NOT in `sendMessage`'s prompt-write path at all. It's in the AskUserQuestion answer round-trip — chroxy writes the 1-byte option-digit to claude TUI, TUI never emits PostToolUse. Full evidence below. **Investigation pivots from #4678 (which was effectively a misdiagnosis) to #4668.** Wedge-point candidates 1, 2, 3, 4 from the audit table are all RULED OUT — the wedge sits downstream of all of them, inside claude TUI's keystroke processing for AskUserQuestion answers. |

## 2026-06-01 repro on v0.9.30 — full per-stage trail

Live repro on the multi-session-restore conditions described in "Current symptom" above. Single-line prompt asking claude to call AskUserQuestion 4 times.

```
04:47:53.948  sendMessage start         (msg=14fd4a-1 bytes=243)
04:47:53.949  Broadcasting stream_start (msg=14fd4a-1)
04:47:53.950  waitForPrompt             elapsedMs=0 sawStatus=true ready=true
04:47:53.951  writePtyText              path=paste codePoints=243 elapsedMs=0 completed=true
04:47:59.088  hookPoll heartbeat        iters=35  elapsedMs=5137   sinkFiles=2 consumed=0
04:48:04.233  hookPoll heartbeat        iters=69  elapsedMs=10282  sinkFiles=2 consumed=0
04:48:08.311  AskUserQuestion pending   tool=toolu_011G... questions=4 options.q1=4
04:48:08.311  WARN: 4-question form, only q1 will be answered (#4604)
04:48:09.368  hookPoll heartbeat        iters=103 elapsedMs=15417  sinkFiles=3 consumed=1
04:48:12.349  Permission request broadcast to dashboard
04:48:12.393  AskUserQuestion pending   tool=toolu_0192... questions=1 options.q1=4   ← _pendingUserAnswer OVERWRITTEN
04:48:14.512  hookPoll heartbeat        iters=137 elapsedMs=20561  sinkFiles=5 consumed=2
[8 more 5s heartbeats — sinkFiles=5 consumed=2, no progress]
04:49:13.484  user_question_response received  toolUseId=toolu_0192... answer.length=12
04:49:13.485  writePtyText              path=throttled codePoints=1 bytes=1 elapsedMs=0 completed=true   ← 1-byte answer keystroke DELIVERED
[6 more 5s heartbeats — TUI completely silent post-keystroke]
04:49:43.485  WARN: AskUserQuestion stall: tool=toolu_0192... — claude TUI never emitted
              PostToolUse after answer write (30000ms). Likely a multi-question form (#4604).
              Tearing down turn so the session is recoverable.
04:49:43.488  Broadcasting stream_end
04:49:43.615  hookPoll exit             iters=725 elapsedMs=109664 consumed=2 stopFound=no
              aborted=no ptyExited=no stillBusy=no
```

### What this proves

- **Prompt-delivery path is healthy.** `_waitForPrompt` → 0ms, `_writePtyText` → 0ms via paste-path (the dashboard composer appended a `\n`, so #4679's multi-line bracketed-paste kicked in for what we thought was "single-line" — both work).
- **Hook poll loop is alive and consuming files.** Heartbeats every 5s, sink-file count rose from 2 → 5 as claude TUI emitted PreToolUse hooks.
- **Claude TUI is fully responsive.** It received the prompt, planned, called AskUserQuestion, and accepted permission denials.
- **The wedge is in the answer-keystroke round-trip.** Chroxy wrote 1 byte at `04:49:13.485`; TUI emitted nothing for 30s; watchdog fired with the exact correct diagnosis pre-written into its WARN.

### Ruled-out hypotheses

| Rank | Candidate | Verdict | Evidence |
|------|-----------|---------|----------|
| 1 | `_waitForPrompt` degraded probe | **RULED OUT** | `elapsedMs=0 sawStatus=true ready=true` |
| 2 | hook poll loop never iterates | **RULED OUT** | 725 iters over 109s, files consumed as they appeared |
| 3 | WS backpressure drops broadcasts | **RULED OUT** | All broadcasts present in log, dashboard rendered the question card |
| 4 | PTY internal buffer stall | **RULED OUT** | Both prompt write and answer keystroke completed in 0ms |
| 5 | sink dir cross-contamination | **RULED OUT** | Per-session UUID sink dirs as designed |

### Confirmed root cause

This is the **#4668 manifestation** (`feedback_multi_question_post_deny_wedge.md` memory note): the post-deny single-question retry wedge. Mechanism:

1. Claude calls AskUserQuestion with 4 questions
2. Chroxy WARNs "only q1 will be answered" + sets `_pendingUserAnswer = {tool=toolu_011G...}`
3. Permission hook broadcasts permission request to dashboard
4. Claude (in parallel, in the same assistant turn) retries with a fresh single-question call → `_pendingUserAnswer` is OVERWRITTEN to `{tool=toolu_0192...}`
5. Dashboard renders the question card, user picks an option
6. Dashboard sends `user_question_response` back for `toolu_0192...`
7. Chroxy writes the option-digit keystroke to PTY → delivered in 0ms
8. Claude TUI's input state is misaligned (likely it's still showing the FIRST multi-q form, or its `askuserquestion-active` lock from #4669 has corrupted the interaction state)
9. TUI consumes the keystroke as a no-op or option-toggle; never submits, never emits PostToolUse
10. 30s later the AskUserQuestion stall watchdog fires and tears the turn down

### Sink dir state at wedge time (confirms hypothesis)

```
askuserquestion-active/          ← sibling-deny lock from #4669, never cleaned up
permission-mode
pre-05B67...json                 ← PreToolUse for first call (multi-q, denied)
pre-2690...json                  ← PreToolUse for second call (single-q retry)
settings.json
```

No `post-*` files. The first PreToolUse never got a PostToolUse, which means the permission-hook chain for the first call was denied at the PreToolUse stage and the cleanup path that releases `askuserquestion-active` never ran. The second call's keystroke landed on a TUI whose input state was still oriented at the first call's (denied) form.

## Next steps (refined from earlier "Phase 3")

The wedge is now firmly **#4668**, not #4678. The doc's earlier "Phase 3 targeted fix" was speculating about prompt-delivery layer fixes; the actual fix shape now becomes:

1. **`_pendingUserAnswer` → Map keyed by toolUseId** (the long-term fix from `feedback_multi_question_post_deny_wedge.md`). Prevents the overwrite that happens when claude retries with a sibling tool_use in the same turn.
2. **`respondToQuestion(toolUseId, ...)`** signature change to match.
3. **Cleanup the `askuserquestion-active` lock on permission DENY**, not just on PostToolUse. The current chain only releases the lock when PostToolUse fires — but a denied tool_use NEVER fires PostToolUse, so the lock leaks and corrupts the next call's interaction.
4. **Either suppress the dashboard's permission-card retry OR make answer-keystroke writing tool_use-aware** so a keystroke for `toolu_0192...` doesn't land in a TUI form bound to `toolu_011G...`.

Will be tracked under #4668 (existing open issue). v0.9.31 should ship the Map-keyed refactor as the minimum viable fix.

## How to add evidence to this doc

When new repro evidence lands:
1. Append a dated entry under "Decision log"
2. Update "Wedge-point candidates" plausibility ratings if confirmed/refuted
3. Move resolved candidates to a "Ruled out" section
4. Update "Current symptom" if the symptom shifts

When a wave ships:
1. Add a new section under "Historical waves"
2. List PRs, fix description, and current status (working / superseded / regression risk)
