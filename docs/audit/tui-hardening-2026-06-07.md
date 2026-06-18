# claude-tui Backend Hardening Audit

> **Snapshot:** audited at commit `ebae034ad` (main as of 2026-06-07). All file:line cites refer to that snapshot — remediation has since landed (tracked in epic [#5338](https://github.com/blamechris/chroxy/issues/5338)), so cites may not match current main.

## Executive Summary

The `claude-tui` provider is **not yet failure-ready to be the primary backend.** It works on the happy path, but its error-handling and recovery story regresses from the SDK/CLI providers it replaces in exactly the dimensions that matter when it becomes load-bearing: it silently throws away conversation continuity on every restart, it has multiple unguarded throw/reject paths that take down the *entire* daemon (and every other session) on routine events, and it has no per-session recovery so a single PTY death bricks a session forever. The interactive `AskUserQuestion` flow — a first-class part of the subscription UX — can force-cancel a slow human with a misleading "stream stalled" error. Auth/subscription expiry, the single most common operational state for a subscription-driven backend, is undetectable and surfaces only as a generic ~90s silent hang with actively wrong "try again" advice.

**Top 3 risks to fix before flipping the default backend to `claude-tui`:**

1. **Silent total loss of conversation context on every restart** (TUI-AUDIT-001) — `resumeSessionId` is never persisted or forwarded, so every supervisor restart / upgrade / crash-recovery starts a brand-new claude conversation while the dashboard replays old history. Silent amnesia for every active session.
2. **Multiple whole-daemon crash vectors on common paths** (TUI-AUDIT-002 through 006) — the PTY has no `error` listener, fire-and-forget `sendMessage`/broadcast rejections, an async HTTP handler with no try/catch, and async `tunnel_recovered` handlers all funnel into `unhandledRejection`/`uncaughtException` → `process.exit(1)`, converting per-session or per-request faults into total host outages that kill every live PTY mid-turn.
3. **No per-session respawn + zombie sessions on spawn/auth failure** (TUI-AUDIT-007, 008, 015) — one claude crash, or a first-run with an unauthenticated/missing binary, leaves a permanently input-rejecting session in the list with no recovery affordance, regressing CliSession's bounded auto-respawn.

The state-flush-on-shutdown class of bug (project memory #3697 / SIGTERM-not-SIGKILL) and the middle-layer opt-drop class (#4797) both **recur** on the about-to-be-primary path and are called out below.

## Severity Tally

| Severity | Finding blocks enumerated | Deduped root causes |
|----------|---------------------------|---------------------|
| CRITICAL | 10 | 9 |
| MAJOR | 18 | 16 |
| MINOR | 20 | 14 |
| **Total** | **48** | **39** |

This document enumerates 48 `TUI-AUDIT-*` blocks; several are facets of the same root cause kept under separate headings for per-site fixes (each facet cross-references its sibling, e.g. TUI-AUDIT-022/023). The deduped count of 39 root causes is what the decomposed plan (`tui-hardening-plan.html`) and the PR summary report.

---

## CRITICAL

### State persistence & restore

#### TUI-AUDIT-001 — claude-tui loses all conversation context on every restart (`resumeSessionId` dropped, never persisted)
- **File:** `claude-tui-session.js:309, 393, 687-689, 707, 804`; `session-manager.js:1216, 1340, 678`
- **Trigger:** Any daemon restart / upgrade / crash-recovery while a TUI session exists. `serializeState` reads `entry.session.resumeSessionId`, but ClaudeTuiSession exposes only `get sessionId()` (687) — **no** `resumeSessionId` getter (cf. `sdk-session.js:422`, `cli-session.js:402` which have it). The read is `undefined` → persists `sdkSessionId:null`. On restore, the constructor (393) doesn't destructure `resumeSessionId` (the #4797 middle-layer trap), and `start()` unconditionally mints a fresh `randomUUID()` (707) spawned as `--session-id` (804).
- **Impact (TUI-primary):** Dashboard replays restored chat history so the user sees prior turns, but the real claude CLI starts a brand-new conversation with **zero memory**. Next message is answered as if the session just began — silent context amnesia, no error surfaced. **Every** restart silently destroys conversational continuity for every active TUI session.
- **Fix:** (1) Add `get resumeSessionId() { return this._sessionId }`. (2) Destructure `resumeSessionId` in the constructor (393) and reuse the persisted uuid in `start()` (707) instead of always minting fresh, passing `--resume <uuid>` (reference: `cli-session.js:156-157`). Flip `capabilities.resume` to true. Add a CI assertion (mirroring `lint-session-opt-forwarding.sh`) that the primary provider round-trips `resumeSessionId`.

### Process spawn & lifecycle

#### TUI-AUDIT-002 — Supervised child IPC `shutdown` exits without flushing session state
- **File:** `server-cli-child.js:110-114`; `supervisor.js:163-164, 643, 658-662`; `server-cli.js:1136-1176`
- **Trigger:** Supervisor's SIGINT/SIGTERM handler calls `shutdown()`, which sends `{type:'shutdown'}` IPC to the child and only sends a real OS SIGTERM at the 5s force-kill fallback. The child's `process.on('message')` handler runs `process.exit(0)` immediately on the IPC — before any OS signal — so the child's OS-signal flush handler (`server-cli.js:1136-1176`) never runs.
- **Impact (TUI-primary):** On the supervisor's primary stop path the child exits with no `serializeState()`/`destroyAll()`. Every session's message history, `messageCounter`, `cumulativeUsage`, `permissionMode` and per-session settings are silently lost on a routine supervised stop/restart. This is the #3697 "SIGTERM-must-run-the-flush" data-loss class reintroduced on the supervised hot path. (The separate `drain` path *does* flush via `handleDrain`→`serializeState`; the plain `shutdown()` path does not.)
- **Fix:** Make the IPC `shutdown` handler flush before exit: in `server-cli-child.js:111-114` do `try { _wsServer?.close() } catch {}; try { _sessionManager?.destroyAll() } catch (e) { log.error(e?.message) }; process.exit(0)`. `destroyAll()` (`session-manager.js:1144-1155`) does a guarded final `serializeState()` and sets `_destroying`, so it is idempotent against the racing OS handler.

#### TUI-AUDIT-007 — No per-session respawn: a single claude TUI crash permanently bricks the session
- **File:** `claude-tui-session.js:876-904`; `session-manager.js:1669-1800`
- **Trigger:** The persistent claude TUI PTY dies mid-session (claude crash, OOM-kill, self-exit, transient kill). `_term.onExit` sets `_ptyExited=true`, emits one `error`, returns. No respawn in claude-tui-session.js and no PTY-exit listener in SessionManager that respawns or tears down (`_wireSessionEvents` only proxies the error event to the dashboard).
- **Impact (TUI-primary):** The session stays in `_sessions` but is dead forever — every later `sendMessage` hits the guard at `1029-1031` returning "Session not started or PTY no longer alive". The supervisor only restarts the *whole* chroxy process on a child crash, never an individual PTY. CliSession HAS bounded auto-respawn (`cli-session.js:351-354, 553-561`), so this is a real recovery regression when the primary backend moves from a respawning provider to a non-respawning one. One CLI crash → a permanently input-rejecting zombie tab.
- **Fix:** Add bounded auto-respawn for unexpected PTY exit matching CliSession's pattern (re-run `_spawnPty` + re-emit `ready` with backoff and a max-attempts cap, e.g. 3/60s, preserving session id + tab). Minimum acceptable: have SessionManager listen for the TUI exit and `destroySession()` so the dead session leaves the list cleanly.

### PTY I/O & stream parsing

#### TUI-AUDIT-003 — PTY has no `error` listener — node-pty throws on socket error, crashing the whole daemon
- **File:** `claude-tui-session.js:851-904` (onData/onExit wired; **zero** `this._term.on('error')`)
- **Trigger:** Any non-EAGAIN/non-EIO/non-errno-5 error on the PTY master socket. Verified against installed node-pty 1.1.0 (`node_modules/node-pty/lib/unixTerminal.js:99-124`): the socket `error` handler returns silently for EAGAIN/EIO/errno-5 but otherwise does `if (listeners('error').length < 2) throw err`. ClaudeTuiSession registers zero `error` listeners → count `0 < 2` → node-pty throws synchronously inside its own socket callback.
- **Impact (TUI-primary):** The synchronous throw is uncaught → `server-cli.js:1181` uncaughtException → `serializeState` + `destroyAll` + `wsServer.close` then `process.exit(1)` (1205). The **entire daemon exits, taking down every session on the host**, not just the TUI one; the current turn's in-flight streaming response is lost. A single recoverable PTY fault becomes a total host outage.
- **Fix:** In `_spawnPty`, right after `ptyMod.spawn()` succeeds, register a session-scoped `error` handler that does NOT rethrow and instead runs the same cleanup as `onExit` (`_ptyExited=true`, `_processReady=false`, clear turn attachments, emit a session-scoped `error` when `!_destroying`). **Subtlety:** a single listener still leaves count `1 < 2`, so node-pty's check would still throw — the listener ensures the cleanup runs, but the load-bearing fix is to register the session-scoped error path *and* keep `server-cli`'s uncaughtException handler resilient so the daemon does not die on a per-session PTY fault. (Upstream-patching the count check is acceptable as an alternative.)

### AskUserQuestion form-drive & watchdogs

#### TUI-AUDIT-004 — Stream-stall/inactivity timers are NOT suspended while waiting on a human's AskUserQuestion answer — a slow user gets the question force-canceled with a false "stream stalled" error
- **File:** `claude-tui-session.js:1235-1244, 1665-1716, 2125-2146, 2231-2300`; `base-session.js:94`
- **Trigger:** claude TUI emits AskUserQuestion. Its PreToolUse hook file is consumed → line 1235 (`_consumedFiles.size > sizeBefore && _isBusy`) calls `_armResultTimeout()`, re-arming `_streamStallTimeout` for a fresh window (default 5 min). The session then blocks on the human's answer; no further hook files arrive, so no further re-arm. If the user takes longer than 5 min, the stall timer expires.
- **Impact (TUI-primary):** `_handleStreamStall` (2125) only early-returns on `!_isBusy` — there is **no** check for `_pendingUserAnswers.size > 0`, and `_isBusy` is still true during a pending question, so it fires. It calls `_teardownTurn('stream_stall')` which writes Ctrl-C into the PTY (2248, canceling the in-flight question), wipes the pending Map (2271), and emits the error "Stream stalled — no response for 5 minutes. Try sending again." (2141). The user who was simply thinking sees the question vanish. A late answer is then silently dropped (`respondToQuestion` finds the Map empty → returns at 2486). AskUserQuestion is a first-class interactive flow, so **every** question outliving 5 min of think-time is silently destroyed with no recovery.
- **Fix:** In the AskUserQuestion PreToolUse branch (after `emit('user_question')` at 1714), clear `_streamStallTimeout` and `_resultTimeout`, relying on the 30s `_askUserQuestionWatchdog` and the 2h hard cap as backstops; re-arm on PostToolUse or next `sendMessage`. Belt-and-braces: early-return from `_handleStreamStall` and `_handleInactivityWarning` when `_pendingUserAnswers.size > 0`.

### Auth & subscription-token failures

#### TUI-AUDIT-005 — TUI path never detects subscription auth failure — expired login surfaces as a generic silent timeout, not an actionable error
- **File:** `claude-tui-session.js:1275-1293, 2125-2146, 2167-2195`
- **Trigger:** Subscription OAuth token expires / `claude login` required / usage-or-rate limit hit mid-session. claude TUI renders the auth/limit message inline and returns to idle without firing the Stop hook, or the request hangs.
- **Impact (TUI-primary):** Silent ~90s (first-output watchdog) to 2h (hard cap) hang, then a generic "No response from claude TUI within … Try sending again." (2190) or "Stream stalled … Try sending again." (2141). The advice is **actively wrong** — retrying never works while auth is expired. The stall/first-output paths emit a fixed `errorPayload` via `_teardownTurn` (2231-2299) with NO `_outputTail` and NO auth classification, so the real cause (`claude login`) never reaches the client. `grep` found zero auth/limit classifiers anywhere in the server — only static hint strings at `:334`/`:357`. This is the single most common production failure once subscriptions are the only auth path.
- **Fix:** Add an auth/limit classifier that scans `this._outputTail` for known signatures (`/login/i`, `/Invalid API key/i`, `/Please run.*login/i`, `/usage limit|rate limit/i`, `/Credit balance/i`, `/sign in|re-?authenticate/i`) at every turn-failure site — the `!stopPayload` branch (1275), inside `_teardownTurn`'s `errorPayload` for `_handleStreamStall`/`_handleFirstOutputTimeout`, and the `onExit` handler. On match, emit `error` with `code:'auth_expired'` and message "Claude subscription needs re-auth — run `claude login` on the host".

### WS transport & broadcast

#### TUI-AUDIT-006 — Fire-and-forget TUI `sendMessage()` rejection crashes the whole daemon via unhandledRejection → process.exit(1)
- **File:** `handlers/input-handlers.js:502`; `claude-tui-session.js:1024, 1302-1310, 1869-1901`; `session-manager.js:1678-1681`; `ws-forwarding.js:51, 89-109`; `server-cli.js:1208-1228`
- **Trigger:** `entry.session.sendMessage(...)` at `input-handlers.js:502` is called with no `await` and no `.catch()`. The async `sendMessage` synchronously emits `stream_delta`/`stream_end`/`_emitResult` (success, 1302-1310) and via `_finishTurnError` (failure, 1895-1901). Each emit runs the fully-synchronous fan-out: `session-manager.js:1678` listener → `_recordHistory` (unguarded) → `emit('session_event')` → `ws-forwarding.js:51` listener → `normalize`/`executeSideEffects`/broadcast loop. A throw anywhere in that orchestration propagates back out of the async `sendMessage` and rejects the orphan promise.
- **Impact (TUI-primary):** The rejection hits `process.on('unhandledRejection')` at `server-cli.js:1208` → `process.exit(1)` (1228). The entire daemon dies — every session, every client — not just the one turn. This emit chain runs on **every** turn end (success AND error), so once TUI is primary this is a common-path total-outage vector. (The broadcast *leaf* — `ws-client-sender.js:63-101` — wraps `encrypt`+`stringify`+`ws.send` in a swallowing try/catch, so the live throw sources are the unguarded orchestration layer: `normalize`/`_recordHistory`/`executeSideEffects`/filter fns.)
- **Fix:** Attach a rejection handler at `input-handlers.js:502`: `.catch(err => { log.error(...); ctx.broadcastToSession(targetSessionId, { type:'session_error', sessionId, message:'Failed to process message', recoverable:true }) })`. Defense-in-depth: wrap the `ws-forwarding.js:51` listener body in try/catch (see TUI-AUDIT-019).

### Error propagation & observability

#### TUI-AUDIT-009 — Async HTTP request handler has no top-level try/catch — an unguarded throw crashes the supervised daemon and every TUI session
- **File:** `http-routes.js:168` (handler is `async (req,res) =>`, no top-level try/catch); unguarded throws at `394` (`buildDiagnosticsSnapshot`), `421/532` (`readConnectionInfo`), `684` (`readFileSync(indexPath,'utf-8')`)
- **Trigger:** Any path in the async handler that throws BEFORE a response is written: `buildDiagnosticsSnapshot()` on a malformed session entry (394), `readFileSync(indexPath,'utf-8')` on a transient FS/EMFILE/permission error while serving `/dashboard` (684 — **not** wrapped, unlike the assets read at 660), or `readConnectionInfo()` (421/532). `ws-server.js:1071` does `createServer(createHttpHandler(this))` — Node passes the async fn as the request listener and never awaits it, so a rejection becomes an unhandledRejection.
- **Impact (TUI-primary):** In the default supervised daemon, `process.on('unhandledRejection')` at `server-cli-child.js:131` runs `broadcastShutdown('crash')`, `wsServer.close()`, `destroyAll()`, then `process.exit(1)`. **One bad HTTP request** (diagnostics / dashboard / connect) takes down the entire daemon and terminates every live claude-tui PTY session mid-turn. Total outage from a single request.
- **Fix:** Wrap the entire handler body in `createHttpHandler` in a try/catch that logs and writes a 500 only if `!res.headersSent`. Additionally wrap the index.html `readFileSync` at 684 in try/catch like the assets read at 660.

### Tunnel & connectivity failures

#### TUI-AUDIT-010 — `tunnel_recovered` handler's awaited `waitForTunnel()` crashes the whole server on a routine DNS-settle race
- **File:** `server-cli.js:992-1010`; `tunnel-check.js:61-68`; `server-cli.js:1208-1228`
- **Trigger:** Quick tunnel flaps mid-session; base recovery loop succeeds and emits `tunnel_recovered`. The bare async listener (992) does `await waitForTunnel(newHttpUrl, { initialDelay: QUICK_TUNNEL_DNS_SETTLE_MS })` (996) with no try/catch. If the recovered URL is not routable within ~20 attempts (~90s), `waitForTunnel` throws `TUNNEL_NOT_ROUTABLE`. EventEmitter does not observe the rejected promise.
- **Impact (TUI-primary):** The rejection reaches `process.on('unhandledRejection')` (1208) → `serializeState`, `destroyAll()`, `wsServer.close()`, `tunnel.stop()`, `process.exit(1)`. A **recoverable transient tunnel hiccup becomes a full-server kill** that tears down every live TUI PTY. A routine quick-tunnel rotation kills all active subscription sessions instead of reconnecting.
- **Fix:** Wrap the listener body in try/catch (or use the `void(async()=>{...})().catch(log)` IIFE already at `supervisor.js:348`). On failure: log + `wsServer.broadcastError('tunnel', msg, true)` and return — never propagate to `unhandledRejection`.

#### TUI-AUDIT-011 — Supervisor has no unhandledRejection/uncaughtException handler; its async `tunnel_recovered` handler kills the supervisor and orphans the child
- **File:** `supervisor.js:192-216` (bare async listener, awaits `_waitForTunnel` at 194, no try/catch); `supervisor.js:114-119, 281, 292`; `server-cli-child.js` (no `disconnect` handler)
- **Trigger:** Same flap-then-recover (or cold-start) sequence in supervised mode (default). `_waitForTunnel` delegates to `waitForTunnel`, which throws `TUNNEL_NOT_ROUTABLE` on a slow-to-propagate recovered URL.
- **Impact (TUI-primary):** Supervisor installs only SIGINT/SIGTERM/SIGUSR2 — **no** `unhandledRejection`/`uncaughtException`. The rejected promise aborts the supervisor (which owns the tunnel), killing remote reachability. The forked child has no `process.on('disconnect')` handler and runs with `CHROXY_TUNNEL:'none'`, so it keeps running bound to localhost with **zero remote reachability** after the parent dies — a wedged, unreachable daemon holding the port with live TUI sessions no client can reach. launchd may restart the supervisor, but the orphaned child still holds the port → restart can fail to bind.
- **Fix:** (1) Guard the listener with the `void(async()=>{...})().catch(...)` pattern from `supervisor.js:348`. (2) Add `process.on('unhandledRejection')`/`('uncaughtException')` in `startSupervisor` that log, stop the tunnel, force-kill the child, exit non-zero. (3) Add `process.on('disconnect', () => process.exit(0))` in `server-cli-child.js` so an orphaned child self-terminates.

---

## MAJOR

### Process spawn & lifecycle

#### TUI-AUDIT-008 — TUI `start()` never throws on spawn failure — failed session lingers as a zombie
- **File:** `claude-tui-session.js:744-749, 768-771, 846-849`; `session-manager.js:822-848, 1677-1686`
- **Trigger:** `claude` binary unresolvable (ENOENT in a minimal launchd/GUI PATH — the documented Tauri-GUI-PATH hazard), node-pty import fails (768-771), or PTY exits during warmup (746-749). Each path emits `error` and `return`s; `_spawnPty`/`start()` resolve normally — never throw or reject.
- **Impact (TUI-primary):** `createSession` only tears down the phantom session if `start()` throws synchronously (catch 832-848) or rejects (`.catch` 825-831). TUI `start()` resolves cleanly, so neither fires: the failed session is left in `_sessions` with `_processReady=false` and no PTY — every later `sendMessage` rejects. The error IS in history (user sees a toast) but the dead session and any created worktree persist with no automatic cleanup. Especially likely on first TUI rollout under launchd's minimal PATH. (Same root cause surfaces in TUI-AUDIT-015 — error-propagation lens.)
- **Fix:** On unrecoverable spawn failure in `start()`/`_spawnPty`, surface it as a rejection so `createSession`'s existing cleanup fires: throw after emitting the error, or return a rejected promise. If the error-event toast must be kept, additionally call back into a teardown so the phantom session is not selectable.

#### TUI-AUDIT-012 — TUI `destroy()` SIGTERMs the PTY with no SIGKILL escalation — orphan claude + tool children on a stuck quit
- **File:** `claude-tui-session.js:3270-3273`; contrast `supervisor.js:659-662`
- **Trigger:** `destroy()` (called from `destroyAll` on shutdown or `destroySession`) does `this._term.kill('SIGTERM')` once (3271) and immediately nulls `_term` (3272). If claude is mid-tool-execution and traps/ignores SIGTERM, or a spawned tool subprocess (bash, MCP server) is not in the killed group, nothing escalates to SIGKILL and `destroy()` does not wait for exit.
- **Impact (TUI-primary):** On shutdown/upgrade the claude process and its tool subprocesses can be orphaned, leaking PTYs and child processes (and any worktree/file handles they hold). Every session holds a live PTY, so a batch `destroyAll` on a busy machine can strand multiple claude trees. The supervisor's own child kill DOES escalate, so this is an inconsistency on the in-process teardown path. Orphans hold the per-pid subscription session file (`~/.claude/sessions/<pid>.json`) and can interfere with `claude ps` and the next spawn's readiness probe.
- **Fix:** Escalate like the supervisor: capture the pid before nulling, then `setTimeout(() => { try { _term?.kill('SIGKILL') } catch {} }, N).unref()` (or kill the process group) before `this._term = null`. Since `destroy()` is async, optionally await a short exit-or-kill window.

#### TUI-AUDIT-013 — Logged-out / subscription-expired spawn is undetected — degrades to a 90s silent wait instead of a clear error
- **File:** `claude-tui-session.js:905-924, 350-360`; `claude-tui-session.js:622, 2008, 2033-2036`
- **Trigger:** claude is installed but not logged in, or the Max subscription lapsed. The PTY spawns and renders claude's login/auth prompt; `~/.claude/sessions/<pid>.json` never reaches `status=idle`. `_waitForPrompt` times out after `SPAWN_WARMUP_MAX_MS` (15s), logs a warn (919-922), and `start()` proceeds to emit `ready` anyway (751-752). `resolveAuth()` unconditionally returns `ready:true` (350-360) and notes it cannot see Keychain creds; `_outputTail` (which holds the login text) is never scanned.
- **Impact (TUI-primary):** Dashboard shows a healthy "ready" session. User sends a message; the prompt write lands on the login screen, no hook fires, and the turn hangs until the 90s first-output watchdog clears it through the generic `stream_stall` path — the wrong remediation (fix is `claude login`, not retry). An expired/lapsed subscription is a COMMON operational state, and the only signal is a misleading 90s stall. The session also never re-probes after login.
- **Fix:** After the warmup probe misses, scan `_outputTail` for login/auth markers and emit a specific `error` (`code:'auth_required'`, "Run `claude login`") instead of emitting `ready`. Since `resolveAuth()` cannot see Keychain creds, this PTY-output check is the only at-spawn auth signal. Optionally re-probe so the session self-heals after login.

### PTY I/O & stream parsing

#### TUI-AUDIT-014 — Hook payload files + `_consumedFiles` Set grow unbounded for the session lifetime (O(n) poll scan)
- **File:** `claude-tui-session.js:1195-1245, 1211-1231, 1220, 1197/1263, 1267, 3277-3285`
- **Trigger:** A long-lived persistent TUI session (the new primary backend) accumulates pre-/post-/stop- JSON files in `_sinkDir` (~2 per tool call + 1 per turn). `drainHookFiles` READS each file and `_consumedFiles.add`s its name but NEVER unlinks it; the Set is only cleared in `destroy()` (3285). `readdirSync(_sinkDir)` runs every ~150ms busy poll (1197) and on each heartbeat (1263); `entries.sort()` runs 3× per drain (1207).
- **Impact (TUI-primary):** On a heavy multi-hour session (the explicit design of this provider) the sink dir holds thousands of small files; every busy turn re-reads + re-sorts the whole listing on a 150ms cadence — per-tick cost grows O(files), cumulative O(files×turns). `tmpdir` is often a size-capped tmpfs whose exhaustion affects all processes. Stale hook payloads (containing prompt/tool text) accumulate until destroy. The user sees progressively laggier turns on exactly the long-running sessions this model exists to serve.
- **Fix:** After consuming + emitting a hook file, unlink it (`try { rmSync(full, { force:true }) } catch {}`). Filenames are `randomUUID`-unique (205-208) so a deleted file cannot reappear, making the Set redundant once files are removed. **CAUTION:** do NOT clear `_consumedFiles` mid-session/in `_teardownTurn` — it is an intentional cross-turn dedup window for the BSD-mktemp filename-collision bug #3902 (load-bearing comment at 209-214). With unlink-on-consume the Set becomes redundant and can be dropped or kept as a same-drain dedup only.

#### TUI-AUDIT-015 — `start()` emits `ready` even after PTY spawn fails, marking a dead session as ready
- **File:** `claude-tui-session.js:744-752, 764-771, 838-849`; sendMessage guard at `1029-1030`
- **Trigger:** node-pty import throws (catch 768-771: emits `error`, returns, `_term` null, `_ptyExited` false) OR `ptyMod.spawn()` throws synchronously — ENOENT/EACCES on the claude binary, bad cwd, rlimit (catch 846-849: same). Back in `start()` the only guard after the await is `if (this._ptyExited)` (746), which is false on both paths, so it falls through to `_processReady = true` (751) and `emit('ready')` (752) with `_term === null`.
- **Impact (TUI-primary):** Dashboard receives `ready` for a session with no PTY — the session list shows a healthy session that only fails on the first `sendMessage` (guard at 1029-1030). The earlier `error` event risks being lost in the UI behind the ready transition. This is the COMMON cold-start failure shape (claude not installed / not on PATH / not logged in / wrong cwd). *(Shared root cause with TUI-AUDIT-008; this is the ready-state-mismatch facet, that is the SessionManager-cleanup facet — fix both together.)*
- **Fix:** Set `this._spawnFailed = true` on every early-return failure path (768-771, 846-849), and in `start()` gate the ready emit: change the post-await guard to `if (this._ptyExited || this._spawnFailed || !this._term) { return }`.

### AskUserQuestion form-drive & watchdogs

#### TUI-AUDIT-016 — Single `_askUserQuestionWatchdog` field cannot protect parallel pending answers (#4668 shape) — arming the 2nd answer's watchdog cancels the 1st's
- **File:** `claude-tui-session.js:466` (single field), `2536-2547, 2542` (armWatchdog clears the shared field); `460` (`_pendingUserAnswers` Map), `472-477` (`_multiQuestionSubmitAt` Map), `104` (`ASK_USER_QUESTION_WATCHDOG_MS`=30s)
- **Trigger:** claude TUI emits two+ parallel AskUserQuestion tool_use blocks in one turn (the documented #4668 retry-as-singles shape). The dashboard answers both; `respondToQuestion` runs once per `toolUseId`. Each `armWatchdog()` does `clearTimeout(this._askUserQuestionWatchdog)` then sets a new timer.
- **Impact (TUI-primary):** `_pendingUserAnswers` is a Map (made so by #4668 to support parallel answers) but `_askUserQuestionWatchdog` is a single timer handle. Answering the second question cancels the first's 30s stall watchdog. If the first form's keystroke didn't land — the exact wedge the watchdog exists to catch — there is no 30s AskUserQuestion recovery for it; only the 5-min stall, which itself mis-fires (TUI-AUDIT-004). `_multiQuestionSubmitAt` was deliberately made a Map "to mirror `_pendingUserAnswers`" but the watchdog was not. Parallel questions are real claude behavior.
- **Fix:** Make the watchdog per-`toolUseId`: replace the single field with a Map keyed by `toolUseId`. `armWatchdog` sets/clears only its own entry; `_onAskUserQuestionStall`, the PostToolUse cleanup (~1770), `_teardownTurn` (2273), `interrupt` (2370), `destroy` (3266), and the freeform IIFE re-arm (2623) must clear the matching entry (or the whole Map at turn-level teardown).

#### TUI-AUDIT-017 — Freeform/Other early-return paths clear the pending answer but arm no watchdog and emit no error — downgrades recovery from 30s to the (buggy) 5-min stall, with no client-facing error
- **File:** `claude-tui-session.js:2496` (entry cleared), `2569-2573` (return when no options), `2575-2579` (return when chosen label not found); contrast `2783` (correct give-up teardown)
- **Trigger:** Dashboard sends `user_question_response` with `opts.freeformText` for a single-question form, but the pending question has no options array (2570) or the chosen Other label isn't found by `options.findIndex(o => o.label === text)` (2575). (The `idx >= 9` sub-case is dead per #4880; "label not found" is reachable on a label/state mismatch — stale payload, Other-sentinel drift, or a payload/answer race.)
- **Impact (TUI-primary):** By 2496 the pending entry is removed while `_isBusy` is still true. The two freeform-drop returns exit with only a server-side WARN — no `armWatchdog()`, no `_teardownAskUserQuestion()`, no answer written, no client error. The session sits busy with no pending answer and no 30s watchdog. The only backstop is the 5-min stream-stall (itself buggy). The user sees the Working banner / Stop button persist ~5 min with no retry toast, instead of ~30s recovery, and gets no actionable error. The too-many-options give-up at 2783 correctly calls `_teardownAskUserQuestion` with an actionable error — proving the inconsistency.
- **Fix:** Before returning at 2573 and 2579, call `_teardownAskUserQuestion(prevToolUseId, { synthResult, emitResultReason:'ask_user_question_freeform_unresolvable', errorCode:'ASK_USER_QUESTION_FREEFORM_INVALID', errorMessage:'Could not deliver your freeform answer (option not found). Tap Retry to resend.' })` so busy state clears immediately and the user gets an actionable error — matching 2783.

### State persistence & restore races

#### TUI-AUDIT-018 — Async `start()` rejection during restore destroys the restored session and erases its history from disk, bypassing failed-restore tracking
- **File:** `session-manager.js:823, 826-830, 1123, 1130, 475-481, 1321-1465, 1476`; `claude-tui-session.js:773, 701-703`
- **Trigger:** `restoreState()` → `createSession()` → `session.start()` fire-and-forget (`session-manager.js:823`, not awaited). ClaudeTuiSession `start()` has an UNGUARDED throw path: `realpathSync(this.cwd)` (`claude-tui-session.js:773`) sits inside `_spawnPty` OUTSIDE any try/catch (the only try/catch wraps the node-pty import at 766-771), so if cwd is removed between the `statSync` gate (`session-manager.js:561`) and this `realpathSync`, it throws ENOENT and rejects `start()`. `mkdirSync` calls (701-703) are also unguarded. The rejection lands in `result.catch` (826) → `destroySession` AFTER `restoreState`'s try/catch already succeeded and the final `_flushPersist` (1476) wrote the good state.
- **Impact (TUI-primary):** `destroySession` runs `_cleanupSessionMaps` (deletes in-memory history, 1123→479) then `_flushPersist` (1130) writing the now-history-less state over the good restored state. The session and its entire restored history are **permanently erased**. Because the failure arrives asynchronously after the sync try/catch succeeded, it never reaches `_registerFailedRestore` — no `session_restore_failed` event, no "needs attention" chip, just a vanished session on next reload. TUI's external-binary + node-pty spawn path is materially more reject-prone than the in-process SDK it replaces. (Held at MAJOR only because the trigger is an edge case; the consequence is CRITICAL-grade silent data loss if it fires.)
- **Fix:** In the async-rejection handler (826-830), do not blindly `destroySession` during boot. Track whether the session came from `restoreState` and route restore-time `start()` failures through `_registerFailedRestore` (preserves history, emits `session_restore_failed`). Alternatively, have `destroySession` refuse to flush-erase a session whose history is non-empty and whose `start()` never reached `ready`. Independently, wrap `claude-tui-session.js:773` `realpathSync` + the `mkdirSync` calls (701-703) so `start()` emits `error` and returns rather than rejecting.

#### TUI-AUDIT-020 — Worktree sessions orphan their worktree across restart — `worktreePath`/`worktreeRepoDir` never persisted
- **File:** `session-manager.js:1212-1283` (serializeState omits worktree fields), `1327-1378` (restoreState omits worktree flag), `805-807` (set only on creation), `1124-1125 & 1164-1166` (`_removeWorktree` gated on `entry.worktreePath`)
- **Trigger:** A session created with `worktree:true` sets `entry.worktreePath`/`worktreeRepoDir` and persists only `entry.cwd` (= the worktree dir). `serializeState` records none of `worktreePath`/`worktreeRepoDir`/a worktree flag. On restore, `createSession` is called with `cwd=<old worktree dir>` and no worktree flag, so the new entry has `worktreePath=null` and no new worktree is created.
- **Impact (TUI-primary):** If the worktree still exists, the session restores pointing at it but the manager no longer owns it as a worktree, so `destroySession` and `destroyAll` both skip `_removeWorktree`. The worktree directory + git worktree registration are orphaned permanently — one leaked worktree per worktree-session that survives a restart, never reaped by chroxy's teardown. (If the worktree was GC'd between sessions, `statSync` throws ENOENT → surfaced via `_registerFailedRestore`, which is acceptable.) Provider-agnostic (SessionManager-level) but affects TUI sessions.
- **Fix:** Persist `worktreePath` and `worktreeRepoDir` in `serializeState`, and in `restoreState` re-attach them onto the restored entry AFTER `createSession` (do NOT re-run `git worktree add` — the dir exists; just restore ownership so teardown reaps it). Validate the worktree still exists; if missing, register a failed restore that explains the worktree was reclaimed.

### WS transport & broadcast

#### TUI-AUDIT-019 — `session_event` forwarding listener has no try/catch — a single bad broadcast unwinds the provider's turn loop and aborts later side-effects
- **File:** `ws-forwarding.js:51-110`; `session-manager.js:1681/1792`; un-awaited `pushManager.send` at `ws-forwarding.js:242-245`; `push.js:572`
- **Trigger:** The `session_event` listener (51) runs `normalize` (89), `executeSideEffects` (99), `executeRegistrations` (100), broadcast loop (103-109) with no try/catch. `EventEmitter.emit` invokes listeners synchronously, so a throw propagates back into `SessionManager.emit('session_event')` and from there into the TUI provider emit.
- **Impact (TUI-primary):** Two compounding harms: (1) this listener is the conduit that converts TUI-AUDIT-006's orchestration throw into a process crash by re-entering the provider turn loop; (2) even discounting the crash, a mid-listener throw skips every side-effect and broadcast AFTER the throwing one — e.g. flush_deltas runs but the following `stream_end` broadcast is lost, leaving clients with a half-applied turn (stuck Running chip / busy state). With TUI primary this is the busiest event path. Separately, the un-awaited `pushManager.send` (244) is its own unguarded async rejection → daemon crash (via `unhandledRejection`).
- **Fix:** Wrap the listener body (52-109) in try/catch: `log.error` with `sessionId`+`event` and continue, isolating one malformed event from both the turn loop and from aborting unrelated side-effects. ALSO add `.catch()` to the un-awaited `pushManager.send` at 244. Apply the same wrap to `setupCliForwarding` (TUI-AUDIT-029).

#### TUI-AUDIT-021 — Unguarded broadcast inside normalizer's setTimeout delta-flush escapes as uncaught exception
- **File:** `event-normalizer.js:715-731`; armed at `676`; `stream_delta` returns `buffer:true` at `81`; routed via `ws-forwarding.js:93-95`
- **Trigger:** `bufferDelta()` arms `setTimeout(() => this._flushDeltas(), flushIntervalMs)` (676). `_flushDeltas()` (715) calls `this._onFlush(entries)` (728) with NO try/catch. `onFlush` is wired (`ws-forwarding.js:30-38`) to `broadcastToSession`/`broadcast`. The TUI path reaches this: `stream_delta` normalizes with `buffer:true`, so a single response burst is buffered.
- **Impact (TUI-primary):** A throw in a setTimeout callback is an uncaught exception → `process.on('uncaughtException')` at `server-cli.js:1181` → `process.exit(1)`: full daemon crash. Fires on the TUI streaming-delta path. (The broadcast leaf is try/caught, so the realistic throw is in `normalize`/filter/sideEffect orchestration — lower frequency, identical whole-process consequence, zero isolation.)
- **Fix:** Wrap the `this._onFlush(entries)` call in try/catch in `_flushDeltas()`: `try { this._onFlush(entries) } catch (err) { log.warn(...) }`. Keep `this._deltaBuffer.clear()` (730) in a `finally` so a throwing flush cannot wedge the buffer and re-throw next tick.

### Tunnel & connectivity failures

#### TUI-AUDIT-022 — Child crash path destroys sessions WITHOUT serializing state — loses session-state.json on any child uncaughtException/unhandledRejection
- **File:** `server-cli-child.js:123-137`; contrast `server-cli.js:1197, 1220`
- **Trigger:** Any uncaught exception or unhandled rejection inside the supervised child (throw in a tunnel/event/timer callback, a PTY error escaping a handler). In supervised mode this is the normal runtime — the common crash path for the TUI-primary backend.
- **Impact (TUI-primary):** Both handlers (uncaughtException 123, unhandledRejection 131) call `broadcastShutdown('crash',0)`, `wsServer.close()`, `destroyAll()` but NEVER call `serializeState()`. The parent handlers deliberately call `serializeState()` *before* `destroyAll()` specifically to avoid losing restored state on crash; the child omits it. A child crash therefore wipes message history / checkpoints / restore state that the supervisor's auto-restart would otherwise recover. Recurs the SIGTERM-state-flush class of bug. *(See also TUI-AUDIT-031 — the belt-and-suspenders facet of the same handlers.)*
- **Fix:** Mirror the parent: in both child handlers add `try { _sessionManager?.serializeState() } catch (e) { log.warn(...) }` BEFORE `destroyAll()`, matching `server-cli.js:1197-1201`.

#### TUI-AUDIT-023 — Named-tunnel credential/DNS failures discard the real cloudflared error, surfacing only a generic exit code
- **File:** `tunnel/cloudflare.js:119-121` (named reject); twin at `186-188` (quick); `98-108` (handleOutput scans only the success regex)
- **Trigger:** Named tunnel start fails for operational reasons (missing/expired credentials, tunnel name not found, DNS route not configured, missing cert.pem). cloudflared writes the specific error to stderr and exits non-zero before printing a "registered connection" line.
- **Impact (TUI-primary):** `handleOutput` only tests stderr/stdout against the success regex; the actual error text is never buffered. The close handler rejects (121) with the bare "cloudflared exited with code N before establishing tunnel". For named tunnels (the recommended stable-URL mode for the new primary backend), the operator gets a meaningless exit code and cannot distinguish credential expiry from DNS misconfig from a missing tunnel.
- **Fix:** In `handleOutput`, append each chunk to a small ring buffer (cap ~4KB). Include its tail in both rejects: `cloudflared exited (code N) before establishing tunnel. Last output: <tail>` at 121 and 188.

#### TUI-AUDIT-024 — Supervisor leaks the cloudflared process if initial `waitForTunnel` throws on boot
- **File:** `supervisor.js:183-223` (no try/catch around start() at 185 / `_waitForTunnel` at 223); `cli.js:48` (`program.parse()`, not parseAsync)
- **Trigger:** Cold start with no/blocked network or unpropagated DNS: `this._tunnel.start()` (185) spawns cloudflared and resolves once it reports a connection, but the tunnel is not yet routable. `_waitForTunnel(httpUrl)` (223) then throws `TUNNEL_NOT_ROUTABLE` after ~90s. No try/catch around 185-223 and no `this._tunnel.stop()` on the throw path.
- **Impact (TUI-primary):** The thrown error propagates out of `start()` → `startSupervisor` (no try/catch) → the commander async action. `cli.js` uses `program.parse()` (not `parseAsync`), so commander does not await/catch the action's promise — it becomes an unhandled rejection. With no supervisor-level handler (TUI-AUDIT-011), the supervisor aborts, but the cloudflared child spawned at 185 is never stopped — orphaned. Under launchd KeepAlive, each restart spawns another cloudflared, leaking one per restart in a no-network boot loop.
- **Fix:** Wrap 185-247 in try/catch; on failure call `await this._tunnel?.stop().catch(()=>{})` before rethrowing/exiting so cloudflared is always reaped. Combine with the supervisor-level unhandledRejection handler from TUI-AUDIT-011.

### Resource exhaustion & cleanup

#### TUI-AUDIT-025 — TUI hook sink-dir files and `_consumedFiles` Set grow unbounded for the whole session lifetime
- **File:** `claude-tui-session.js:1211-1231` (consumes, never unlinks), `1220` (`_consumedFiles.add`, cleared only at destroy 3285), `1197/1263` (`readdirSync` every poll + heartbeat), `3277-3281` (rmSync only at destroy)
- **Trigger:** A long-lived TUI session (the new primary backend) runs many turns/tool calls without `destroy()`. Each turn writes a `stop-<uuid>.json` plus `pre-/post-<uuid>.json` per tool call. `drainHookFiles` reads each and adds its name to `_consumedFiles` but never unlinks; `readdirSync(_sinkDir)` runs every ~150ms poll and on each heartbeat, with `entries.sort()` 3× per drain.
- **Impact (TUI-primary):** Files accumulate in tmpdir (inode/disk pressure; tmpdir is frequently a size-capped tmpfs whose exhaustion affects all processes), `_consumedFiles` grows to thousands of heap strings, and each 150ms poll re-reads + re-sorts the entire directory — degrading per-turn responsiveness as the session ages. The `destroy()` comment (3275-3276) explicitly acknowledges these "accumulate fast on long-running sessions", but destroy is the ONLY cleanup. *(This is the same root cause as TUI-AUDIT-014, surfaced under the resource-exhaustion lens — fix once.)*
- **Fix:** Unlink each hook file immediately after consuming it: `rmSync(full, { force:true })` right after `_emitToolHookEvent` / the `stopPayload` assignment (~1224/1230). Filenames are UUID-suffixed (205-208), so with files deleted on consume, `readdirSync` only ever sees in-flight files. **Do NOT** clear `_consumedFiles` mid-session — it is the intentional cross-turn dedup window for #3902; with unlink-on-consume it becomes redundant and can be dropped or kept as same-drain dedup only.

### Error propagation & observability

#### TUI-AUDIT-026 — `start()` resolves (does not reject) on warmup PTY death, so SessionManager auto-cleanup never runs and a zombie session is left in the list
- **File:** `claude-tui-session.js:746-749, 768-770, 846-848`; `session-manager.js:822-848`; sendMessage guard `1029-1030`
- **Trigger:** claude PTY exits during warmup (bad install, expired/missing OAuth, OOM, wrong cwd), or node-pty import fails, or `ptyMod.spawn` throws. `start()` emits an error event and returns NORMALLY (resolves); `_spawnPty`'s own failure paths also emit+return without throwing.
- **Impact (TUI-primary):** `createSession` only auto-destroys the phantom when `start()` throws synchronously (832) or rejects (826). TUI's `start()` resolves, so neither fires — the dead session stays in `_sessions` forever; every later `sendMessage` returns "Session not started or PTY no longer alive". SDK/CLI reject on start failure and get auto-cleaned, so TUI regresses recovery exactly as it becomes primary. *(Same root cause as TUI-AUDIT-008/015; this is the error-propagation framing — all three resolve with the same fix: make `start()` reject on unrecoverable spawn failure.)*
- **Fix:** In `start()`, throw instead of emit-and-return on the unrecoverable warmup path; make `_spawnPty` propagate the node-pty-unavailable and spawn-failure cases up. Keep emitting the error event for the client toast, but ensure `start()` rejects so `createSession`'s cleanup runs.

#### TUI-AUDIT-027 — claude-tui reports ready/healthy even when the user has never run `claude login` — no auth observability for the subscription the migration depends on
- **File:** `claude-tui-session.js:332-336` (preflight credentials `envVars:[]`, `optional:true`), `350-360` (resolveAuth hard-codes `ready:true`); `doctor.js:304` (credential check gated on `envVars.length > 0`)
- **Trigger:** User migrates to claude-tui without an active Claude Max subscription / without `claude login` (or expired OAuth). `resolveAuth()` always returns `ready:true`; the doctor credential check is skipped because claude-tui's `envVars` is `[]`.
- **Impact (TUI-primary):** `chroxy doctor` emits only the green `claude` binary check and NO credential line; `resolveAuth()`/the dashboard show claude-tui ready. The operator gets no warning. The real failure surfaces later and opaquely (TUI-AUDIT-013/005's stall, or TUI-AUDIT-026's zombie session). The true root cause — not authenticated — is never surfaced actionably. Highest-value observability gap for a migration whose purpose is running on the subscription.
- **Fix:** Add a real readiness probe to `resolveAuth()` (shell out to `claude` auth-status, or read the OAuth/Keychain credential location) and return `ready:false` with hint "run `claude login`" when absent. At minimum emit a doctor check that runs a lightweight auth-status probe so an unauthenticated install fails preflight loudly.

#### TUI-AUDIT-028 — Unexpected PTY death surfaces a generic error with no category/recoverable and no auto-restart — the session wedges with no provider-level recovery affordance
- **File:** `claude-tui-session.js:876-904, 899-903`; `event-normalizer.js:471-478`
- **Trigger:** The claude PTY exits unexpectedly while idle (crash, OOM, OS kill, OAuth token expiry mid/overnight) with no turn in flight (`hadActiveTurn === false`).
- **Impact (TUI-primary):** `onExit` emits `{ message: 'Claude PTY exited (code=...)' }` (902) with no `code`/`category`/`recoverable`, and there is no respawn — `_processReady` stays false, `_ptyExited` stays true. The normalizer error path only forwards a `code` when present, so this renders as a generic `messageType:'error'`, indistinguishable from a transient turn error. The dashboard cannot offer a "restart session" affordance distinct from "retry turn". Session is permanently dead until manual delete/recreate. Idle-time PTY death (common when an OAuth token expires overnight) silently bricks the session. *(Overlaps TUI-AUDIT-007's no-respawn root cause; this is the missing structured-error facet.)*
- **Fix:** Tag the unexpected-exit error with a stable `code` (e.g. `code:'pty_exited'`, `recoverable:false`) so the dashboard can branch on it, and either (a) implement bounded auto-respawn on unexpected idle exit, or (b) mark the entry needs-restart and surface a "Restart" action. Mirror the structured-code pattern already used (`stream_stall` at 2140/2189, `resume_unknown`).

---

## MINOR

### Process spawn & lifecycle

#### TUI-AUDIT-030 — Readiness probe keys on PTY pid, not claude's pid — wrong/missing session file degrades silently to never-ready
- **File:** `claude-tui-session.js:657-659, 970-986`; `--session-id` passed at `804`
- **Trigger:** `_waitForPrompt` reads `~/.claude/sessions/<this._term.pid>.json`. If claude is launched via a wrapper/shim (an npm-global/.bin candidate at 324-329 could be a shell shim, a future re-exec, or a non-`cli` entrypoint), the file is written under a different pid or lacks a `status` field → `readSessionStatus` returns null forever.
- **Impact:** Every readiness probe (spawn warmup AND per-turn) burns its full timeout and falls through to "write anyway". Spawn warmup wastes 15s, every turn wastes up to `TURN_PROMPT_WAIT_MAX_MS` (5s), and gating is effectively disabled, so prompt writes can land on a not-yet-ready TUI and be dropped — re-creating the keystroke-drop wedge the probe prevents. (Lower severity: the warn surfaces it, the watchdogs backstop, and the common direct-spawn path writes the file under the PTY pid correctly.)
- **Fix:** When `_lastProbeSawStatus` stays false for the whole warmup, treat it as a hard probe-degraded health signal rather than silently proceeding, and/or fall back to scanning `~/.claude/sessions` for the newest file matching `this._sessionId` (passed via `--session-id` at 804) instead of relying solely on `pty.pid`.

### PTY I/O & stream parsing

#### TUI-AUDIT-032 — ANSI/escape sequences split across PTY onData chunks corrupt the diagnostic output tail
- **File:** `claude-tui-session.js:851-875` (onData strips per-chunk at 860 before concatenating at 861); `592` (`PTY_TAIL_BYTES`); diagnostic consumers at `1945, 900-902, 1290`
- **Trigger:** A single multi-byte ANSI/escape sequence delivered across two onData callbacks. `ANSI_STRIP.replace` runs on each chunk independently before append, so a sequence straddling the boundary is not matched and its fragment survives into the readable `_outputTail`.
- **Impact:** Diagnostics only. `_outputTail` feeds `_outputTailDiagnostic()` (PTY-exit error text 900-902, stop-hook-timeout error text 1290) and hex dumps. Stray escape fragments make the surfaced error tail slightly garbled. No functional or parsing impact — turn parsing is file-based via the hook poller, not this tail.
- **Fix:** Strip ANSI on a small rolling buffer: append `rawStr` to a pending window, run `ANSI_STRIP` on the combined recent window, then slice to `PTY_TAIL_BYTES` so a split sequence is matched once both halves arrive. Low priority — cosmetic on an error-only path.

#### TUI-AUDIT-033 — Subprocess stdout/stderr streams have no `error` listener (Codex/Gemini path)
- **File:** `jsonl-subprocess-session.js:378` (createInterface on proc.stdout), `387` (stderr 'data'), `450` (proc 'error' — spawn-level only); no `proc.stdout.on('error')` / `proc.stderr.on('error')`
- **Trigger:** A pipe-level `error` on the child's stdout or stderr read stream (e.g. EPIPE/EIO on abnormal child death mid-write). `proc.on('error')` (450) is spawn-level only; readline does not forward an stdout stream `error`.
- **Impact:** An unhandled stream `error` becomes an uncaughtException → `server-cli.js:1181` → whole-daemon `process.exit(1)`. Lower severity because (a) this is the byok Codex/Gemini path being migrated AWAY from, not the TUI target, and (b) an `error` on a parent-side readable pipe is rare.
- **Fix:** Add `proc.stdout.on('error', e => { if (!this._destroying) this.emit('error', { message: \`stdout stream error: ${e?.message}\` }) })` and the stderr equivalent right after the readline/stderr wiring (after 405), so a stream error degrades to a session-scoped error instead of crashing the daemon.

### AskUserQuestion form-drive & watchdogs

#### TUI-AUDIT-034 — Freeform Other IIFE races interrupt(): guards on `_destroying`/`_term` but not `_activeTurn.aborted`
- **File:** `claude-tui-session.js:2590-2632` (IIFE), guards at `2607/2610/2619`, re-arm at `2623-2627`, stage-2 write at `2628`; `interrupt()` at `2347-2380`; abort check at `1455`; `_finishTurnError` nulls `_activeTurn` at `1909`; `OTHER_FREEFORM_SETTLE_MS`=150ms at `113`
- **Trigger:** User answers a single-question AskUserQuestion via the Other/freeform two-stage path. During the 150ms `OTHER_FREEFORM_SETTLE_MS` pause, the user clicks Stop → `interrupt()` sets `_activeTurn.aborted=true`, writes Ctrl-C, clears `_askUserQuestionWatchdog`, but does NOT set `_destroying` and does NOT null `_term`.
- **Impact:** After the settle await resumes, the IIFE guards (only checking `_destroying`/`_term`) all pass. It re-arms a watchdog `interrupt()` just cleared and writes `freeformText` into a PTY that just received Ctrl-C, landing as stray input on the freshly-cleared prompt and potentially submitting a bogus turn. (Downgraded to MINOR: the window is only 150ms and requires the specific Other-freeform path plus a Stop click inside that window — a precise, uncommon edge.)
- **Fix:** Add `if (this._activeTurn?.aborted) return` alongside the existing `_destroying` checks after each await in the IIFE (2607, 2610, 2619) so an interrupt during the settle window halts the stage-2 write and the watchdog re-arm.

#### TUI-AUDIT-035 — AskUserQuestion PreToolUse: a synchronous throw from the `multi_question_intervention` emit orphans the already-stored pending entry before `user_question` is emitted
- **File:** `claude-tui-session.js:1679` (pending entry set), `1707-1712` (multi_question_intervention emit), `1714` (user_question emit), `1226-1230` (drainHookFiles try/catch logs-and-continues); `session-manager.js:1791`
- **Trigger:** Multi-question AskUserQuestion (`questionCount > 1`). The pending entry is stored (1679), then `multi_question_intervention` is emitted (1707), then `user_question` (1714). A synchronous throw from a downstream `multi_question_intervention` listener (forwarded as a `session_event` to the ws broadcaster) propagates back through `.emit()` at 1707, caught by drainHookFiles' logs-and-continues try/catch.
- **Impact:** `_pendingUserAnswer` is set BEFORE `user_question`, so a throw at 1707 means `user_question` never reaches the dashboard: no QuestionPrompt UI, the user cannot answer, and the session sits `_isBusy=true` with a stored-but-unsurfaced pending entry until the 5-min stall backstop (itself buggy per TUI-AUDIT-004). Logged only as a generic "tool hook emit failed" warn. (Narrow reachability: requires `questionCount>1` plus a throwing broadcast listener, but the store-before-surface ordering bug is real.)
- **Fix:** Emit `user_question` first (or wrap each emit in the AskUserQuestion branch in its own try) so a downstream `multi_question_intervention` listener throw cannot prevent the user-facing question from surfacing. On any emit throw, fall through to a teardown that clears the orphaned pending entry.

### Auth & subscription-token failures

#### TUI-AUDIT-036 — Subscription token is never refreshed and its expiry is undetectable until a turn fails — no proactive auth check
- **File:** `claude-tui-session.js:350-360` (resolveAuth hardcoded `ready:true`), `317-338` (preflight credentials optional/empty), `773-801` (`_spawnPty` deletes ANTHROPIC_API_KEY, OAuth-only)
- **Trigger:** Long-lived persistent-PTY TUI session whose backing OAuth subscription token expires (or deauths) while the session is up.
- **Impact:** `resolveAuth()` unconditionally returns `ready:true` and preflight credentials are `optional:true` with empty envVars, so the dashboard shows the provider authenticated even after the host deauthed. `_spawnPty` deletes ANTHROPIC_API_KEY and relies entirely on the spawned claude CLI's own Keychain/OAuth state, which chroxy cannot read. No periodic or preflight auth probe exists. The first signal of expiry is a failed turn (TUI-AUDIT-005). Every long session is a ticking clock with no mid-session auth health signal. *(The early-warning gap behind TUI-AUDIT-005/027.)*
- **Fix:** Add a periodic/preflight auth probe (a non-interactive `claude` auth-status/whoami if available, or a freshness check of the `~/.claude` OAuth state file) and downgrade `resolveAuth()`/the dashboard auth chip when it fails, so expiry is visible BEFORE a turn hangs. If claude exposes a non-interactive auth-status command, gate `sendMessage` on it and emit `auth_expired` proactively.

#### TUI-AUDIT-037 — Warmup-exit error discards the PTY output tail — auth failure at session start gives a bare exit code with no cause
- **File:** `claude-tui-session.js:746-749` (warmup-exit emit, no tail) vs `876-903` (onExit handler, which DOES append `_outputTailDiagnostic()` at 899-903)
- **Trigger:** claude needs `claude login` (or hits an auth/limit wall) at spawn time and the PTY exits during warmup.
- **Impact:** The warmup-exit branch (747) emits "claude PTY exited during warmup (code=N)" with no tail. HOWEVER `onExit` (876) fires first with `hadActiveTurn=false`/`_destroying=false` and emits a SEPARATE error WITH the tail, so the auth tail IS surfaced. The residual defect is cosmetic: a redundant, tail-less duplicate error from the warmup branch with an inferior message. Not a lost-diagnostic bug.
- **Fix:** Either suppress the warmup-branch emit (let `onExit` be the single error source, mirroring the mid-turn dedup) or have the warmup branch build and append `_outputTailDiagnostic()`. Optionally run TUI-AUDIT-005's auth classifier here so a login-required spawn exit emits `code:'auth_expired'`.

#### TUI-AUDIT-038 — Timeout/warmup hex-dump of raw PTY bytes can leak credentials past the logger redactor
- **File:** `claude-tui-session.js:921` (warmup readiness timeout), `1125` (per-turn prompt-wait), `1015-1022` (`_outputTailHexDump`), `61-85` (`formatHexDump`); `logger.js:30-55, 62` (`redactSensitive`)
- **Trigger:** claude TUI renders sensitive material (an OAuth re-auth URL with embedded code/token, or a token echo) into the PTY around a warmup/turn readiness timeout, so it lands in `_outputTailRaw` and gets hex-dumped to the log.
- **Impact:** `redactSensitive` applies only TEXT regexes; `formatHexDump` emits bytes as space-separated hex pairs, which break every redaction regex, so a token in the raw tail is logged in the clear. The 16-byte-chunked ASCII column also fragments contiguous matches. Low probability (the TUI normally renders a URL to open, not the token), but on TUI-primary the auth-error timeouts that trigger the dump become routine, and the exposure is in on-disk logs.
- **Fix:** Run `redactSensitive` over the decoded ASCII before hex-encoding, or skip the hex/ASCII of any line matching a credential signature; alternatively cap the hex dump to non-printable control bytes only (its stated purpose is surfacing escape sequences, not readable text).

### State persistence & restore races

#### TUI-AUDIT-039 — Up to `persistDebounceMs` (2s) of message history is silently lost on SIGKILL / OOM-kill / power loss
- **File:** `session-state-persistence.js:203-213` (schedulePersist setTimeout debounce), `26` (`persistDebounceMs=2000` default); `session-manager.js:1628-1632` (`_recordHistory`→`_schedulePersist`)
- **Trigger:** History writes use a 2000ms debounced persist; only createSession/rename/destroy flush synchronously. SIGKILL, OOM kill, or hard power loss bypasses all SIGTERM/uncaughtException handlers, so any history accumulated within the last debounce window is never written.
- **Impact:** A completed assistant turn within the last 2s before a hard kill is lost from on-disk history; on restart the chat is missing the most recent exchange. Bounded (≤2s), only on non-graceful kills. Not corruption — recency-loss only. Project memory documents SIGKILL-vs-SIGTERM as a recurring footgun.
- **Fix:** Acceptable for graceful shutdown. Consider flushing synchronously on turn boundaries (stream_end/result) rather than debouncing so a completed turn is durable before the next starts, or lower `persistDebounceMs` for the primary path. Document that SIGKILL forfeits the debounce window.

#### TUI-AUDIT-040 — Fixed `.tmp` path lets concurrent SessionManagers on the same state file clobber each other
- **File:** `platform.js:87` (`tmpSuffix='.tmp'` default), `90` (`tmpPath = \`${filePath}${tmpSuffix}\``); `session-state-persistence.js:83` (calls `writeFileRestricted` with no `tmpSuffix`)
- **Trigger:** `writeFileRestricted` defaults `tmpSuffix` to `.tmp` and builds a fixed `tmpPath`. `session-state-persistence.js:83` calls it with no override, so all writers of the same `stateFilePath` share `session-state.json.tmp`. Two processes (accidental second daemon, supervisor double-spawn, stale instance) interleave their `writeFileSync`→`rename` on the identical temp file.
- **Impact:** One process's partial temp contents can be renamed into place by the other, or one's cleanup removes the other's temp mid-write, producing a corrupt or truncated main state file. Single-daemon is the design assumption, so this is an operational edge — but it is the only path to a genuinely corrupt MAIN state file (the normal single-writer path is atomic and crash-safe via tmp+rename).
- **Fix:** Pass a per-process temp suffix from `session-state-persistence.js:83`, e.g. `writeFileRestricted(path, data, { tmpSuffix: '.tmp-' + process.pid })`, or add an advisory lockfile so a second daemon refuses to write a state file already owned by a live PID.

### WS transport & broadcast

#### TUI-AUDIT-041 — `replayHistory` drain-poll has no max-wait cap — a dead-but-OPEN socket polls a setTimeout chain indefinitely
- **File:** `ws-history.js:48-64`; used in replay recursion at `488, 529`
- **Trigger:** `scheduleAfterDrain()` re-arms `setTimeout(poll, 20ms)` while `ws.bufferedAmount` stays above `BACKPRESSURE_PAUSE_THRESHOLD` (256KB) and `ws.readyState === 1`. The comment (30-37) explicitly acknowledges: a dead TCP connection that never leaves OPEN and never drains keeps polling indefinitely.
- **Impact:** A leaked recurring 20ms timer per such reconnect; replay never completes and never errors, so the client sits on partial history with no `history_replay_end`. Bounded in practice by the 30s WS keep-alive ping eventually flipping `readyState`, unbounded if the ping also stalls. TUI sessions can have the largest history payloads, making them the worst case.
- **Fix:** Add a max-wait/backoff cap: track a deadline (e.g. 60s or a small multiple of the ping interval); on exceed, stop polling and either send `history_replay_end` (degraded) or `ws.close()` so the normal departure path runs.

#### TUI-AUDIT-029 — Legacy-CLI forwarding listeners are unguarded (same crash shape as multi-session)
- **File:** `ws-forwarding.js:161-189`
- **Trigger:** `setupCliForwarding` registers `cliSession.on(event, (data) => { normalize(170); executeSideEffects(178); executeRegistrations(179); broadcast(181-187) })` for every `FORWARDED_EVENTS` entry with no try/catch. A throw propagates back into the legacy CliSession emit.
- **Impact:** Same process-crash conduit as TUI-AUDIT-019 but on the legacy single-CLI path. The TUI primary path uses `setupSessionForwarding` (40-41), NOT the cliSession branch, so this path is not exercised by the migration — it only bites deployments still running single-CLI mode.
- **Fix:** Wrap the per-event listener body (163-187) in try/catch with a `log.error`, symmetric with TUI-AUDIT-019.

### Tunnel & connectivity failures

#### TUI-AUDIT-042 — `chroxy doctor` cannot diagnose tunnel routability — the exact failure it is recommended for
- **File:** `doctor.js:147-159`; `tunnel-check.js:65`
- **Trigger:** User hits `TUNNEL_NOT_ROUTABLE`; the thrown error explicitly tells them to run `npx chroxy doctor`.
- **Impact:** `doctor` only runs `checkBinary('cloudflared', ...)` plus Node/config/provider checks — NO fetch/network/routability probe anywhere. For the entire class of connectivity failure the error redirects users to doctor for, doctor reports all-green — a dead-end diagnostic loop. For a remote-primary product, the failure mode that matters most stays undiagnosable.
- **Fix:** Add a connectivity check: a short-timeout fetch to a Cloudflare reachability endpoint (e.g. `https://1.1.1.1/cdn-cgi/trace`) reporting pass/warn/fail, distinguishing "binary missing" from "network blocks Cloudflare".

#### TUI-AUDIT-043 — `tunnel_lost`/`recovering` error broadcasts are emitted into a downed tunnel and silently lost; client never learns the tunnel flapped
- **File:** `server-cli.js:166-176`
- **Trigger:** Tunnel drops. `tunnel_lost` calls `wsServer.broadcastError('tunnel', ..., true)` (170); `tunnel_recovering` calls `broadcastStatus` (175). The tunnel — the only path to remote clients — is down at that exact moment.
- **Impact:** These messages are written to WebSocket sockets whose underlying Cloudflare transport is dead, so remote clients never receive them. The remote user sees an unexplained silent gap with no in-app recovery indication; only the operator-side log records it. Recurs on any quick-tunnel rotation.
- **Fix:** On `tunnel_recovered` (after routability passes), send one coalesced "connection was briefly interrupted and has recovered" status and rely on the app treating any reconnect as an implicit recovered signal.

### Resource exhaustion & cleanup

#### TUI-AUDIT-044 — Worktree auto-reaper runs once at startup only — agent worktrees created during a long-running server accumulate unreaped
- **File:** `server-cli.js:1122-1126` (only call to `maybeAutoReapWorktrees`, fire-and-forget); `worktree-reaper.js:69-103` (sole entry point, no setInterval)
- **Trigger:** `config.worktreeGc.autoReap === true` and the server stays up while agents create-and-orphan git worktrees (`.claude/worktrees/agent-*` dead-pid-locked). The sweep happens only at boot; any worktree orphaned by a dead pid AFTER boot is never reclaimed until the next restart.
- **Impact:** The auto-reaper was built precisely to stop orphaned-worktree disk-fill (project memory: 162 worktrees / ~15 GB observed). A long-uptime TUI-primary server is exactly where post-boot orphans pile up. Eventual blast radius is host disk-fill that can break new worktree creation. (Opt-in and default OFF, orthogonal to the TUI provider, with manual `chroxy worktree gc` available — hence MINOR.)
- **Fix:** When `worktreeGc.autoReap` is true, after the boot sweep arm a long-interval configurable `setInterval` (e.g. hourly) calling `reapWorktrees`, `.unref()`'d, cleared in the shutdown handler.

#### TUI-AUDIT-045 — WebTaskManager poll loop never completes tasks — every healthy web task is force-failed as "timed out" after 10 minutes
- **File:** `web-task-manager.js:246-270` (`_pollTaskStatus` placeholder, comment at 268-269), `256-266` (MAX_POLL_COUNT force-fails still-running tasks)
- **Trigger:** Any successful `launchTask()` sets `status='running'` and starts polling. `_pollTaskStatus` increments `_pollCount` but the real status-check is an unimplemented placeholder ("will be implemented when the CLI ships"), so a task can NEVER reach `completed`. After MAX_POLL_COUNT (60×10s = 10 min) the loop force-fails every still-running task with "Task timed out waiting for status update" and emits `task_error`.
- **Impact:** Every web/cloud task that runs normally is reported as FAILED with a misleading timeout error — success shown as failure, a broken feature. (Gated behind `--remote` CLI capability and not the TUI path, hence MINOR.)
- **Fix:** Until the CLI status-check ships, do not auto-fail running tasks on the placeholder path: leave them `running` or gate the force-fail behind a real status query. At minimum change the forced terminal message so it does not assert failure for unknown-status tasks, and document the feature as detection-only.

#### TUI-AUDIT-046 — WebTaskManager poll interval timer is not unref'd
- **File:** `web-task-manager.js:226-228` (setInterval in `_startPolling`, no `.unref()`); contrast `docker-byok-pool.js:392`
- **Trigger:** A web task is launched and polling starts; the 10s setInterval keeps the Node event loop alive until `_stopPolling`/`destroy` runs.
- **Impact:** On a clean exit that bypasses ws-server shutdown (the only caller of `WebTaskManager.destroy()`), the live interval can delay or block event-loop drain. Bounded — `destroy()` clears it on the normal path and the loop self-stops when no tasks run.
- **Fix:** After creating the interval, add `if (this._pollTimer?.unref) this._pollTimer.unref()`, mirroring `docker-byok-pool.js:392`.

#### TUI-AUDIT-047 — `docker rm -f` eviction failures are logged-and-swallowed with no operator-visible signal
- **File:** `docker-byok-pool.js:586-598` (`_evict` resolves regardless of error; `log.warn` at 593), called from idle (386-388); EVICTED emitted at 385 BEFORE the rm result is known
- **Trigger:** `docker rm -f <id>` fails for a reason other than already-gone (daemon hang/restart mid-rm, permission error, storage-driver failure). `_evict` catches, `log.warn`s, and `resolve()`s unconditionally; the pool already emitted EVICTED and dropped its bookkeeping, but the container is NOT removed.
- **Impact:** The pool believes the container is gone and stops tracking it while it lingers in Docker — a real container/disk leak no chroxy metric surfaces. (Gated behind `CHROXY_DOCKER_BYOK_POOL`, orthogonal to TUI — in fact one of the BYOK paths the migration moves away from, hence MINOR.)
- **Fix:** In `_evict`, distinguish a benign "no such container" from other rm failures via the error text; on a non-benign error emit a distinct pool event (e.g. EVICT_FAILED) and/or surface it via pool stats so an operator can see leaked-container count.

### Error propagation & observability

#### TUI-AUDIT-031 — Supervised daemon crash handlers omit the explicit pre-destroy `serializeState` that the foreground path has
- **File:** `server-cli-child.js:123-129` (uncaughtException), `131-137` (unhandledRejection); contrast `server-cli.js:1197/1220`; `session-manager.js:1144-1151`
- **Trigger:** The supervised daemon (default) hits an uncaughtException or unhandledRejection.
- **Impact:** Both child handlers call `destroyAll()` (which flushes via `serializeState()` at `session-manager.js:1148`) but, unlike the foreground handlers, do NOT first call `serializeState()` as an independent belt-and-suspenders write. `destroyAll()` runs `stopSessionTimeouts()` (1145) and `cancelPersist()` (1146) BEFORE its internal serialize — if either throws, there is no earlier good snapshot. *(Same handlers as TUI-AUDIT-022; that finding is the missing-flush facet for the broadcast-throw case, this is the belt-and-suspenders ordering — both fixed by adding the guarded `serializeState()` before `destroyAll()`.)*
- **Fix:** Mirror the foreground handlers: add `try { if (_sessionManager) _sessionManager.serializeState() } catch (e) { log.warn(...) }` BEFORE the `destroyAll()` call in both handlers.

#### TUI-AUDIT-048 — Session error events only reach clients already subscribed to the session — a fatal session error can be invisible to a client viewing a different session
- **File:** `ws-forwarding.js:103-108` (error broadcast via `broadcastToSession`); recipient filter at `ws-broadcaster.js:125-127`; `ws-server.js:764-767` (session_created handler does NOT auto-subscribe)
- **Trigger:** A claude-tui session emits `error` (PTY death, warmup failure) while the only connected client has a DIFFERENT session focused and is not subscribed to the failing session.
- **Impact:** The normalized error is delivered with `broadcastToSession(sessionId, msg)`, whose default filter only matches clients where `activeSessionId === sessionId` OR `subscribedSessionIds.has(sessionId)`. There is NO auto-subscribe at session create (the `session_created` handler only registers the hook secret) — auto-subscribe only happens on question/permission dispatch. So a Control Room operator watching session A never sees session B's fatal error. The push `activity_error` path backstops only if push tokens are registered.
- **Fix:** For terminal/fatal session errors (PTY exit, warmup failure), additionally broadcast a session-list refresh or a fatal `session_error` to ALL authenticated clients with the `sessionId` so every UI badges the affected session, not just current subscribers.

---

## Recommended Remediation Order

Land these before flipping the default backend to `claude-tui`. The ordering is: stop silent data loss, then stop whole-daemon crashes, then restore per-session recovery, then fix the interactive flow, then observability, then the long-tail hardening.

**Phase 0 — Data integrity (must-have, blocks migration):**
1. **TUI-AUDIT-001** — persist + forward `resumeSessionId` (add the getter, destructure in constructor, `--resume`, flip `capabilities.resume`, add the CI round-trip assertion). Nothing else matters if every restart wipes context.
2. **TUI-AUDIT-002** — flush in the IPC `shutdown` handler. Routine supervised stop currently loses all state.
3. **TUI-AUDIT-022 + TUI-AUDIT-031** (same handlers) — add the guarded `serializeState()` before `destroyAll()` in both child crash handlers.

**Phase 1 — Whole-daemon crash vectors (must-have, blocks migration):**
4. **TUI-AUDIT-003** — register the session-scoped PTY `error` handler (and harden `uncaughtException` so a per-session fault cannot kill the host).
5. **TUI-AUDIT-006** — `.catch()` on the fire-and-forget `sendMessage` at `input-handlers.js:502`.
6. **TUI-AUDIT-019** — wrap the `session_event` forwarding listener in try/catch + `.catch()` the un-awaited `pushManager.send`. This is the conduit that turns 4/5/21 into crashes, so it is high-leverage.
7. **TUI-AUDIT-009** — wrap the async HTTP handler body in try/catch (+ the index.html `readFileSync`).
8. **TUI-AUDIT-021** — wrap `_flushDeltas`'s `_onFlush` call in try/catch (with `clear()` in `finally`).
9. **TUI-AUDIT-010 + TUI-AUDIT-011** — guard both `tunnel_recovered` handlers; add the supervisor `unhandledRejection`/`uncaughtException` handlers and the child `disconnect` self-terminate.

**Phase 2 — Per-session recovery & zombie elimination (must-have):**
10. **TUI-AUDIT-008 / 015 / 026** (one root cause) — make `start()`/`_spawnPty` reject on unrecoverable spawn failure and gate the `ready` emit, so SessionManager auto-cleanup runs.
11. **TUI-AUDIT-018** — route restore-time `start()` rejections through `_registerFailedRestore` (and wrap the `realpathSync`/`mkdirSync` paths) so a restore failure never flush-erases good history.
12. **TUI-AUDIT-007 + TUI-AUDIT-028** — bounded per-session auto-respawn on unexpected PTY exit + structured `pty_exited` error code (or, minimum, SessionManager-driven `destroySession` + a Restart affordance).
13. **TUI-AUDIT-012** — SIGKILL escalation in `destroy()`.

**Phase 3 — Interactive flow correctness (must-have for the subscription UX):**
14. **TUI-AUDIT-004** — suspend stall/inactivity timers while a human answer is pending. This silently destroys real questions today.
15. **TUI-AUDIT-016** — per-`toolUseId` watchdog Map for parallel questions.
16. **TUI-AUDIT-017** — teardown-with-actionable-error on the freeform-drop paths.

**Phase 4 — Auth observability (strongly recommended before migration):**
17. **TUI-AUDIT-005 + TUI-AUDIT-013** — auth/limit classifier at every turn-failure + spawn-warmup site, emitting `auth_expired`/`auth_required` instead of generic "try again".
18. **TUI-AUDIT-027 + TUI-AUDIT-036** — real `resolveAuth()` probe + doctor credential row + periodic mid-session auth health check.

**Phase 5 — Leak & remaining hardening (can follow the flip, but schedule promptly):**
19. **TUI-AUDIT-014 / 025** (one root cause) — unlink hook files on consume; bounds disk + per-tick scan on long sessions.
20. **TUI-AUDIT-020** — persist + re-attach worktree ownership across restart.
21. **TUI-AUDIT-023 / 024 / 042** — surface real cloudflared errors, reap cloudflared on boot-failure, add doctor routability probe.
22. **TUI-AUDIT-048** — broadcast fatal session errors to all clients.
23. Remaining MINORs (TUI-AUDIT-030, 032–035, 037–041, 043–047, 029) as opportunistic cleanup — several are off the TUI path (legacy-CLI, BYOK docker pool, web tasks) and are lowest priority under the migration lens.

---

## Coverage gaps & next probes

The verified findings concentrate on `claude-tui-session.js` internals (PTY death, watchdogs, auth), state persistence, and the supervisor/tunnel/WS layers. The following failure surfaces sit at subsystem *boundaries* or in files no single finder opened, so they fall through the matrix — and several are load-bearing precisely because the TUI path is FS-and-hook driven rather than in-process like the SDK path.

**Probe status (updated 2026-06-09).** The nine coverage-gap probes below were filed as IP-1…IP-9 and triaged. Six are confirmed and fixed; three remain open. (The stale-`/tmp`-sweep gap was folded into work-package WP-5.1, #5323, and is also fixed.)

| Probe | Issue | Status |
|-------|-------|--------|
| IP-1 — `/tmp` hook-sink vanishes mid-session | #5329 | ✅ Fixed (PR #5410) |
| IP-2 — permission-hook.sh fails to an unanswerable native dialog | #5330 | ✅ Fixed (PR #5409) |
| IP-3 — fixed 120×30 PTY geometry couples the form-parser to width | #5331 | ⬜ Open |
| IP-4 — `Date.now()` watchdogs break on clock step | #5332 | ✅ Fixed (PR #5414) |
| IP-5 — attachment disk-write failure → daemon crash | #5333 | ⬜ Open |
| IP-6 — sidecar permission-mode read/write race across the shell boundary | #5334 | ✅ Fixed (PR #5407) |
| IP-7 — checkpoint restore failure + orphan git refs | #5335 | ✅ Fixed (PR #5408) |
| IP-8 — no SIGHUP handler on a PTY-owning daemon | #5336 | ✅ Fixed (PR #5406) |
| IP-9 — cross-session head-of-line blocking on the shared event loop | #5337 | ⬜ Open |

- **[IP-1 · ✅ Fixed in #5410]** **The `/tmp` hook-sink filesystem dependency (claude-tui-session.js:700, poll loop :1197).** The entire TUI tool/permission/stop signal path flows through files under `os.tmpdir()/chroxy-claude-tui/s-<uuid>/`. The drain loop swallows `readdirSync` errors with `catch { return }` and JSON parse errors with `catch { continue }`. If `/tmp` is tmpfs-cleared, the dir is unlinked by a system tmpwatch on a long-running daemon, the volume fills (ENOSPC on the hook's `cat > .../pre-*.json`), or SELinux/perms change, then hooks stop arriving but the loop just keeps returning empty — the turn wedges and only the soft-inactivity watchdog (if armed) ever fires. No finding probed `/tmp` as a *runtime* dependency that can vanish mid-session. *Probe next: with a live TUI turn mid-flight, `rm -rf /tmp/chroxy-claude-tui/s-*` (or fill the tmp volume) and watch whether the session surfaces an error or silently hangs.*

- **[WP-5.1 · ✅ Fixed in #5323]** **No process-wide cleanup of stale `/tmp/chroxy-claude-tui` across crash/restart.** `destroy()` does `rmSync(this._sinkDir)`, but there is no boot-time sweep of the base dir (unlike worktrees, which got `worktree-reaper.js`). After every SIGKILL/OOM/crash the per-session sink dirs leak forever; with TUI as the primary backend this is now the *common* exit path, accumulating inodes and hook payloads on the tmp volume until it fills — at which point new sessions fail their `writeHookSettings` write at start. *Probe next: kill -9 the daemon 50× and check `ls /tmp/chroxy-claude-tui | wc -l`.*

- **[IP-2 · ✅ Fixed in #5409]** **permission-hook.sh failure semantics — the human-out-of-the-loop trap (hooks/permission-hook.sh:172, default `*` case).** On any curl failure (`--max-time 300` exceeded, daemon restarting, port rebind, connection refused mid-request) the hook emits `permissionDecision:"ask"`. In an interactive terminal "ask" means claude shows its own dialog — but a chroxy-driven PTY has no human at *that* keyboard, only the remote app. If the round-trip to the phone fails, claude falls back to its built-in prompt that nobody can answer, and the only watchdog that knows about it is the AskUserQuestion path, not arbitrary tool permissions. This shell-to-server boundary was never audited. *Probe next: kill the daemon's HTTP listener while a Bash tool is pending permission and observe whether the PTY parks on an unanswerable native dialog.*

- **[IP-3 · ⬜ Open — #5331]** **No PTY resize / fixed 120×30 geometry coupling the parser to terminal width (claude-tui-session.js:841).** The PTY is hardcoded `cols:120, rows:30` with no `resize()` and no SIGWINCH. claude's TUI reflows AskUserQuestion menus and Pasted-text placeholders by width; the form-drive logic (arrow-nav, digit hotkeys, paste throttle) implicitly assumes this geometry. If a future claude version changes its layout at 120 cols, or the multi-question form wraps differently, the byte-sequence drive silently mis-targets — a wedge with no error. No finder examined geometry as a correctness dependency of the form-drive. *Probe next: diff the pinned form byte-sequences against claude output at cols:80 and cols:200 to see how brittle the width assumption is.*

- **[IP-4 · ✅ Fixed in #5414]** **`Date.now()` (wall clock) drives all stall/watchdog timing — 23 sites (claude-tui-session.js).** Every stall, first-output, and AskUserQuestion watchdog computes elapsed time from `Date.now()`. On a laptop that sleeps/resumes or has NTP step the clock backward, a long-running turn's elapsed math goes negative or jumps, either firing a false "stalled" cancel or never firing at all. For a subscription-driven dev box that sleeps nightly, this is a routine event, not exotic. No finding considered clock discontinuity. *Probe next: `sudo date` a few minutes backward during an active turn and watch the watchdogs.*

- **[IP-5 · ⬜ Open — #5333]** **claude-tui-attachments.js disk-write failure on the input path (writeFileSync :219, mkdirSync :195).** Inbound attachments are written under the same `/tmp` sink with bare `writeFileSync`/`mkdirSync` and no try/catch around the write itself. An ENOSPC or perms error here throws synchronously into whatever drives message send; combined with the "fire-and-forget sendMessage rejection → process.exit(1)" finding, an attachment on a full tmp volume becomes a daemon crash, not a per-message error. This file was listed only for path-traversal safety, never for the disk-failure path. *Probe next: fill the tmp volume and send a message with an image attachment.*

- **[IP-6 · ✅ Fixed in #5407]** **Sidecar `permission-mode` file: read-during-write race between set_permission_mode and the hook (claude-tui-session.js:2311–2337 writes; permission-hook.sh reads it on every tool call).** `setPermissionMode()` rewrites the sidecar with a plain `writeFileSync` (non-atomic — no temp+rename), while the shell hook `cat`s it on every PreToolUse. A tool call landing mid-write reads a truncated/empty mode and falls into the hook's default branch. The poll-loop and the permission-manager were each audited in isolation; the *shell-reads-file-server-writes-file* concurrency across the language boundary was not. *Probe next: hammer set_permission_mode in a loop while a tool-heavy turn runs and grep the hook output for empty-mode fallbacks.*

- **[IP-7 · ✅ Fixed in #5408]** **checkpoint-manager.js git-ref restore on the TUI path (restore throws :375, eviction `.catch` swallows :109/:215/:233).** Checkpoint create/restore shells out to git; eviction failures are logged-and-swallowed (orphan git refs accumulate) and a restore failure throws a generic `Git restore failed`. As the primary backend, TUI sessions will checkpoint far more; no finding traced what happens when a checkpoint restore fails mid-session (does the session stay usable, or wedge?) or when orphan refs pile up in the user's real repo. *Probe next: corrupt a checkpoint git ref and trigger restore; separately, count dangling chroxy refs after many checkpoint evictions.*

- **[IP-8 · ✅ Fixed in #5406]** **No SIGHUP handler on a PTY-owning daemon (only SIGINT/SIGTERM at server-cli.js:1178–1179).** A daemon that owns PTYs is exactly the process that receives SIGHUP when its controlling terminal/SSH session closes. Default SIGHUP action is terminate — and it bypasses the SIGTERM `shutdown()` state-flush path entirely, so a closed launching terminal silently kills the daemon *and* loses session-state.json. The signal-handling class was probed for SIGTERM/SIGKILL but not SIGHUP, which is the more likely trigger for a daemon started from a terminal that then closes. *Probe next: start the daemon non-detached, `kill -HUP` it, and check whether shutdown's state flush ran.*

- **[IP-9 · ⬜ Open — #5337]** **Cross-session blast radius of one wedged TUI sharing the single-process event loop.** Findings treat each TUI failure per-session, but with TUI primary there will be N concurrent PTYs in one Node process. The synchronous `readdirSync`/`readFileSync` poll loops, synchronous attachment writes, and the per-turn drain all run on the shared event loop; one session on a slow/hung NFS-backed `/tmp` blocks *every other session's* WS heartbeat and broadcasts. No single-session finder could see this aggregate head-of-line blocking. *Probe next: run 5 TUI sessions, put one session's sink dir on a frozen FUSE/NFS mount, and measure latency on the other four.*
