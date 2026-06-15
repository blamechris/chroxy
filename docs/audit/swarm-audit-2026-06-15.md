# Chroxy Swarm Hardening Audit — 2026-06-15

> Scope: server (`packages/server`), shared store-core (`packages/store-core`), protocol
> (`packages/protocol`), and claude-hooks (`packages/claude-hooks`). Findings below are the
> CONFIRMED / PARTIAL set after an adversarial verification pass; rejected findings are in the
> appendix so they are not re-litigated. Every cited `file:line` was checked against `main` at the
> time of writing.

> **Status (updated post-merge).** This audit drove a hardening marathon; the roadmap in §4 is
> partly delivered:
> - **P0-1…P0-5** — all merged (supervisor crash-loop, tunnel cold-start, worktree-restore wipe,
>   bound-token permission-rules guard, `CLAUDE_PROVIDER_NAMES` default-provider fallback).
> - **P1-1, P1-2, P1-3, P1-6, P1-7, P1-9, P1-10** — merged.
> - **P1-8** deferred to #5867 (BYOK credential / paid-auth hot path); **P1-4/P1-5/P1-11** remain
>   (Device-class, need a live TUI session to validate).
> - **P2** is the open structural-debt backlog (tracked as `from-review` issues, e.g. #5850, #5858,
>   #5872). See §4 P2 table.
>
> Lives in `docs/audit/` alongside the other tracked strategic audits (`tui-hardening-2026-06-07.md`,
> `june15-billing-strategy-2026-06-14.md`); `.gitignore` masks the plural `docs/audits/` and
> `docs/audit-results/` (plus `docs/qa-log.md`, `docs/smoke-test.md`) but not this singular
> `docs/audit/` path, so it is tracked.

---

## 1. Executive summary

Chroxy is structurally sound but carries one **critical** reliability defect and a cluster of
**high**-severity gaps concentrated where it matters most for a phone-over-flaky-tunnel product:
the supervisor's self-restart, the Cloudflare tunnel's cold-start recovery, the worktree
restore path, and the now-default `claude-tui` provider. The single worst issue is a guaranteed
**supervisor crash-loop** (the standby health server keeps the port while the replacement child
tries to bind it — `EADDRINUSE` → `process.exit(1)` → repeat to the restart cap), which silently
bricks the daemon on the very first crash and is invisible to the test suite because the fork is
mocked. After that, the tunnel cold-start timeout poisons the retry budget and disables all future
recovery via a reused `intentionalShutdown` flag; graceful shutdown deletes the worktrees it just
serialized as live (so worktree sessions never restore); and the new default provider can
hard-reject a stale model id where every other Claude provider soft-falls-back. **TUI is the
riskiest *surface* by volume** — it is the largest, most fragile, screen-scrape-driven subsystem
and dominates the finding count — but its individual defects are mostly low/medium leaks and
fragilities, not crash-class bugs. The genuinely service-killing issues live in the supervisor and
tunnel. The rest is a long, healthy tail of DRY/SOLID debt (four god-files totalling ~14k lines)
and latent defense-in-depth gaps that are correct today but unguarded against the next edit.

---

## 2. TUI hardening (the user's top priority)

`claude-tui` is now the **default provider** (`DEFAULT_PROVIDER`, #5819/#5822), driving the real
`claude` interactive TUI over a persistent PTY with no structured answer channel — every
interaction is empirically-pinned keystroke emission plus hook-file polling. This section groups the
confirmed TUI findings into four themes. None are crash-class, but several degrade the headline
reliability the user cares about on exactly the slow/flaky link chroxy targets.

### Theme A — Turn lifecycle & state-machine drift (the per-turn teardown problem)

The root cause for most of this theme: `ClaudeTuiSession` is the **only** session subclass that
does **not** route per-turn teardown through the base `_clearMessageState()`. `CliSession`
(`cli-session.js:720,1196`) and `SdkSession` (`sdk-session.js:977,1006`) call it on every
turn-end; the TUI only calls it once, inside `destroy()` (`claude-tui-session.js:3502`). Its three
turn-end paths — success (`2336-2371`), `_finishTurnError` (`2702-2770`), `_teardownTurn`
(`3235-3303`) — hand-roll `_activeTurn=null; _isBusy=false; _currentMessageId=null` inline and each
omits a *different* subset of the base reset. This single architectural divergence produces four
distinct findings:

| Finding | Sev | What leaks/breaks on a turn-end | Fix site |
|---|---|---|---|
| `_pendingBackgroundCommands` never cleared per-turn | low (leak) | Map of `toolUseId→command` for run-in-background Bash strands an entry whenever a turn errors/aborts before PostToolUse, or PostToolUse lacks the shell-id pattern. Bounded (tiny strings, freed at `destroy()`) but a slow drip across every turn of a long-lived persistent-PTY default-provider session. | `claude-tui-session.js` success ~2370, `_finishTurnError` ~2744, `_teardownTurn` ~3266, `_onPtyGone` ~1126 |
| `askuserquestion-active` lock not cleared on success | low (reliability) | The shared sibling-lock file is removed on PostToolUse / teardown / destroy but **not** on the Stop-hook success path (`2336-2371`). If an answered question's PostToolUse never fires while the Stop hook does, the lock leaks and denies the next turn's AskUserQuestion — **bounded to ≤1 spurious deny inside the 60s stale-reclaim window** (`permission-hook.sh:163-184`). | add `_clearAskUserQuestionLock()` after ~2367 |
| Orphan AskUserQuestion stall watchdogs not cleared on success | low (fragility) | `_clearAllAskUserQuestionWatchdogs()` runs on every teardown path **except** success. An armed 30s watchdog surviving into a *new* busy turn can tear down a legitimately-busy unrelated turn (the `!_pendingUserAnswer && !_isBusy` guard at `form-driver.js:747` only no-ops on clean idle). | add `_clearAllAskUserQuestionWatchdogs()` after ~2362 |
| Four teardown paths re-implement `_clearMessageState` inline (DRY) | low (DRY) | The proximate cause of all of the above; next field added to `_clearMessageState` silently skips the TUI provider (as #4307 nearly did). | extract a shared `_clearTurnEndState()` helper |

**Recommended consolidation:** introduce a single `_clearTurnEndState()` helper owning the
timer/watchdog/lock/`_pendingBackgroundCommands` clears, called by the success path and
`_finishTurnError`; keep two real asymmetries out of it — (a) `_finishTurnError` deliberately does
**not** `_pendingUserAnswers_clearAll()` (no Ctrl-C issued, sibling answers in flight — comment
`2745-2761`), and (b) `_teardownTurn` does. Add a CI lint asserting no per-turn site hand-writes the
`_isBusy`/`_currentMessageId` pair outside the helper, mirroring the existing opt-forwarding lint
discipline. **User-facing failures prevented:** spurious "couldn't deliver your answers" denials on
the *next* question, and a rare mid-turn teardown of an unrelated busy turn.

A fifth, separable lifecycle finding:

- **Client vanishing mid-AskUserQuestion can wedge the session busy for up to the 2h hard cap**
  (`claude-tui-session.js:2557-2563`, `2829-2836`, `2849-2852`) — **partial, low.** When a question
  is shown, `_suspendBackstopsForPendingQuestion()` cancels every backstop *except* the 2h hard cap,
  and the 30s stall watchdog only arms *after* an answer is written. So a phone that drops the moment
  a question appears leaves the session `_isBusy=true` until `_handleHardTimeout`. **Mitigation the
  finding under-counted:** `user_question` is in `PROXIED_EVENTS` and recorded to history
  (`session-manager.js:2162,2189`), so a reconnecting phone gets the question replayed and can answer
  it — the realistic flaky-tunnel case self-heals. Only the *never-reconnects* case sits for 2h, which
  is the intended hard-cap fallback. Optional hardening: in `_handleClientDeparture`
  (`ws-server.js:2092`), if the departing client was the sole subscriber and `_pendingUserAnswers` is
  non-empty, arm a bounded (few-minute) session-level recovery. **Do not** add a blanket pre-answer
  watchdog at the emit — it would regress the deliberate human-bottleneck suspend (#5318).

- **`destroy()` defers clearing the mirror coalescer + first-turn-nudge timers to `_onPtyGone`**
  (`claude-tui-session.js:3392-3509`; cleared only at `1116`/`1132`) — **confirmed, low.** `destroy()`
  clears every other timer inline but relies on a later `onExit→_onPtyGone` for these two. The
  first-turn submit nudge timer (`3027/3030`, `FIRST_TURN_SUBMIT_NUDGE_MS=1500`) is **not** `unref()`'d
  (unlike every sibling), so it can keep the event loop alive ~1.5s during shutdown. Fix: add
  `_clearTerminalMirror()` + `_clearFirstTurnSubmitNudge()` to `destroy()` (both idempotent) and
  `.unref()` the nudge timer.

### Theme B — PTY mirror (terminal live-view) reliability

| Finding | Sev | Failure |
|---|---|---|
| **Active-session switch never re-syncs the mirror gate** (`ws-client-manager.js:242-251`; same gap `session-handlers.js:53,253`) | **medium** | `setActiveSession()` mutates `client.activeSessionId` — read by both the mirror gate and the delivery filter — but never calls `_syncTerminalMirror` for old/new session. A client opted into session A's terminal (active-but-not-subscribed, the common Output-tab case) that switches to B falls out of the delivery filter for A, yet **A's coalescer stays ON forever** (per-redraw String concat + 50ms timer emitting to nobody) — exactly the waste #5837/#5844 set out to kill. Masked only because the dashboard happens to send a paired `terminal_unsubscribe`; breaks for mobile, reconnect races, message reordering, any future client. |
| **Mirror gate predicate hand-duplicated 3× and diverges from `isSessionViewer`** (`ws-server.js:2200-2204`, `ws-forwarding.js:117-123`, vs `handler-utils.js:212-215`) | **medium** | The gate and the delivery filter MUST be byte-identical (gate-true/filter-false = waste; gate-false/filter-true = **black terminal for a real viewer**). Both inline the viewer clause instead of calling the shared `isSessionViewer` helper whose own comment says it exists "so the copies can't drift." Latent, not live. |
| **Live mirror has no snapshot/resync — a backpressure-dropped frame silently corrupts the viewer** (`ws-forwarding.js:164-176`; drop at `ws-broadcaster.js:93-106`) | **medium** | `terminal_output` is transient (no history/normalizer/replay — "the mirror was never a snapshot"). For a raw ANSI byte stream, a single dropped coalesced frame desyncs xterm's cursor/SGR/scroll-region/alt-screen state with **no resync path** until claude happens to full-repaint. The backpressure trigger (slow link) is chroxy's literal target deployment. Phase 3 made the mirror interactive, so a desynced grid means keystrokes hit the wrong cursor. |

**Recommended fixes (these three compose into one PR cleanly):**
1. Add an exported `terminalMirrorRecipient(client, sid)` to `handler-utils.js`
   (`= terminalSessionIds?.has(sid) && isSessionViewer(client, sid)`) and call it from **both**
   `terminalSubscriberFilter` and `_syncTerminalMirror` — collapses the 3× duplication and makes the
   gate provably equal to the delivery audience. (Closes finding 2.)
2. In `handleSwitchSession` (and the destroy re-home), capture the prev active id **before**
   `setActiveSession` and call `syncTerminalMirror(prev)` + `syncTerminalMirror(target)` — or fold
   the two syncs into `setActiveSession` itself so every caller inherits the invariant. (Closes
   finding 1.) Cleanest: route via the transport callback already wired at `ws-server.js:743`.
3. Add a `terminal_resync` client message that forces a full repaint. **Note the trap:**
   `resizeTerminal` (`claude-tui-session.js:1830`) early-returns on an unchanged size, so re-applying
   the same size is a no-op — recovery must toggle the size (`cols±1` then back) or drive SIGWINCH.
   Also surface `client._backpressureDrops` (`ws-broadcaster.js:94`) for terminal subscribers so the
   client can offer a "reconnect terminal" affordance. (Closes finding 3.)

### Theme C — Prompt-driving fragility (AskUserQuestion / form-driver)

This is the structurally scariest TUI area: **there is no programmatic answer channel** — every
drive is screen-scrape + empirically-pinned bytes against the live claude CLI.

| Finding | Sev | Failure |
|---|---|---|
| **Single-select driving is wholly byte-pinned with no structured channel** (`pty-driver.js:415-456,492-510`) | medium (fragility) | 1-indexed digit hotkey auto-commit, "redundant" trailing `\r`, DEC-2004 bracketed-paste throttle defeat, per-char paste-detector — none versioned against the claude CLI. A hotkey-scheme change mis-drives **silently**: a wrong digit lands, claude resolves *some* option, PostToolUse fires, watchdog cancels — the user's choice quietly mis-applied. The PostToolUse handler (`2587-2606`) cancels the watchdog without comparing `payload.tool_response` (read at `2611`) to chroxy's intended option. |
| **Chroxy-synthesized "Other" freeform is undeliverable to the TUI → 30s stall** (`form-driver.js:412-423`) | medium (fragility) | store-core appends a synthetic `{label:'Other', value:'__chroxy_other__'}` to single-selects (`handlers/index.ts:4100`), but the server stores claude's RAW options and has **zero** awareness of the sentinel (`grep` finds no `OTHER_OPTION_*` in the server). `findIndex(o => o.label === 'Other')` returns -1, the answer is dropped, and the user waits the full 30s `ASK_USER_QUESTION_STALL`. Multi-select/multi-question are provider-gated for claude-tui; the synthetic Other is **not**. On the now-default provider. |
| **Fixed 150ms Other-digit→freeform settle is a hard timing assumption** (`form-driver.js:70,456`) | medium (fragility) | `OTHER_FREEFORM_SETTLE_MS = 150` is an unconditional sleep sized for "local-loop swap time". A laggy Cloudflare tunnel (chroxy's target) can leave the menu→text-input swap incomplete, so freeform keystrokes jump-nav the still-rendered menu. No acknowledgement wait. |
| **Multi-select DENY/reinject hinges on python3-in-bash that fails OPEN** (`permission-hook.sh:84-120`) | low (partial) | python3 absent/throwing → empty classification → guards skipped → fall-through. **But** the server independently re-classifies at `claude-tui-session.js:2520` and the form-driver refuses un-drivable forms (`325`/`574`) with a retryable teardown, so the system does NOT actually drive an un-drivable form. Real residual: duplicated classification + interpreter dependency on the correctness path. |
| **PostToolUse lock cleanup greps raw hook JSON** (`pty-driver.js:224-226`) | low (partial) | `grep -q '"tool_name":"AskUserQuestion"'` is shape-sensitive; a pretty-printed/reordered payload misses → ≤60s wedge. **But** the server's defensive clear (`2587-2598`) reads `payload.tool_name` *structured* after `JSON.parse`, so pretty-print/reorder are covered; only a field rename breaks both. |
| **Unmatched-label fallthrough types literal text (#4288 jump-nav footgun)** (`form-driver.js:491-560`) | low (partial) | Byte-exact `label === text` match; any drift (trailing space, NFC/NFD, claude re-normalizing a label, future client sending a distinct value) degrades to the literal-type jump-nav path. Effectively unreachable on today's wire path (value===label holds), but defense-in-depth is absent on the non-freeform single-select fallthrough (`545-562`). |
| **Arrow-nav drive path is admitted dead + unverified bytes kept as live code** (`pty-driver.js:476-510`) | low (fragility) | `_writePtyArrowNavSequence` (idx≥9) is unreachable under the claude 4-option cap (#4880); the `\x1b[B`+`\r` sequence "could not be empirically pinned". Presents as tested code (abort guards, paste wrapping) but the core assumption is guesswork — will silently mis-drive on first contact if the cap is ever raised. |

**Recommended fixes, in priority order:**
1. **Pin the tested claude CLI version in `chroxy doctor`'s billing canary** (#5821) so a UI bump is a
   *measured, surfaced* regression. Cheapest, highest-value, do first — it is the only real backstop
   against the silent mis-drive class.
2. **Provider-gate the synthetic Other** the same way multi-select is gated — thread the provider into
   store-core `normalizeQuestion`/`handleUserQuestion` (or pass an `allowOtherFreeform` flag like
   `allowSingleMultiSelect`) and skip appending the sentinel for claude-tui (`handlers/index.ts:4100`).
   Model-supplied real "Other" options still pass. Defense-in-depth: when the freeform path drops,
   tear down immediately via `_teardownAskUserQuestion(..., REINJECT_REFUSALS[...])` instead of a bare
   `return` that eats the 30s window.
3. **Replace the 150ms sleep with a bounded poll on `_outputTail`** for the rendered text-input prompt
   shape (the tail is already maintained, ANSI-stripped). **Do not** reuse `_waitForPrompt` — it polls
   the session-file status, which is explicitly decoupled from what the TUI renders (FIX-0 #5777,
   `claude-tui-session.js:1658-1664`). Anchor the shape token via `scripts/tui-form-recorder.mjs`.
4. **Post-write mismatch assertion** for single-select: if `payload.tool_response` carries the selected
   label (verify against a live capture), compare to chroxy's intended option before cancelling the
   watchdog at `2604-2606` and emit a loud mismatch WARN/error on divergence.
5. **Revert the idx≥9 arrow-nav path to the existing `ASK_USER_QUESTION_TOO_MANY_OPTIONS` teardown**
   (already wired for the multi-select branch) so an unexpectedly-large form fails cleanly rather than
   blind-driving an unverified sequence.

### Theme D — TUI leaks (logging + ephemeral state)

- **`respondToQuestion` hex-dumps up to 1024 bytes of the live PTY tail to logs on every answer**
  (`form-driver.js:367-379`; also `claude-tui-session.js:1587,2089`) — **confirmed, low.** Question
  text, prior answer text, and attachment names are written verbatim into `~/.chroxy/logs/chroxy.log`
  at info level. Token-shaped secrets are already redacted (`redactSensitivePreservingEscapes`,
  #5322/#5358), so this is residual *prompt/answer-content* exposure at rest, not credential leak. Fix:
  gate the full dump behind `CHROXY_DEBUG_PTY_TAIL`; default to a structural summary (byte length +
  capped preview, mirroring the 32-byte cap at `pty-driver.js:391-399`). Gate all call sites.

> **TUI headline:** `ClaudeTuiSession` is the only session subclass that never runs the per-turn
> `_clearMessageState()` reset — its three hand-rolled teardown paths have drifted from the base and
> from each other, stranding background-command entries, the AskUserQuestion sibling-lock, and stall
> watchdogs until `destroy()`. Consolidate the per-turn teardown into one shared helper (with a lint
> guard) and the whole class-A theme closes at once. Separately, the prompt-driving layer has **no
> structured answer channel and no version pin** against the claude CLI, so a single upstream UI
> change mis-drives forms silently — pin the CLI version in `chroxy doctor` as the load-bearing
> backstop.

---

## 3. Other subsystems (by theme)

### 3a. Session / provider DRY & the middle-layer trap

- **Opt-forwarding lint only covers direct `BaseSession`/`JsonlSubprocessSession` extenders — 6
  second-tier subclasses are invisible** (`lint-session-opt-forwarding.mjs:280`) — **medium.**
  `CLASS_RE` matches only the two root types; `DockerSdkSession`/`DockerSession`/`DockerByokSession`/
  `DeepSeekSession`/`OllamaSession`/`AnthropicCompatibleSession` extend the *intermediate provider*
  classes (a genuine second middle layer) and are never analyzed (`OK: 8 session subclass(es)` — the
  8 direct extenders). All 6 are safe today (spread/positional `super`), but a maintainer adding an
  explicit-object-literal override would silently drop an opt with no lint flag. Fix: make class
  discovery **transitive** (fixpoint over `class X extends Y` until closure), match plain `class`
  (not just `export class`, for the factory-defined `AnthropicCompatibleSession`), and add a
  second-tier regression fixture.
- **Picker drops non-BaseSession keys → second-tier subclasses depend on the parent reading
  provider-local opts off raw `opts`** (`byok-session.js:236,363`) — **low.** `super(buildBaseSessionOpts(...))`
  copies only the 20 `BASE_SESSION_OPT_KEYS`; `mcpConfigPath`/`mcpToolCallTimeoutMs`/`mcpStartCapMs`
  survive only because `ClaudeByokSession` reads them off raw `opts` later. If any second-tier subclass
  switched from `{...opts}` to the canonical picker-by-example, all three MCP knobs drop silently.
  The picker has *moved* the trap from base opts to provider-local opts. Fix: comment + extend the lint
  to **fail** a `buildBaseSessionOpts(...)` super on `extends ClaudeByokSession`.
- **Picker overrides win even when the value is `undefined`** (`base-session.js:138-144`) — **partial,
  low.** `{...out, ...overrides}` spreads `undefined`-valued override keys, defeating the `k in fullOpts`
  care taken just above. Benign today (every override targeting a base key is `|| default`-guarded; the
  one bare `resumeSessionId: opts.resumeSessionId` is a non-base key normalized downstream). Optional:
  guard the merge `if (v !== undefined)`.
- **Docker-byok re-implements built-in tool semantics in shell** (`docker-byok-session.js:1862-2066`)
  — **medium (DRY).** `_containerRead/Write/Edit/Glob/Grep` re-encode the same tool *semantics* as
  host-side `built-in-tools/file-ops.js` (Read line-number format, Write EINVAL+cap, Edit
  strict-unique-match, Grep rg/grep `|| true`). Each Copilot fix (e.g. content-type EINVAL, multi-match
  guard) had to be hand-mirrored, and they've **already drifted** (`_containerEdit` lacks `file-ops.js`'s
  NO_CHANGE guard; uses `slice` vs `replace`). Fix: extract FS-agnostic pure transforms (`applyEdit`,
  `formatNumberedLines`, `rgCmd`/`grepCmd` builder) consumed by both host and container; leave byte-I/O
  provider-specific.
- **0600 credentials-file reader triplicated verbatim** (`anthropic-compatible-session.js:78-113`,
  `byok-credentials.js:60-67`, `deepseek-credentials.js:66-73`) — **low (DRY).** The
  `stat.mode & 0o777 !== 0o600` security gate and its error string are byte-identical 3×. Extract
  `readCredentialJsonField(path, field)`; the `cachedResolveCredentialFile` cache layer is unaffected.
- **PermissionManager wiring + back-compat accessors duplicated** (`sdk-session.js:375-409` vs
  `byok-session.js:250-260`) — **low (DRY), two findings merged.** The two in-process providers each
  hand-wire the same three re-emissions + `_pendingPermissions`/`_lastPermissionData` aliases (the only
  two `new PermissionManager` sites; Docker variants inherit). Cross-reference comments have already
  gone stale (`byok-session.js:248` cites `sdk-session.js:254-275`; real block `374-409`). Extract
  `wirePermissionManager(session, permissions, {onRequest, onResolved})`; `SdkSession` passes its
  result-timeout pause/resume hooks, `ByokSession` passes none.
- **Per-stream child stdout/stderr error guard duplicated** (`cli-session.js:541-556` vs
  `jsonl-subprocess-session.js:356-363`) — **low (reliability).** The daemon-crash-critical #5324/#5361
  EPIPE-swallow guard is implemented twice and **already divergent** (session-scoped vs
  providerName-prefixed logger; one says "(ignored)", one doesn't). Factor `guardChildStreams(child,
  {destroying, log, label})` (pass `destroying` as a getter — the flag flips after attach).
- **`BaseSession` god-class with 28 (not "60+") compat-shim accessors** (`base-session.js:179-1300`) —
  **partial, low.** Real but over-counted and **documented-intentional** (the shims are a transient
  #5376 migration seam with live consumers across 3 prod files + 7 test files). Low-priority follow-up:
  migrate consumers off `_skills*`/`_backgroundShell*` then delete the shim block.
- **`DockerByokSession.start()` mixes preflight/lifecycle/post-create/ready-gating** (135 lines,
  `docker-byok-session.js:635-769`) — **partial, low.** Each sub-step is already extracted into named
  methods; the only residual is the inline post-create error-*response* policy (`669-721`). Lift to a
  small `_applyPostCreate()` returning `{ok, fatal}`. Skip the speculative `DockerByokEnvironment`
  extraction (high regression risk on fragile lifecycle code).

### 3b. ws-core reliability & broadcast

- **Session-viewer predicate re-inlined at the terminal sites** — same as Theme-B finding 2, merged
  there (`ws-forwarding.js:117-123`, `ws-server.js:2200-2204` vs `handler-utils.js:212`), **medium.**
- **`executeSideEffects` session_list fallback broadcasts the UNFILTERED list, ignoring boundSessionId**
  (`ws-forwarding.js:441-449`) — **partial, low (security).** The else-branch flat-broadcasts every
  session's metadata to a bound client, bypassing the per-client `boundSessionId` filter
  (`ws-server.js:710-720`). **Not reachable today** — prod always passes `broadcastSessionList`, and the
  fallback is additionally `if (sessionManager)`-guarded (only the CLI/null-manager test wiring omits the
  helper). Fix: delete the unfiltered branch and assert/throw if a real `sessionManager` is wired without
  the helper.
- **A throwing recipient filter aborts delivery to all remaining clients** (`ws-broadcaster.js:113-119,
  180-184`) — **confirmed, low (fragility).** `_broadcast` and the `_broadcastToSession` full-scan branch
  call `filter(client)` unguarded; a throw unwinds the loop and silently drops the broadcast for every
  *later* client. No shipping filter throws today (the #4799 fix hardened the default filter), but the
  fast path (#5563) already uses the resilient per-member `continue` the legacy loops lack. Wrap
  filter+send in a `try/catch`+`continue` with warn-once.
- **Index fast-path per-member guard triplicated** (`ws-broadcaster.js:161-165, 207-212, 249-254`) —
  **low (DRY).** `_broadcastToSession`/`_countSessionSubscribers`/`_hasDeflateSubscriber` repeat the same
  `!authenticated → skip / _ws / readyState!==1 → skip` block, and these MUST agree (count vs deflate vs
  deliver). Extract `*_liveSessionMembers(sessionId)` generator + single-source the fallback predicate
  too (a *second* parallel duplication at `171-179/217-220/259-263`).
- **`client_left` fan-out is an ad-hoc O(clients) loop bypassing the broadcaster** (`ws-server.js:2132-2138`)
  — **partial, low (DRY).** A fourth open-coded copy of the iterate-authenticated pattern; its mirror
  `_broadcastClientJoined` was already moved into the broadcaster. The reliability framing is overstated —
  `_send`→`createClientSender` has its own post-send eviction + `backpressure.disconnects` metric (#4775/#4804),
  so it's not an unmonitored backpressure hole. Pure symmetry cleanup: add `_broadcastClientLeft`.

### 3c. Security / authz

- **Bound (share-a-session) token can self-grant auto-allow rules for Write/Edit**
  (`settings-handlers.js:1451-1494`) — **HIGH (security).** `handleSetPermissionRules` has **no**
  `client.boundSessionId` gate, unlike `handleSetPermissionMode` (`302-311`) and
  `rejectCredentialWriteIfBound` (`538`). A pairing-bound client can send
  `set_permission_rules [{tool:'Write',decision:'allow'},{tool:'Edit',decision:'allow'}]`;
  `_checkRules` then returns `allow` (`permission-manager.js:164-165`) and file writes/edits
  auto-execute with no prompt. `NEVER_AUTO_ALLOW` only blocks Bash/Task/WebFetch/WebSearch — Write/Edit/
  NotebookEdit are eligible. This is functionally the same escalation `bearer-token-authority.md` §3/§4
  forbid for bound tokens (auto-mode is gated "because flipping to auto-approve is a privilege
  escalation"). **Fix:** add the bound-client guard at the top of the handler
  (`PERMISSION_RULES_FORBIDDEN_BOUND_CLIENT`, routed through `sendError(...ctx)` for E2E encryption,
  matching #5632); add `set_permission_rules` to §4's primary-only list; add a regression test.
- **`DELETE /api/snapshots/:slug` is a host-level mutation gated by `_validateBearerAuth` (accepts
  bound tokens)** (`http-routes.js:458-489`) — **medium (security).** Removes a host-global docker image
  + sidecar (not session-scoped), yet any valid token — including a 24h share-a-session bound token —
  passes. §9 checklist item 3 says global mutations must use `_validatePrimaryBearerAuth` (which the
  Pages routes correctly do). `bearer-token-authority.md` §4 line 101 mis-classifies snapshot routes as
  "read-only telemetry." Impact: integrity/DoS on host snapshot images by a bound device. **Fix:** change
  the DELETE gate to `_validatePrimaryBearerAuth`; split the snapshot routes out of the telemetry bucket
  in the doc; add a 403 bound-token test.
- **`_validateHookAuth` legacy fallback accepts pairing-bound tokens on `POST /permission`**
  (`ws-server.js:1242-1271`) — **low (security).** When `_hookSecrets.size === 0`, the fallback calls
  `_isTokenValid`, which accepts bound session tokens — broader than the §5 primary-only contract.
  Exposure is the legacy/startup-race window (`_hookSecrets` is normally populated; the TUI mints a
  secret when `_port` is set). Add the same bound-token rejection `_validatePrimaryBearerAuth` already
  uses.
- **`bearer-token-authority.md` §11 CSP rationale rests on a false premise**
  (`docs/security/bearer-token-authority.md:194`; same error in `http-routes.js:75-81`) — **low
  (reliability/doc).** The doc says "`_validateBearerAuth` accepts a `chroxy_auth` cookie" — it does
  **not** (header-only, `ws-server.js:1182-1192`). Only `_authenticateDashboardRequest` reads the
  cookie, which is `Path=/dashboard`-scoped + HttpOnly, so it never reaches `/p/*` or `/api/*`. The CSP
  is correct defense-in-depth; the stated mechanism is wrong and will mislead a future maintainer. Fix
  **both** the doc and the source comment.

### 3d. Durability (session-manager state & worktree)

- **Graceful shutdown deletes worktrees it just serialized as live → worktree sessions never restore**
  (`session-manager.js:1544-1572`) — **HIGH (reliability).** `shutdown()` calls `serializeState()`
  (writes each worktree session as restorable with `cwd`=worktree dir) then `destroyAll()`, which
  **unconditionally** removes every session's worktree (`if (entry.worktreePath) _removeWorktree(...)`,
  `1568-1570`). On next boot, `restoreState` reuses the now-deleted `cwd` as `baseCwd`; `statSync` throws
  `SessionDirectoryError` (`625-631`) **before** the #5310 rebind block runs, so the session lands in
  `_failedRestores` every restart. Directly contradicts the #5310 design comment ("worktree dirs survive
  a daemon restart" — true only for SIGKILL, which skips `destroyAll`). **Test-enforced current behavior:**
  one test asserts `destroyAll` deletes worktrees; the rebind test only passes because it *skips*
  `destroyAll` ("a real restart leaves the worktree dir on disk" — false for graceful exit). **Fix:**
  stop removing worktrees in `destroyAll()` (drop the block or gate behind `{removeWorktrees=false}`);
  keep teardown only in `destroySessionLocked()` (user-initiated close). Invert the test, strengthen the
  rebind test to actually call `destroyAll`, add an end-to-end restore regression. Caveat: confirm the
  worktree reaper (#5326) treats not-yet-restored-but-still-in-state worktrees as live during the boot
  window.
- **Orphaned chroxy worktrees are never garbage-collected** (`worktree-gc.js:180-231`) — **medium
  (leak).** Chroxy creates worktrees with `git worktree add --detach` and **no `--lock`**
  (`session-manager.js:750`), so `planRepoGc` classifies them `skip` ("present and unlocked"). The GC/reaper
  only reclaims dead-pid-**locked** agent worktrees. So `~/.chroxy/worktrees/<id>` leaks on SIGKILL/OOM/
  power-loss (state later lost) or the >24h TTL drop (`session-state-persistence.js:202-205`, returns null,
  all sessions+worktrees discarded). There is a boot-time sweeper precedent for compose stacks
  (`sweepOrphanedComposeStacks`) but none for worktrees, and `chroxy worktree gc` can't help. **Fix:** add a
  boot-time orphan sweep over `~/.chroxy/worktrees/*` (after `restoreState`, so the live set is known)
  removing any `<id>` not in the live set, with the `isClean(--ignored)` guard (#5244) to preserve leaked
  node_modules/.env. Tie to #5850.
- **Corrupted/legacy session id forces a fresh id, orphaning the worktree + silently dropping isolation**
  (`session-manager.js:645-651,725-732`) — **partial, low.** A `preserveId` failing
  `/^[a-f0-9]{32}$/` mints a fresh random id, so `expectedWorktreeDir` (new id) never equals
  `restoreWorktreePath` (old id) → rebind rejected → non-isolated. **But** the only id generator is
  `randomBytes(16).hex` (always passes the regex), so this only fires on a *corrupt/tampered* state file
  — the same threat the regex (#4983) and the rebind safe-degrade (a deliberate SECURITY choice) already
  harden against. Real residual: the degrade is *silent* — the `log.warn` doesn't distinguish "corrupt id
  forced isolation loss" from "legitimately non-worktree". Make that one case observable at ERROR.
- **Restore TTL is a single whole-file timestamp → one stale field discards all sessions + history**
  (`session-state-persistence.js:196-207`) — **confirmed, low.** `state.timestamp > 24h` returns null,
  dropping everything at info level, even though per-session `lastActivityAt` is already persisted
  (`session-manager.js:1687`) and restored (`1873`). A user returning after a weekend loses the whole
  session list. **Fix:** per-entry filter on `saved.lastActivityAt` (fall back to `state.timestamp`);
  surface dropped names at warn.
- **`SessionManager` remains a 2686-line god class (~63 methods)** (`session-manager.js:1-2686`) —
  **confirmed, low (SOLID).** Already delegated persistence/history/timeouts/budget/locking, but still
  owns worktree lifecycle, provider preflight, settings restore, failed-restore registry, idle wiring,
  event proxying. The worktree lifecycle (scattered across create/rebind/remove and 7 call sites) is the
  source of two durability findings above. **Fix:** extract `SessionWorktreeManager`
  (`ensureWorktree`/`rebindRestoredWorktree`/`remove`) so the durability+security invariants live in one
  testable unit; sequence it **behind** the worktree behavior fixes so it doesn't churn lines under
  active change.

### 3e. Config / providers registry SOLID

- **`CLAUDE_PROVIDER_NAMES` omits the new default provider (`claude-tui`) + `claude-byok`/`claude-channel`/
  `docker-byok`** (`models.js:1062-1098`) — **HIGH (fragility).** `isClaudeProvider()` decides whether a
  stale model id is a hard reject or a soft fallback. The set lists only sdk/cli/docker variants, and none
  of the missing classes set `static claudeFamily = true`. So `isClaudeProvider('claude-tui') === false`,
  routing the **default provider** through the strict-reject branch (`session-manager.js:690`) instead of
  soft-fallback (`683`) — re-introducing the #3403 regression for the default happy path. A dashboard that
  cached a retired model id gets a hard `ProviderModelNotSupportedError` where claude-sdk/claude-cli would
  silently use the default. **Fix (two-part):** immediate — add the four names to `CLAUDE_PROVIDER_NAMES`;
  long-term — make Claude-family membership a single source of truth via `static claudeFamily = true` on
  the real Claude-backed classes so `models.js` stops carrying a hand-maintained parallel list. Add a
  preflight test asserting the **real** default provider soft-falls-back (existing #3403 tests only cover a
  fake `claudeFamily` provider — exactly why this slipped in).
- **Fatal-vs-warn config policy encoded in the warning-message string prefix `'Invalid type'`**
  (`cli/shared.js:177-186`) — **medium (fragility).** `loadAndMergeConfig` decides `process.exit(1)` by
  `w.startsWith('Invalid type')`. `validateConfig` must therefore spell every non-fatal mistype as
  `'Invalid value'` or crash the daemon — a contract living only in ~9 scattered code comments. A reword or
  a copy-paste of the canonical `Invalid type` line into a nested block silently flips warn↔fatal. **Fix:**
  structured `{message, fatal}` warnings; filter `w.fatal`; add a test asserting `'Invalid value'`-prefixed
  warnings are never fatal and vice-versa.
- **`validateConfig` is a 330-line god-function with ~10 copy-pasted range blocks** (`config.js:647-992`)
  — **medium (DRY).** Extract `validateRange(warnings, key, value, {min, max, allowZero, unitLabel})` + a
  declarative table; keep `hardTimeoutMs`'s cross-field check and the `providerStreamStallTimeoutMs` map
  iteration bespoke. Must keep `'Invalid value'` wording (load-bearing per the prefix-coupling above).
- **Unknown-key rejection inconsistent: top-level + discord warn, but k8s/billing/worktreeGc/rancher
  silently accept typos** (`config.js:650-655`) — **confirmed, low.** `billing.creditTeir`,
  `worktreeGc.autoRepa`, `k8s.imagePulPolicy` pass validation and are silently dropped. Factor
  `warnUnknownKeys(obj, knownSet, prefix, warnings)` (the discord block is the template). Niche
  (enterprise/advanced knobs).
- **`settings-handlers.js` (1554 lines) bundles models, permissions, two credential systems, and skills**
  (`settings-handlers.js:1524-1551`) — **medium (SOLID).** Largest handler in the dir; header says
  "model/permission/provider settings" but wires 5+ unrelated families incl. a community-namespace fs scan.
  **Fix:** extract `credential-handlers.js` and `skills-handlers.js` as pure moves; compose handler maps
  (the sibling pattern other `handlers/*.js` already follow).
- **BYOK credential handlers duplicate the generic credential write/broadcast they were "generalized" by**
  (`settings-handlers.js:566-615`) — **medium (DRY), bumped from low.** Two paths manage the SAME secret
  (`ANTHROPIC_API_KEY`) with **incompatible storage semantics**: BYOK `writeAnthropicApiKey` does a
  full-file **overwrite** (clobbers sibling provider keys) and `clearAnthropicApiKey` **unlinks the entire
  file** (`byok-credentials.js:130,166`), with no at-rest encryption; the generic path merges
  non-destructively + dual-writes the alias + encrypts. Both are live from the same dashboard UI, so setting
  a Gemini key then setting/clearing the Anthropic key via the legacy control **silently destroys the other
  providers' keys** — a cross-provider data-loss path, plus the BYOK path broadcasts status to all clients
  while the generic path deliberately does not (info-exposure inconsistency). **Fix:** make the `byok_*`
  messages thin shims over `setStoredCredential('ANTHROPIC_API_KEY', ...)` / `deleteStoredCredential` with
  no broadcast; reply via the generic masked-status helper.
- **`pushToken` in `SENSITIVE_KEYS` but not a `CONFIG_SCHEMA` key** (`config.js:262`) — **partial, low.**
  Dead masking entry; push tokens are runtime device registrations (`prefs.devices`), never on config. No
  real leak (the actual config secret `apiToken` is masked). Drop `'pushToken'` from `SENSITIVE_KEYS`.

### 3f. store-core SOLID & crypto

- **`handlers/index.ts` is a 5,676-line god module spanning ~15 message families with 177 exports**
  (`handlers/index.ts:1-5677`) — **medium (SOLID).** The canonical SRP violation; handlers are pure/stateless
  (no module-level mutable state) so they split cleanly behind the existing `./handlers` barrel. The 148
  `// -----` family banners mark the cut points. **Fix:** split into `handlers/{session,permission,git,
  file-ops,agent,web-task,stream}.ts`, re-export from the barrel (import sites + dispatch table untouched),
  one family per PR. **Coordinate with epic #5556** — `dispatch-table.ts` already groups imports by family;
  align module boundaries with its slices to avoid double-churn, and split `handlers.test.ts` (309KB) in
  lockstep.
- **`sharedStreamDelta` repeats the captured→active→flat session-resolution block twice (not "three
  times")** (`handlers/index.ts:5109-5116, 5146-5158`) — **medium (DRY).** The package's most fragile
  function (~270 lines, #4297/#4889/#4975/#4999/#5014) computes the routing chain twice with renamed locals
  (`captured*` vs `split*`); a missed copy silently misroutes deltas to the wrong session/slot. **Fix:**
  extract a re-invoked closure `resolveTarget()` called at both sites — **do not cache** (block 1's
  `appendResponseSlot` mutates the array before block 2 reads). The 5094 permission-split site is
  intentionally delegated and out of scope.
- **Five (really four identical + one variant) dispatch functions repeat `{sessionId,patch}→hasSession→
  updateSession`** (`dispatch-table.ts:655-707`) — **low (DRY).** `dispatchPlanStarted`/`McpServers`/
  `SessionUsage`/`SessionContext` are byte-identical modulo handler name; `SessionCostThresholdCrossed`
  differs (no active-session fallback, different payload type, comment-documented). Factory
  `sessionPatchDispatcher(handler)`; keep cost-threshold as a documented one-off.
- **Nine file-ops/git DECLINE handlers are an identical template** (`dispatch-table.ts:806-913`) — **low
  (DRY).** Six bare three-liners + three payload-reshaping variants. A copy that forgets the
  `cb === DECLINE` guard would silently take ownership of a message on the dashboard. Factory
  `callbackDispatcher(name, parse)`.
- **`decrypt()` runs `JSON.parse` on verified plaintext without a guard** (`crypto.ts:235-252`) — **low
  (reliability).** A MAC-passing frame with non-JSON plaintext throws a raw `SyntaxError`, off the
  documented `Error`-prefixed contract. Contained — all three call sites wrap in try/catch + close the
  connection. **Fix:** wrap the final parse to re-throw `'Decryption failed: plaintext is not valid JSON'`;
  update the JSDoc throws set. (No new import — keeps the dist tweetnacl-only boundary intact.)

### 3g. claude-hooks ↔ event-ingest derivation parity

- **Server `deriveProjectFromCwd` re-mints the opaque chroxy-worktree session-id** (`event-ingest.js:203-229,
  432-433`) — **medium (fragility).** The hook (#5483/#5464) refuses to name a chroxy worktree after its
  opaque hex basename and recovers the parent project; but it still forwards `data.cwd`, and on parent-parse
  failure sends no `project`. The server fallback is a naive git-root walk that finds the worktree's `.git`
  **file** and returns `basename(worktreeDir)` — the opaque id the hook worked to suppress. The server has
  zero chroxy-worktree/agent-checkout/tmp-home awareness. This is the documented #5850 follow-up. **Fix:**
  mirror `project.js`'s worktree handling (parent recovery or null) **and `realpathSync`** (macOS
  /tmp→/private/tmp), or — best — extract one shared module.
- **Project-derivation duplicated across hook and server with no shared source of truth**
  (`project.js:197-261` vs `event-ingest.js:203-229`) — **medium (DRY).** The 256-iteration `.git` walk is
  byte-for-byte duplicated (the hook's own header says "Mirrors `deriveProjectFromCwd`"); only the hook half
  has the worktree fixes, which is why #5439/#5464/#5483 had to be re-derived. **Fix:** extract the full
  derivation into a **Zod-free subpath export** of `@chroxy/protocol` (e.g. `@chroxy/protocol/project` →
  `dist/project.js`) — two setup steps the rec must include: add the `exports` entry (node-only imports) and
  promote `@chroxy/protocol` from devDependency to a real dependency in claude-hooks. Verify the hook's
  <100ms budget (no transitive Zod via the barrel). Closes #5850 and fixes the server worktree gap for
  non-hook ingest for free.
- **Hook realpath-resolves cwd; server only path-resolves** (`project.js:46-59,147-157` vs
  `event-ingest.js:205-210`) — **partial, low.** Asymmetric normalization → divergent classification on
  symlinked trees, only in the fallback (`event.project || deriveProjectFromCwd`). Fold the realpath fix
  into the #5850 consolidation.
- **Server test codifies the buggy worktree behavior as the contract** (`event-ingest.test.js:612-618`) —
  **partial, medium.** The line-612 test asserts the worktree basename for a generic `.git` file — which is
  *correct* for an ordinary worktree (the hooks side keeps the identical test green alongside its
  chroxy-specific ones). The real gap is the **missing** chroxy-worktrees-root test, making the parity gap
  invisible to CI. **Fix:** don't change line 612; ADD a chroxy-worktree fixture asserting parent/null, and
  reuse the existing `chroxyWorktreeFixture`/`tempRepo` helpers from `emit.test.js`.
- **Schema docstring documents the unfixed derivation contract** (`protocol/src/schemas/ingest.ts:81-82`) —
  **partial, low.** "server derives it from `data.cwd` (git-root walk)" is accurate-but-incomplete (silent on
  the worktree exception). Pin a one-line caveat referencing #5850.
- **Hook hardcodes 127.0.0.1, only reads config.json `port`** (`claude-hooks/src/config.js:29-44`) —
  **partial, low.** Silent no-op if the daemon binds a specific non-loopback interface (`host` key). The
  only genuinely broken config is an explicit non-loopback `host`/`CHROXY_HOST`; default 0.0.0.0 is reachable
  via loopback. Read+normalize the optional `host` key (keep 127.0.0.1 for unset/wildcard).

### 3h. Tunnel / supervisor / service reliability

- **Supervised restart is a guaranteed crash-loop** (`supervisor.js:365-400, 519, 425`) — **CRITICAL.**
  On child exit the supervisor starts a standby HTTP server bound to `_port` (`519`) and schedules the
  restart, but `startChild()` forks the replacement **without** calling `_stopStandbyServer()` first —
  that only runs on the child's `ready` IPC (`425`), which the child reaches **after** `httpServer.listen`
  succeeds. The standby still owns the port → child `listen` → `EADDRINUSE` → `ws-server.js:1666-1668`
  `process.exit(1)` → child never sends `ready` → standby never stopped → every restart collides until
  `_maxRestarts` (10) is exceeded and the supervisor gives up. **The core "auto-restart on crash"
  guarantee is defeated by the standby it introduced**, and the supervisor tests mock `_fork` with a fake
  child that never binds a real socket, so the suite never exercises it. *(Verified against `main`:
  `startChild` clears `_restartTimer` but has no `_stopStandbyServer()` before the fork.)* **Fix:** call
  `this._stopStandbyServer()` at the top of `startChild()` (after the `_restartTimer` clear); the existing
  `'ready'` call degrades to a harmless no-op (its `if (this._standbyServer)` guard makes double-stop
  safe). Add a regression test driving a **real** child-like listener against an active standby.
- **Cold-start timeout permanently sets `intentionalShutdown`, killing the retry budget + all future
  recovery** (`tunnel/cloudflare.js:155, 229`) — **HIGH (fragility).** Both timeout handlers set
  `this.intentionalShutdown = true` on the persistent adapter to suppress the post-kill recovery loop —
  but that is the same instance-wide kill switch `start()`'s retry loop checks at the top of each
  iteration (`base.js:95`) and `_handleUnexpectedExit`'s `while (!intentionalShutdown)` loop reads. A
  single 30s timeout on cold-start attempt #1 (the most common transient failure) flips the flag and
  aborts attempts #2/#3, defeating `maxStartAttempts`; and if a tunnel ever comes up afterward, **all
  mid-session recovery is silently disabled for the adapter's lifetime**. **Fix (not "just delete the
  line" — that creates a concurrent double-retry):** use a per-attempt closure-local `timedOut` flag and
  skip `_handleUnexpectedExit` in the `close` handler when set; leave `intentionalShutdown` untouched.
  Regression-test the timeout path with fake timers.
- **Cloudflared start-timeout timer leaks on success** (`tunnel/cloudflare.js:152-164, 226-237`) — **low
  (leak).** The 30s timer is cleared only on `proc.close`; on success the long-lived process keeps running,
  so a non-`unref()`'d timer pins the event loop for up to 30s (and re-arms per recovery attempt). Matches
  the `--test-force-exit` lore. **Fix:** `timeoutHandle.unref()` in both methods (the `if (!resolved)`
  guard already prevents misfire); optionally `clearTimeout` on success.
- **`tunnel_recovered` re-verification can run unbounded overlapping `waitForTunnel` loops**
  (`server-cli/tunnel-lifecycle-handler.js:118-153`) — **partial, low (fragility).** `waitForTunnel` can
  take ~90s; a tunnel flap during a prior re-verify overlaps, racing on `currentWsUrl` and double-broadcasting.
  Self-limiting (stale handler's URL is dead → `waitForTunnel` throws), so realistic harm is duplicate
  QR/broadcast, not corruption. Add a generation-counter (newest-recovery-wins) guard; hoist the shared
  routine since it's duplicated in `supervisor.js:259-291`.
- **Quick-tunnel start-failure drops cloudflared's real output, unlike the named path**
  (`tunnel/cloudflare.js:214-216`) — **low (DRY).** The named path retains a redacted output tail in the
  rejection (#5328/#5366); the **default** quick path rejects with only `exited with code N` — the most
  common failure, least diagnostic info. Wire the same `outputTailRaw` accumulation + redacted
  `Last output:` suffix into `_startQuickTunnel` (close + timeout rejections); lift into a shared helper.
- **Duplicated `tunnel_recovered` handler logic across server-cli and supervisor**
  (`supervisor.js:259-291`) — **partial, low (DRY).** Near-verbatim twin (down to the catch message), but
  the divergence is partly architectural (supervisor is a separate process: writes the connection-info IPC
  file, no `wsServer`/`pairingManager` to broadcast through). Single-source only the ~10-line drift-prone
  kernel (try/catch containment + URL-change guard + the `#5314` rationale comment), not a heavyweight
  module. *(Note: the DNS-settle `initialDelay` is NOT actually divergent — the supervisor bakes it into
  its `_waitForTunnel` wrapper.)*

---

## 4. Prioritized hardening roadmap

Sizing: **S** ≤ half-day, **M** ≈ 1–2 days, **L** ≈ multi-day / cross-package. "Auto" = autonomous-safe
(unit-testable, no device); "Device" = needs a live phone/tunnel/claude-CLI capture to validate.

### P0 — service-killing; do first, sequentially-independent except where noted

| # | Item | Sev | Size | Closes | Safety |
|---|---|---|---|---|---|
| P0-1 | Stop the supervisor crash-loop: `_stopStandbyServer()` at top of `startChild()` + real-listener regression test | critical | S | supervisor crash-loop | Auto |
| P0-2 | Tunnel cold-start timeout: per-attempt local `timedOut` flag, stop reusing `intentionalShutdown` + fake-timer test | high | S | retry-budget/recovery poisoning | Auto |
| P0-3 | Worktree restore: stop deleting worktrees in `destroyAll()`; invert/strengthen tests; add e2e restore regression | high | M | graceful-shutdown worktree wipe | Auto |
| P0-4 | Bound-token guard on `handleSetPermissionRules` (`PERMISSION_RULES_FORBIDDEN_BOUND_CLIENT`) + doc + test | high | S | Write/Edit auto-allow escalation | Auto |
| P0-5 | Add `claude-tui`/`claude-byok`/`claude-channel`/`docker-byok` to `CLAUDE_PROVIDER_NAMES` + default-provider soft-fallback test | high | S | stale-model hard-reject on default provider | Auto |

P0 items are mutually independent → **5 parallel PRs**. (P0-3 touches `session-manager.js`; if P1 worktree
GC lands concurrently, sequence P0-3 first.)

### P1 — high-value reliability + remaining security

| # | Item | Sev | Size | Closes | Safety |
|---|---|---|---|---|---|
| P1-1 | TUI per-turn teardown helper `_clearTurnEndState()` (bg-commands + lock + watchdogs) + lint | low×4 | M | 4 lifecycle/leak findings (Theme A) | Auto |
| P1-2 | Mirror gate: shared `terminalMirrorRecipient` + `syncTerminalMirror` on switch_session + re-home | medium×2 | M | active-switch leak + 3× predicate dup | Auto |
| P1-3 | Pin tested claude CLI version in `chroxy doctor` billing canary | medium | S | silent prompt-drive mis-resolution (backstop) | Auto (Device to extend) |
| P1-4 | Provider-gate the synthetic "Other" for claude-tui + instant teardown on freeform drop | medium | M | undeliverable-Other 30s stall | Device |
| P1-5 | Replace 150ms Other settle with bounded `_outputTail` prompt-shape poll | medium | M | slow-tunnel freeform jump-nav | Device |
| P1-6 | `DELETE /api/snapshots/:slug` → `_validatePrimaryBearerAuth` + doc reclass + test | medium | S | host-snapshot DoS by bound token | Auto |
| P1-7 | Worktree orphan boot-sweep (`~/.chroxy/worktrees/*`, `isClean(--ignored)` guard) | medium | M | SIGKILL/TTL worktree leak | Auto |
| P1-8 | Reconcile BYOK vs generic credential handlers (shim BYOK over `setStoredCredential`, no broadcast) | medium | M | cross-provider credential wipe + status leak | Auto |
| P1-9 | Config fatal-vs-warn: structured `{message, fatal}` warnings + invariant test | medium | M | `'Invalid type'` string-coupling | Auto |
| P1-10 | Server worktree project-derivation parity (mirror `project.js` worktree+realpath) — interim before #5850 | medium | M | opaque-id Discord embed | Auto |
| P1-11 | Mirror snapshot/resync (`terminal_resync` + size-toggle/SIGWINCH repaint) | medium | M | backpressure-dropped-frame corruption | Device |

P1 is mostly parallel. P1-1/P1-2 both touch ws/TUI files but different functions. P1-4/P1-5 share
`form-driver.js` → sequence (P1-4 then P1-5). P1-10 is an interim for the #5850 shared-module work (P2).

### P2 — structural DRY/SOLID + remaining low-sev hardening (schedule behind active work)

| # | Item | Size | Closes | Safety |
|---|---|---|---|---|
| P2-1 | Transitive opt-forwarding lint (cover 6 second-tier subclasses) + second-tier picker-by-example ban | M | middle-layer-trap gaps (2 findings) | Auto |
| P2-2 | Extract shared `@chroxy/protocol/project` module (Zod-free subpath) — closes #5850 | L | hook/server derivation dup (4 findings) | Auto |
| P2-3 | Split `handlers/index.ts` by family behind the barrel (coordinate #5556) | L | store-core god-module | Auto |
| P2-4 | Split `settings-handlers.js` → credential/skills handlers (pure move) | M | settings god-file + supports P1-8 | Auto |
| P2-5 | Extract `SessionWorktreeManager` (after P0-3/P1-7 land) | M | session-manager god-class + worktree invariants | Auto |
| P2-6 | `validateConfig` `validateRange` table + `warnUnknownKeys` helper | M | config dup + typo-acceptance | Auto |
| P2-7 | `sharedStreamDelta` `resolveTarget()` closure (no cache) | S | delta-routing dup | Auto |
| P2-8 | ws-broadcaster: filter try/catch + `_liveSessionMembers` generator + `_broadcastClientLeft` | M | 3 broadcast DRY/fragility findings | Auto |
| P2-9 | Provider DRY pack: `wirePermissionManager`, `guardChildStreams`, `readCredentialJsonField`, docker tool pure-transforms | M | 5 provider DRY findings | Auto |
| P2-10 | dispatch-table factories (`sessionPatchDispatcher`, `callbackDispatcher`) | S | 2 dispatch dup findings | Auto |
| P2-11 | Quick-tunnel error tail + `unref()` start-timer + `tunnel_recovered` generation guard | S | 3 tunnel findings | Auto |
| P2-12 | Doc/low-leak cleanups: CSP rationale (doc+comment), TUI hex-dump gating, per-session TTL retention, `decrypt` JSON guard, `pushToken` SENSITIVE_KEYS, hook `host` key, snapshot GET, schema docstring caveat | S each | ~8 low findings | Auto |

---

## 5. DRY/SOLID structural recommendations (the god-files)

Four files dominate the structural debt. All four split cleanly because the heavy work is already
delegated to collaborators or the units are pure; the problem is *barrel/orchestration*, not coupling.

**`store-core/handlers/index.ts` (5,676 lines, 177 exports) — split by message family behind the
barrel.** Handlers are pure/stateless (no module-level mutable state), so moving them changes only file
boundaries. The 148 `// -----` banners are the cut lines: `session.ts`, `permission.ts`, `git.ts`,
`file-ops.ts`, `agent.ts`, `web-task.ts`, `stream.ts`, `budget.ts`, `checkpoint.ts`, `presence.ts`.
Re-export from `handlers/index.ts` so `dispatch-table.ts`/`store-core/index.ts`/`delta-flush.ts` import
sites are untouched. **One family per PR; coordinate with epic #5556** (dispatch-table already slices by
family) and split the 309KB `handlers.test.ts` in lockstep. *Highest structural ROI of the four.*

**`claude-tui-session.js` (3,532 lines) — extract turn-lifecycle + form-driving + mirror.** The class
already delegates form-driving to `form-driver.js` and PTY bytes to `pty-driver.js`. The remaining
sprawl is: (a) per-turn teardown (the four drifted paths — fix as the P1-1 `_clearTurnEndState()` helper
first, then it becomes a small `TurnLifecycle` collaborator), (b) the terminal mirror (coalescer + gate
feeding), and (c) the hook-file drain/poll loop. Extract these incrementally **behind** the behavior
fixes (P0/P1) so the refactor doesn't churn lines under active change. Do **not** touch the
empirically-pinned byte sequences in `pty-driver.js` during a structural pass — those carry pinned
fixtures and are the most regression-prone code in the repo.

**`ws-server.js` (2,387 lines) — pull broadcast + auth-class predicates into already-existing seams.**
Two cheap wins that double as fixes above: route `_syncTerminalMirror` and the open-coded `client_left`
loop through the broadcaster (P1-2, P2-8), and consolidate the auth-class checks (`_validateBearerAuth`
vs `_validatePrimaryBearerAuth` vs `_validateHookAuth`) so each host-vs-bound decision has one home (the
snapshot DELETE + hook-fallback findings are symptoms of that scatter). Beyond that, the file mixes HTTP
routing, WS upgrade/auth, broadcast, and lifecycle — a `WsRouter`/`WsBroadcastCoordinator` split is
viable but lower priority than the ws findings it would carry.

**`session-manager.js` (2,686 lines, ~63 methods) — extract `SessionWorktreeManager`.** Persistence/
history/timeouts/budget/locking are already delegated. The biggest remaining cohesive concern is the
worktree lifecycle, scattered across `createSession` (699-763), `_removeWorktree` (1154-1170), the rebind
security check (703-732), and 7 call sites — and it is the source of three durability findings. A
`SessionWorktreeManager` owning `ensureWorktree`/`rebindRestoredWorktree`/`remove` concentrates the
durability+security invariants in one testable unit. **Sequence after** the worktree behavior fixes
(P0-3, P1-7) so it isn't churning lines under active change. `BaseSession`'s 28 compat shims are a
separate, lower-value migration cleanup (consumers across 3 prod + 7 test files must move first).

**Cross-cutting discipline:** every god-file finding co-occurs with a DRY finding where a *shared helper
already exists and is bypassed* (`isSessionViewer`, `_clearMessageState`, `buildBaseSessionOpts`, the
discord unknown-key loop, `wirePermissionManager`-shaped wiring). The durable fix is a CI lint per
invariant — chroxy already proves this works (opt-forwarding, state-file-path, logger-scope lints). Add
lints for: per-turn `_isBusy`/`_currentMessageId` writes outside the teardown helper; second-tier
picker-by-example; `'Invalid value'`≠fatal; terminal gate/filter predicate equality.

---

## 6. Appendix — dismissed findings (do not re-litigate)

| Dismissed finding | File | Why rejected |
|---|---|---|
| Aborted turn that drains a Stop hook reports as success (interrupt ignored) | `claude-tui-session.js` | **False-positive.** The structural asymmetry is real, but the bug is unreachable: the poll loop checks `_activeTurn?.aborted` at the TOP of each iteration (2274) before `drainHookFiles` could re-set `stopPayload`, and the 2274→2292 span is fully synchronous, so `interrupt()` can only interleave at the single `await` yield point — an abort always wins via 2274 (`reason='turn aborted'`). JS's single-threaded model forbids the sub-iteration interleaving the finding requires. |
| Hard-cap vs stream-stall teardown asymmetric error/result emit order "frozen as out of scope" | `claude-tui-session.js` | **False-positive.** Descriptive facts hold, but the recommendation rests on a misread: `_assertBusyHasMessageId` is **observability-only** (warns, never enforces), so it can't make the null-messageId case unreachable; and the ungated `stream_end` in the hard-timeout path is the **intentional** #4638-wedge backstop. Following the rec would re-introduce #4638. Also there are 3 callers, not 2. |
| `terminal_input` raw write bypasses paste-detector defeat + content sanitization | `claude-tui-session.js` | **False-positive.** The divergence is intentional **by explicit design comment** (1849-1858): `terminal_input` is the literal human keyboard ("faithful remote keyboard, including control bytes like `\x03`") for #5835 Phase 3 true remote control — stripping C0/escape bytes would break the feature. The chat-path sanitization defends against attacker-influenced *content* (echoed MCP results); there is no such vector for live keystrokes (gated to bound-session + viewer + single primary). |
| `DISPATCH_TABLE_TYPES` is a hand-maintained parallel copy with no drift guard | `store-core/dispatch-table.ts` | **False-positive.** The exact guard it asks for already exists: `dispatch-table.test.ts:118-120` asserts `[...DISPATCH_TABLE_TYPES].sort() === Object.keys(table).sort()` (fails both directions), `contract.test.ts:120,128` cross-checks against covered wire types, and `DispatchTable<S>` is a mapped type compile-time-exhaustive against `DispatchMessageMap`. The test runs in CI (`vitest run`). Even absent the test, a desync affects only coverage tooling, not runtime dispatch. |

---

### Stats

- **By severity:** 1 critical · 4 high · 14 medium · 24 low (≈43 confirmed/partial). Plus 4 dismissed.
- **By verdict:** ~28 confirmed · ~15 partial.
- **By theme (confirmed/partial count):** TUI 17 · session/provider DRY 9 · ws-core 8 · config/providers 7 ·
  durability 5 · store-core 5 · hooks parity 6 · tunnel/supervisor 6 · security/authz 4.
- **By category:** reliability ~12 · DRY ~14 · fragility ~12 · SOLID ~6 · leak ~6 · security ~4 · testing ~1.
- **Autonomous-safe:** all 5 P0, 8 of 11 P1, all of P2. **Device/live-needed:** P1-4, P1-5, P1-11 (TUI
  prompt-driving + mirror resync need a live claude-CLI capture / phone-over-tunnel).
