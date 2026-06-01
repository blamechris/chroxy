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

## How to add evidence to this doc

When new repro evidence lands:
1. Append a dated entry under "Decision log"
2. Update "Wedge-point candidates" plausibility ratings if confirmed/refuted
3. Move resolved candidates to a "Ruled out" section
4. Update "Current symptom" if the symptom shifts

When a wave ships:
1. Add a new section under "Historical waves"
2. List PRs, fix description, and current status (working / superseded / regression risk)
