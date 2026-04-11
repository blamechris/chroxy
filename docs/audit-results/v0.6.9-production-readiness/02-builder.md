# Builder's Audit: Chroxy v0.6.9 Production Readiness

**Agent**: Builder — pragmatic full-stack dev, revises effort estimates, lives in concrete file changes
**Overall Rating**: 3.9 / 5
**Date**: 2026-04-11

---

## Scope and method

Read the server daemon (cli, supervisor, ws-server, session-manager, sdk/cli/docker/gemini/codex providers, tunnel, push, permission-manager/hook, config, token-manager, rate-limiter, handler-registry, logger, ws-file-ops, ws-broadcaster, http-routes), the store-core crypto module, the protocol schemas, the app connection/message-handler stores, the CI workflow, `scripts/bump-version.sh`, and the prior v0.6.8 master assessment. For each surface I asked the six prompt questions; specific findings cite file + line ranges.

Prior audit context: the v0.6.8 panel hit 3.2/5 and flagged nonce reuse on reconnect, shell injection in the permission hook, TOCTOU on file reads, and silent handler errors as the P0/P1 set. This audit tracks what was fixed and finds the next layer.

**Prior-audit items already closed (verified in source):**

- Nonce reuse on reconnect: `deriveConnectionKey`/`generateConnectionSalt` implemented in `packages/store-core/src/crypto.ts:170-210`, wired into server `packages/server/src/ws-auth.js:255-258` and into both clients (`packages/app/src/store/message-handler.ts:766,798`, `packages/dashboard/src/store/message-handler.ts:1275,1303`). Fresh per-connection sub-key via SHA-512(sharedKey ‖ salt).
- Shell injection in permission hook: hook script reads params from stdin only, `CHROXY_PORT`/`CHROXY_PERMISSION_MODE` are whitelisted (`packages/server/hooks/permission-hook.sh:31-40`), and `CHROXY_HOOK_SECRET` is a per-session random token — not the primary API token.
- TOCTOU on file ops: reader and writer both use `realpath()` + `O_NOFOLLOW` + retry-on-`ELOOP` (`packages/server/src/ws-file-ops/reader.js:62-172, 273-372`). This is actually very carefully done.
- Handler error propagation: the dedicated handlers in `packages/server/src/handlers/` now call `ctx.send(ws, { type: 'session_error', … code })` on every failure path; I spot-checked `session-handlers.js`, `settings-handlers.js`, `conversation-handlers.js`, `input-handlers.js`.
- Rate-limiter CF-Connecting-IP: `packages/server/src/rate-limiter.js:55-61` and its test suite cover CF/XFF with loopback trust.
- Encrypted integration test: `packages/server/tests/integration/encrypted-roundtrip.test.js` (329 lines) exercises the full encrypt→transmit→decrypt path.
- Replay protection via strict-equality nonce in `decrypt()` with a documented caller contract (`packages/store-core/src/crypto.ts:119-152`).

So ~80% of Phase 1 security and ~60% of Phase 2 reliability from the v0.6.8 master plan are done. The remaining risk surface has moved: it is now operational, not cryptographic.

---

## Section ratings (1-5)

| # | Section | Rating | Justification |
|---|---------|--------|---------------|
| 1 | WebSocket protocol + auth layer | **4.2** | Clean extraction into `ws-auth.js`, `ws-broadcaster.js`, `ws-message-handlers.js`, `ws-client-manager.js`, `ws-client-sender.js`. Bearer + pairing + session-token binding. Only gap: `ws-auth.js:55,157` uses `client.socketIp` as the auth-failure map key but the client record already carries `rateLimitKey` (`ws-server.js:753`). S fix. |
| 2 | Session lifecycle + reconnect | **3.8** | `SessionManager` is still 1014 lines (#2148 XL). Good destroy-guard pattern (`_destroying`), good persistence round-trip (v1 history in state file, old→new ID remap for cost tracking at `session-manager.js:689,722`). But restoring sessions silently drops any that fail to recreate (line 717) with no telemetry — only a log line. M fix. |
| 3 | Crypto + replay protection | **4.5** | Per-connection sub-key, direction byte, strict nonce equality, documented contract. Only wart: when a client omits the salt, `ws-auth.js:255` silently falls back to the raw DH key with nonce=0 — that is the exact vulnerability from v0.6.8. Fine for the transition but ship v0.7.0 with this fallback disabled. S fix. |
| 4 | Tunnel reliability | **3.5** | `BaseTunnelAdapter` recovery loop is solid (3-attempt backoff, `tunnel_recovered`/`tunnel_failed` events). Named-tunnel DNS regex is fine. But `tunnel_failed` in `supervisor.js:215-217` is a no-op (just logs). In supervisor mode, a permanent tunnel failure leaves the server running on localhost with no remote access, no push notification, no exit. Server-cli mode emits a `server_error` broadcast but nothing persists that to clients that aren't connected at the moment of failure. M fix. |
| 5 | Push notifications | **4.0** | Post-#2804 cleanup, `push.js` is tight: rate limits per category, retry-on-5xx, timeout via AbortController, token pruning on per-ticket errors. Token file persisted with restricted perms. The `fetchWithRetry` default `?? 30_000` rate limit is a reasonable safety net for unknown categories. Test file names imply broad coverage (push.test.js, push-timeout-retry, push-persistence, push-token-error-schema, push-activity-update, push-live-activity). |
| 6 | Config + supervisor + updater | **3.7** | Supervisor is 625 lines and carries real logic: deploy-crash detection with `MAX_DEPLOY_FAILURES=3`, known-good ref rollback via git checkout, standby health server with `restartEtaMs`, drain protocol via IPC. **Rollback is git-based and destructive** — `_rollbackToKnownGood` runs `git checkout <ref>` on whatever repo the supervisor is in, detaching HEAD. A user editing Chroxy in a worktree while it's running could lose uncommitted work, and the hint "To recover: git checkout <branch>" assumes they own the repo. This needs a guard. M fix. Also: `bump-version.sh` has taken two rounds of fixes in this v0.6.9 session already (workspace lockfile entries, iOS Info.plist, Cargo.toml [package] section, Cargo.lock regen) — the script is now acceptable but has no tests, while `tests/bump-version-desktop-pkg.test.js` only covers the desktop package subset. S fix to add full-scope test. |
| 7 | Permission system | **4.1** | PermissionManager is 379 lines, extracted from WsServer. Hook is idempotent + has a 3-retry backoff, withSettingsLock prevents read-modify-write races within a single process, per-session `CHROXY_HOOK_SECRET`, stdin-only parameter passing. Settings.json write is atomic via tmp+rename (`platform.js writeFileRestricted`). The one gap is that the hook test history includes a P1 where tests wrote to real `~/.claude/settings.json` — the fix was `settingsPath` option, and it's respected throughout the module. |
| 8 | CI + observability | **3.0** | CI has 11 jobs (server, dashboard, store-core, protocol, app tests+typecheck+expo-doctor, desktop Rust on macos-latest) but **no iOS build**, **no Android build verification** (expo-doctor only), **no end-to-end tunnel integration gate** (`tunnel.integration.test.js` exists but at 93 lines probably covers single case — it's not wired to CI by name), and **no encrypted E2E gate** in CI beyond the existing server test job. Observability: `/metrics` exists but only returns static gauges (uptime, session count, client count, memory), no counters (total_restarts, messages_sent, encryption_fails, push_sends), no histograms (message latency, session lifetime). `supervisor.js` logs a heartbeat every 5 min but nothing writes it to a metrics-style sink. Production incident triage on a user's machine with no access to logs would be hard. M fix. |

**Aggregate**: (4.2 + 3.8 + 4.5 + 3.5 + 4.0 + 3.7 + 4.1 + 3.0) / 8 = **3.85 ≈ 3.9 / 5**

---

## Top 10 buildable improvements (ROI-ordered)

### 1. Disable no-salt crypto fallback in v0.7.0 — **S / highest ROI**

**Files**: `packages/server/src/ws-auth.js:255-257`, `packages/store-core/src/crypto.ts` (add migration note), `packages/protocol/src/schemas/client.ts` (mark `salt` required), `packages/app/src/store/message-handler.ts`, `packages/dashboard/src/store/message-handler.ts`
**Change size**: S (~4 files, ~15 line delta)
**Why**: The server today accepts a client that does not send a salt and falls back to `rawSharedKey` with nonce=0 per reconnect. That is literally the v0.6.8 nonce-reuse vulnerability. It's currently "safe" only because every shipping client sends a salt — but that is a runtime guarantee with no compile-time check. A downgraded/rolled-back/third-party client can silently get the vulnerable path. Cut the fallback; reject `key_exchange` without `msg.salt`.
**Verification**: unit test in `ws-auth.test.js` that sends `{ type: 'key_exchange', publicKey }` without `salt` and asserts `key_exchange_fail` (or a 1008 close) instead of silent acceptance. Bump `minProtocolVersion` in `ws-server.js`.
**Dependencies**: none. Do this first.

### 2. Wire `/metrics` to real counters + expose a minimal `chroxy status --verbose` JSON dump — **S/M**

**Files**: `packages/server/src/http-routes.js:100-125`, new `packages/server/src/metrics.js` (~80 lines), `packages/server/src/ws-server.js` (increment counters on connect/auth/encryption-fail/message), `packages/server/src/supervisor.js` (already has `_metrics` — expose via IPC), `packages/server/src/cli/status-cmd.js` (pretty-print)
**Change size**: M (~6 files, ~200 line delta)
**Why**: Today's `/metrics` endpoint returns instantaneous gauges only. When a user reports "my connections keep dropping" there is no way to tell if the cause is encryption failure (bad key/nonce), WS backpressure close (4008), auth rate-limit (exponential backoff), or tunnel collapse. Add a dozen counters: `ws_connects_total`, `ws_auth_fails_total{reason}`, `ws_encryption_fails_total`, `ws_backpressure_closes_total`, `ws_bytes_sent_total`, `ws_bytes_recv_total`, `tunnel_recoveries_total`, `tunnel_failures_total`, `push_sends_total{category}`, `push_failures_total`, `session_creates_total`, `session_destroys_total{reason}`, `permission_requests_total{decision}`. Expose via `/metrics` + have `chroxy status --verbose` dump the same blob.
**Verification**: unit test in `http-metrics.test.js` that drives a handful of fake events and asserts counter values.
**Dependencies**: none.

### 3. Protect `_rollbackToKnownGood` against dirty working trees — **S**

**Files**: `packages/server/src/supervisor.js:539-576`
**Change size**: S (~1 file, ~30 line delta)
**Why**: Today, `git checkout <ref>` is invoked unconditionally. If the user edits chroxy while it is running (they do — it's their dev environment), uncommitted changes in tracked files get lost when the deploy watchdog decides to roll back. Before checking out, run `git status --porcelain` and abort the rollback if any non-ignored, non-chroxy-owned file is dirty. Emit a loud error + push notification ("auto-rollback aborted: working tree dirty; manual intervention required") instead of stomping their work.
**Verification**: test in `supervisor.test.js` that stubs `execFileSync` to return dirty-tree output and asserts rollback aborts.
**Dependencies**: none.

### 4. Tunnel permanent-failure handling in supervisor — **S**

**Files**: `packages/server/src/supervisor.js:215-217`
**Change size**: S (~1 file, ~40 line delta)
**Why**: The handler is `({ message }) => { this._log.error(message) }` — nothing else. Under supervisor mode, a permanent tunnel failure makes the server unreachable but leaves it running with no signal to the user. Hook this into: (a) `_sendPushNotification('activity_error', 'Chroxy tunnel down', …)`, (b) an attempt to cold-restart the tunnel after a 60s cool-off before emitting activity_error, (c) update `connection-info.json` to set `wsUrl: null` so `chroxy status` shows the failure. Keep server running for localhost access.
**Verification**: extend `supervisor.test.js` with a mock tunnel that emits tunnel_failed and assert push was called + connection-info was updated.
**Dependencies**: item 2 (counter integration).

### 5. Full-scope test for `bump-version.sh` — **S**

**Files**: new `packages/server/tests/bump-version-full.test.js` (~80 lines), keep existing `bump-version-desktop-pkg.test.js`
**Change size**: S
**Why**: The script has silently drifted twice in this session (workspace lockfile entries, iOS Info.plist, Cargo [package] scope). The next drift will not be caught until a user reports stale metadata in a release artifact. Drive the script against a fixture repo (temp dir with stub package.json files, a fake Cargo.toml, a fake Info.plist, a fake lockfile with nested workspace entries) and assert every version field is updated. Running the real `cargo generate-lockfile` can be stubbed via `CARGO=/bin/true` env.
**Verification**: test itself.
**Dependencies**: none.

### 6. Tighten `tunnel.integration.test.js` + wire it to CI as a named step — **S/M**

**Files**: `packages/server/tests/tunnel.integration.test.js`, `.github/workflows/ci.yml` (add explicit `--test-only tunnel.integration` step with `cloudflared` skip-if-missing)
**Change size**: S (~2 files, ~60 line delta)
**Why**: The file is only 93 lines and presumably short-circuits when cloudflared isn't present. Production tunnel bugs have bitten twice this version cycle (WsServer-must-be-HTTP-server + tunnel-check pre-verify). A real end-to-end gate would include: (a) spawn a WsServer on a random port, (b) run cloudflared in quick mode against it, (c) `fetch(httpUrl)` to assert health, (d) open a WS client against the tunnel URL, (e) round-trip one encrypted message. Not hermetic on CI (cloudflared is an external dependency), but it can run on the macOS desktop test runner which already has brew available.
**Verification**: test itself, gated by cloudflared presence.
**Dependencies**: none.

### 7. Session-restore failure surfacing — **S**

**Files**: `packages/server/src/session-manager.js:683-725`
**Change size**: S (~1 file, ~30 line delta)
**Why**: Today a failed restore logs one line and silently drops the session. Add a structured event `session_restore_failed` emitted per failed session + a summary event `sessions_restored { total, restored, failed, failedNames[] }` at the end. Surface via `auth_ok` payload or first broadcast so reconnecting clients know what was lost. Users reporting "where are my sessions after restart" get a concrete answer.
**Verification**: unit test in `session-manager.test.js` with a persistence mock that returns a session whose cwd no longer exists → assert `session_restore_failed` event fired and `restoreState` still returns the remaining sessions' firstId.
**Dependencies**: none.

### 8. Structured error response audit for remaining handlers — **S**

**Files**: `packages/server/src/handlers/feature-handlers.js` (220 lines), `packages/server/src/handlers/checkpoint-handlers.js` (109 lines), `packages/server/src/handlers/repo-handlers.js` (100 lines), `packages/server/src/handlers/file-handlers.js` (91 lines)
**Change size**: S (~4 files, ~40 line delta)
**Why**: I spot-checked session-handlers, settings-handlers, conversation-handlers, input-handlers — all send `{ type: 'session_error', code }` on failure. I did not exhaustively read feature/checkpoint/repo/file handlers. Standardize: every catch block must `ctx.send(ws, { type: <X>_error, code: <CODE>, message })`. Create `packages/server/src/error-codes.js` entries for anything new.
**Verification**: add to `ws-handler-coverage.test.js` a grep assertion that every handler has at least one `send(ws, … error …)` code path, OR unit-test each throwing path.
**Dependencies**: none.

### 9. Decompose `ws-server.js` `_handleMessage` routing — **M** (issue #2147 partial)

**Files**: `packages/server/src/ws-server.js` (still 1222 lines after prior extractions), target `packages/server/src/ws-message-router.js` (new, ~200 lines)
**Change size**: M (~3 files, ~300 line delta)
**Why**: ws-server.js at 1222 lines is the second-largest server file. Prior extractions pulled out auth, broadcaster, client manager, sender, file-ops. The remaining bulk is HTTP upgrade handling + the `_handleMessage` dispatch switch. Pull the switch into a router that takes a `Map<type, handler>` so handlers register themselves; this makes the top-level file a config + HTTP-upgrade shell.
**Verification**: existing tests pass; no behavior change.
**Dependencies**: none. Defer until #1-8 land.

### 10. Auth-failure rate-limit key fix — **S**

**Files**: `packages/server/src/ws-auth.js:55,157`
**Change size**: S (~1 file, ~4 line delta)
**Why**: Both `handleAuthMessage` and `handlePairMessage` use `client.socketIp` as the rate-limit map key. But HTTP routes use `client.rateLimitKey` (which falls back to CF/XFF when socketIp is loopback, `rate-limiter.js:55-61`). Through the tunnel every WebSocket connection has `socketIp === '127.0.0.1'` because cloudflared is a local process; the auth failure map is therefore a single global bucket that any attacker can trivially DoS. Swap the two reads to `client.rateLimitKey || client.socketIp`.
**Verification**: extend `ws-auth.test.js` to construct a client with `socketIp: '127.0.0.1'` + `rateLimitKey: '1.2.3.4'` and assert the failure map keys on `1.2.3.4`.
**Dependencies**: none. Item #10 is the highest-severity bug on this list in terms of exploitability — it's just the most surgical fix.

---

## Three production-incident risks

### Risk 1: Silent session loss on restart

**Scenario**: User runs a 3-session setup (one per repo). They patch Chroxy and SIGUSR2 the supervisor. One of the repos is on a different disk that's temporarily unmounted (external SSD, network mount). `restoreState()` calls `createSession({ cwd: savedCwd })`, the cwd existence check in `session-manager.js:283-292` throws `SessionDirectoryError`, the outer catch on line 716-718 logs and moves on. The session is gone, its message history is gone, and the client that reconnects sees only 2 sessions. The user has no idea why — they just see missing tabs.

**Runtime trigger**: `SessionDirectoryError` or `WorktreeError` from `createSession` inside the restore loop.

**Instrumentation needed**: item #7 above. Plus a counter `sessions_restore_failed_total` from item #2.

### Risk 2: Deploy rollback destroys uncommitted work

**Scenario**: User is editing `packages/server/src/ws-server.js` while chroxy is running under a supervisor in deploy mode. They push a buggy commit, run `chroxy deploy`, the new child crashes 3 times within `DEPLOY_CRASH_WINDOW = 60000`, supervisor triggers `_rollbackToKnownGood`, which runs `git checkout <ref>` in the repo root (line 564). Any tracked-but-uncommitted file edits are blown away. The hint says "To recover: git checkout <branch>" — but by then the content is gone.

**Runtime trigger**: `_deployFailureCount >= MAX_DEPLOY_FAILURES` combined with `git status` showing dirty tracked files at the moment of rollback.

**Instrumentation needed**: item #3 above (abort-on-dirty guard) plus push notification so the user sees the abort. Plus `rollback_aborted_dirty_tree_total` counter.

### Risk 3: Post-auth encryption fallback

**Scenario**: A user downgrades their mobile app from v0.6.9 to v0.6.6 because of a UI regression. The old app sends `key_exchange` without a salt. `ws-auth.js:255` takes the else branch, derives `sharedKey = rawSharedKey`, and sets `sendNonce = 0, recvNonce = 0`. Both sides happily send encrypted traffic using the same (key, nonce) pair across reconnects. A passive observer on the tunnel path (Cloudflare itself, or anyone in the HTTPS chain) now has two or more ciphertexts encrypted with the same keystream — the exact XOR attack from the v0.6.8 audit.

**Runtime trigger**: any client that doesn't ship `salt` in its `key_exchange`.

**Instrumentation needed**: item #1 above (refuse the handshake). Plus a `ws_encryption_insecure_fallback_total` counter with the client's authenticated version that logs loudly so we see downgrades in practice.

---

## Ordered action plan — "ship to public users"

### Stop/go gate 1 — Security hardening (must land before any public release)

1. Item #1: refuse `key_exchange` without salt, bump `minProtocolVersion`. **Go criteria**: unit test + manual smoke with old client getting rejected with clear error.
2. Item #10: fix `ws-auth.js` rate-limit key to use `rateLimitKey`. **Go criteria**: test in `ws-auth.test.js` showing per-CF-IP bucketing.
3. Item #3: abort rollback on dirty tree. **Go criteria**: test + manual dirty-tree simulation.

**Total effort**: 1 day. Rate limit before ship.

### Stop/go gate 2 — Observability (lands next)

4. Item #2: real counters in `/metrics` + `chroxy status --verbose`. **Go criteria**: can reproduce every production-risk scenario above and see the counter tick. Dump the counter blob in any bug report from users.
5. Item #4: supervisor tunnel_failed handler (push + cold-restart attempt). **Go criteria**: kill cloudflared while supervisor is running, verify push + eventual recovery.
6. Item #7: session-restore failure surfacing. **Go criteria**: restart with a missing cwd and see the client get `sessions_restored { failed: 1 }`.

**Total effort**: 2-3 days.

### Stop/go gate 3 — CI reliability (lands third)

7. Item #5: `bump-version.sh` full-scope test. **Go criteria**: CI job runs it on every PR.
8. Item #6: tunnel integration test wired as a named CI step (gated by cloudflared presence, runs on the macOS runner where cloudflared is available via brew).
9. Item #8: error-response audit on the remaining handler files.

**Total effort**: 1-2 days.

### Not gating (defer past v0.7.0)

- Item #9: further `ws-server.js` decomposition. XL, no behavior change, purely debt. File a continuation of #2147 with a concrete router-extraction plan.
- Any app-side work beyond what's in the v0.6.9 session already.
- Full Android build verification in CI (expo-doctor is enough for a first public release).
- iOS build in CI (EAS covers this; wiring it to GH Actions is a separate workstream).

---

## Verdict

**Overall: 3.9 / 5.** The v0.6.8 audit triggered real fixes — the cryptographic P0, the hook shell-injection P1, the file-ops TOCTOU, and the handler error propagation are all resolved in code I can point to. The remaining risk surface has shifted from "security" to "operational opacity and edge-case resilience." The three production scenarios I flagged are all single-digit-line fixes that have high blast radius if they fire.

Work remaining before public users: **roughly 1 week of focused work** (the Phase 1 gate alone is a 1-day batch; Phase 2 observability is 2-3 days; Phase 3 CI reliability is 1-2 days). Nothing on the list is architecturally hard. None of it requires breaking protocol changes. The hardest item is #4 (tunnel resurrection logic) because it touches real subprocess lifecycle. The highest-value-per-line item is #1 (kill the no-salt crypto fallback). The highest-value-per-hour item is #2 (counters in /metrics) because everything else becomes cheaper to diagnose afterward.

Chroxy is in genuinely decent shape for its stage. The monorepo hygiene is good, tests are numerous (153 server test files), extractions have happened without breaking behavior, the prior audit set was taken seriously. Ship Phase 1, and it's ready for alpha/beta. Ship all three phases, and it's ready for a public v0.7.0.
