# Skeptic's Audit: Chroxy v0.6.9 Production Readiness

**Agent**: Skeptic — cynical systems engineer, cross-references every claim against actual code
**Overall Rating**: 2.6 / 5
**Date**: 2026-04-11

---

## TL;DR

The feature set is impressive and the architecture shows the scars of a lot of honest iteration. But the moment you stop reading docs and start reading code, the gap between what the project *claims* and what is actually enforced is wide enough to block a public launch. The biggest item: **encryption is negotiated but not enforced**. The handshake is clean; the post-handshake check that would reject plaintext does not exist on either side. That single bug invalidates the "end-to-end encryption" claim in a way that is non-obvious in logs and completely invisible in CI. There are also material gaps in tunnel recovery, supervisor rollback safety, and the SDK permission `allowAlways` path, all of which look correct on a skim.

---

## Section-by-Section Ratings

### 1. WebSocket protocol + auth + encryption (server-side) — **2 / 5**

- Message plumbing, schema validation, correlation IDs, protocol-version negotiation, pre-auth connection caps, rate limiting, drain mode, `server_error` vs `error` vs `session_error` taxonomy are all well-factored. `ws-auth.js` is a clean extraction.
- **Encryption is advisory, not enforced.** `ws-server.js:800-814` decrypts envelopes iff `msg.type === 'encrypted' && client?.encryptionState`. There is **no** branch that rejects a plaintext frame after key exchange has completed. `auth_ok` advertises `encryption: 'required'`, the server sets `encryptionPending=true`, `handleKeyExchange` correctly rejects non-`key_exchange` messages while pending (`ws-auth.js:273-281`), and `postAuthQueue` correctly buffers outbound traffic during the handshake (`ws-client-sender.js:30`). But once `encryptionState` is populated, the server happily processes a plaintext `{type:'input', data:'...'}` sent by a malicious or buggy client, and `_clientSend` still encrypts outbound messages — so a downgraded client receives unreadable ciphertext, but the damage (command injection, credential leak on inbound channel) is done before the client notices.
- Auth has TOCTOU-ish behaviour: `_authFailures` map can hit `MAX_AUTH_FAILURE_ENTRIES=10_000` and evict "oldest" by `Map` insertion order (`ws-auth.js:19-23`), which is not the oldest-by-firstFailure. A patient attacker can cycle IPs to displace a legitimate user's failure record and reset their backoff.
- Auth timeout is a hard 10s (`ws-server.js:782`) — no per-IP hold. A client that authenticates, gets kicked to key-exchange pending, and then sends bytes slower than `keyExchangeTimeoutMs=10_000` is closed, but no penalty is applied. Minor.
- `_validateHookAuth` falls back to the primary API token when no hook secrets are registered (`ws-server.js:674-681`). Under the default SDK provider, no `CliSession` exists → no `_hookSecret` is registered → any local process holding the API token can POST `/permission`. This is documented as a legacy fallback but is a latent sharp edge in SDK mode.

### 2. Session lifecycle (server) + reconnect/replay (client) — **3 / 5**

- The `ConnectionPhase` state machine on the client is the nicest thing in this codebase. `VALID_TRANSITIONS` (`connection-lifecycle.ts:25-31`) is explicit, illegal transitions are logged, the attempt-ID invalidation pattern (`connectionAttemptId`) defends against racing retry chains, and `isReconnect = lastConnectedUrl === url` correctly distinguishes cold start from warm reconnect.
- There are still deadlock-adjacent combinations. `disconnected` legally transitions ONLY to `connecting` (`connection-lifecycle.ts:26`), but `server_restarting` arrives as an inbound path. If a `server_restarting` health response fires while the store is in `disconnected` (e.g. the app was foregrounded after a long idle and a stale request resolves), the phase set succeeds via the "log warning but still apply" fallback (line 107-113). It is a warning in production and a silent illegal-state everywhere else.
- Reconnect budget is reset on every `socket.onclose` with `wasConnected=true` by calling `get().connect(url, token)` with `_retryCount=undefined` (`connection.ts:653`). That's documented and intentional, but combined with `MAX_RETRIES=5` and `RETRY_DELAYS=[1,2,3,5,8]s` it gives you up to ~19 seconds of phone-pounded tunnel traffic on every transient blip. Fine for one device; on a cheap quick tunnel with multiple phones, it stacks.
- `onerror` schedules a reconnect regardless of `wasConnected` (`connection.ts:676-686`). Combined with the ongoing health-check retry chain, there is real potential for double-scheduling — the `connectionAttemptId` bump on every fresh `connect()` is the only thing preventing a duplicate chain. It holds today; one "I'll skip the bump because it's a retry" regression and the reconnect storm is back.
- Server persistence debounce is 2s (`session-state-persistence.js` + `session-manager.js:836`). In-flight permission requests and `_pendingPermissions` are NOT persisted, so a child crash between user action and debounce fire loses the last ≤2s of session state. Active permission requests are auto-denied on reconnect (by design), which means the phone shows "expired" for work that was mid-air.

### 3. Crypto (nacl, nonces, key derivation, replay protection) — **3.5 / 5**

- `packages/store-core/src/crypto.ts` is clean. `nonceFromCounter` uses direction byte + 8-byte LE counter (lines 85-100), `MAX_NONCE_COUNTER = 2^48` as the exhaustion gate, `deriveConnectionKey` uses SHA-512(sharedKey ∥ salt) and takes the first 32 bytes (lines 187-210). The replay-protection contract is explicitly documented at lines 120-143 and enforced at line 151 (`envelope.n !== expectedNonce` throws). The per-connection salt fix (`1fa8eda5e` per memory) is present in both sides: `handleKeyExchange` (`ws-auth.js:255-258`) and the client `key_exchange_ok` handler (`message-handler.ts:796-802`) both use `deriveConnectionKey` when a salt is present and fall back to the raw DH key otherwise.
- The **downside** of the "old client falls back to raw DH" path is that a server talking to an old client still uses the raw DH shared key with `sendNonce=0` on every reconnect — which is exactly the nonce-reuse condition the per-connection salt fix was introduced to prevent. There is no server-side enforcement of "salt required from clients claiming protocol version ≥ N". Backward compat is nice, but the fix is only a fix for new clients. Consider advertising `encryption: 'salt-required'` and refusing connections from un-salted clients once the app is at a known minimum version.
- `_handshakeCtx` sets `client.encryptionState = { sharedKey: encryptionKey, sendNonce: 0, recvNonce: 0 }` but never stores the raw DH `sharedKey` anywhere. Good — it's not retained beyond the derivation. But the client-side `_ctx.encryptionState` lives in module-level state (`message-handler.ts:152`) and is never zeroed on disconnect — a reconnect overwrites it, but if the process is paused (app backgrounded on iOS) the key sits in memory until the next connect.
- `initPRNG` (crypto.ts:36-51) correctly hard-fails when the platform PRNG returns the wrong length. I'm not worried about the PRNG itself.

### 4. Tunnel reliability (Cloudflare quick + named) — **1.5 / 5**

This is the worst section, and the project's "supervisor auto-restart" claim is most vulnerable here.

- `waitForTunnel` in `tunnel-check.js` checks `res.ok` only — no body validation (line 21). A Cloudflare error-page interstitial at 200, a reverse proxy returning its default welcome page, or **any** 200 response will pass. The server publishes `{"status":"ok"}` at `/` (`http-routes.js:78`) and the check could trivially verify that, but doesn't. The result is that the QR code is shown to the user before the tunnel is meaningfully routable to the right process.
- After `tunnel_failed` fires, the system does **nothing**. `tunnel/base.js:95-159` runs exactly 3 recovery attempts (3s, 6s, 12s), emits `tunnel_failed`, and never restarts the tunnel again. `server-cli.js:55-60` logs the error and broadcasts to clients. `supervisor.js:215-217` logs the error. Neither restarts the tunnel, neither exits the process. **The server sits there unreachable forever** until the user notices and SIGTERMs. This directly contradicts "supervisor restarts on crash" in the README — the supervisor restarts the CHILD, not the tunnel, and cloudflared failure is the mode you actually see in the field.
- Named-tunnel URL detection uses a regex against cloudflared's log output: `/[Rr]egistered.*connection|[Cc]onnection.*registered|Serving tunnel/i` (`cloudflare.js:100`). That is exactly the kind of capability-detection-via-string-matching that breaks silently on a cloudflared upgrade. If cloudflared changes its wording, `resolved=false` stays forever, the 30s timeout fires (line 134), and you get "Tunnel timed out after 30s" — even when cloudflared successfully brought the tunnel up.
- `_handleUnexpectedExit` runs `recoveryBackoffs = [3000, 6000, 12000]` (`base.js:26`) — these are wall-clock constants that have never been revisited since first commit. On a named tunnel with a real outage, a human operator would want the tunnel re-attempted indefinitely with jittered backoff, not 3 strikes and permanent failure.
- `Supervisor._rollbackToKnownGood` (`supervisor.js:539-576`) runs `git checkout <ref>` in a detached-HEAD on the current repo's working directory. If the user's install layout is `npx chroxy` (cached in `~/.npm/_npx/...`), `git rev-parse --show-toplevel` succeeds against whatever git repo happens to be the parent, or worse, fails ambiguously. If the user cloned the source repo and has uncommitted edits, this silently clobbers them. The "recovery hint" logs a command, but by then git has already run.

### 5. Push notifications (after #2804) — **4 / 5**

- The duplicate `idle` + `activity_update` push was caught and fixed. The `RATE_LIMITS` map (`push.js:83-90`) explicitly excludes `idle` with a comment pointing at the audit. The `noActiveViewers` gate in `server-cli.js:230-242` is the real dedupe, and that's documented.
- `pushManager` is referenced inside the `session_event` handler at `server-cli.js:186-260` but the `const pushManager` binding is at line 285. Today's event ordering happens to avoid the TDZ crash because `sessionManager.createSession` (called at line 180) emits `session_created` before the `session_event` handler is attached — but this is latent. One reordering and you get `ReferenceError: Cannot access 'pushManager' before initialization` on startup.
- `registerToken` accepts any non-empty string and passes it to the Expo Push API (line 147-158). The comment says "FCM tokens work with the Expo Push API too" — that is true, but it also means the server has no ability to distinguish "this is an Expo Push token" from "this is garbage my attacker registered to exhaust my Expo rate limit". Rate-limiting `register_push_token` happens through the generic message rate limiter only.
- `sendLiveActivityUpdate` (line 241-262) writes `{ state, detail, category }` into `data` but NOT `title: 'Live Activity'` / `body: detail` — wait, it does. Fine.
- No retry-dead-lettering. If Expo is down for an entire rate-limit window, the message is lost, not queued for next window. Acceptable for a "best-effort" push channel, but the app is the only way users get alerted to a failed permission prompt after they foreground it, so "best effort" is a meaningful downgrade.

### 6. Config precedence + deployment (CLI/ENV/file/defaults, supervisor, updater) — **3 / 5**

- Precedence is correctly implemented in `mergeConfig` (`config.js:177-228`) and tested. The `sanitizeConfig` function (line 67) masks `apiToken` and `pushToken` before logging. Good.
- `validateConfig` warns but does not fail. `port < 1 || > 65535` is a warning. `externalUrl` with a non-http/https protocol is a warning. Unknown keys are warnings. In production, warnings scroll past in startup noise. Strict mode behind a flag should be default.
- `externalUrl` replacement logic in `server-cli.js:411-414` uses two separate regexes that only cover `http(s)://` and `ws(s)://`. `externalUrl: 'chrome-extension://...'` or `'//example.com'` passes validation (line 132 URL parse succeeds on some of these) and produces nonsense downstream. Low likelihood, not zero.
- Token keychain migration (`server-cli.js:83-105`) removes the plaintext token from `config.json` after migration. Good. But if `isKeychainAvailable()` is false (Linux without gnome-keyring), the plaintext token stays in `~/.chroxy/config.json` forever, and the file permissions depend on `writeFileRestricted` being called on every subsequent write. I did not dig into `writeFileRestricted` — if it uses `0600` on the initial write but does NOT re-chmod on overwrite, a umask change between writes could leave the file readable.
- Supervisor rollback (see section 4) is the riskiest part of deployment. Two independent redesign-worthy bugs (working-tree clobber + command-name regex in tunnel detection) interact badly.
- No health endpoint exposes the `_authFailures` map, `_backpressureDrops`, or `_maxPendingConnections` counters. `/metrics` (line 100-126) exposes memory and session counts only — no signal for "my rate limiter is about to reject everyone" or "some clients are stuck in backpressure hell".

### 7. Permission system (hook, shell safety, app-side flow) — **3.5 / 5**

- `permission-hook.js` does **not** shell out — it only reads/writes `settings.json`. The actual hook script (`packages/server/hooks/permission-hook.sh`) is invoked by Claude Code itself. Reading `permission-hook.sh`: JSON body comes via stdin, never as args; `$PORT` is numeric-only (`case $PORT in ''|*[!0-9]*) exit 0 ;;`); `$PERM_MODE` is whitelisted; `$TOKEN` is quoted; `curl -d "$REQUEST"` passes the JSON as POST body, not as shell. **Shell-safe.** Grep-based JSON parsing (lines 60, 93) is fragile, not exploitable.
- **`allowAlways` does not exist as an SDK `behavior` value.** `permission-manager.js:262-263` passes `{ behavior: 'allowAlways', updatedInput: pending.input }` back to the SDK `canUseTool` callback. The Agent SDK expects `{ behavior: 'allow' | 'deny', ... }`. If the SDK does strict validation, this resolves as a rejection silently; if it does `behavior === 'allow'`, it denies. Grepping shows the string flows through `ws-permissions.js:216`, the dashboard, and the mobile app, so "Allow Always" is a user-facing feature — which means it is currently broken in ways that would be easy to verify by tapping the button once. That's a "nobody tested the happy path" smell.
- `_matchesRule` (lines 104-111) silently allows rules for tools not in `ELIGIBLE_TOOLS` if `setRules` was bypassed. It's not exploitable because `setRules` is the only entry point, but a direct `this._sessionRules.push(...)` anywhere in the future would quietly escape the NEVER_AUTO_ALLOW guard.
- Permission requests are stored only in-memory (`_pendingPermissions` Map). A supervisor restart auto-denies them (`clearAllPendingPermissions`). The client is notified via `permission_expired`. That's OK as a design choice, but combined with the "session state persistence debounce 2s" behavior, the blast radius of a crash is a full lost turn plus a user-facing "why did my permission prompt vanish?".
- The app-side `setupNotificationResponseListener` sends permission responses via **raw** `socket.send(JSON.stringify(...))` (`notifications.ts:226-228`), bypassing `wsSend`. This means: (a) the response is **plaintext** even when E2E encryption is active; (b) server-side sequence numbers / encryption wrapping are skipped; (c) any future change to `wsSend` (e.g. adding a client-side ratelimit or signature) doesn't apply to the notification path. The HTTP fallback path at line 137 is correct — that's fine. But the WS path is a latent leak.

### 8. CI coverage + testability — **2.5 / 5**

- `.github/workflows/ci.yml` runs: server tests + lint + lockfile check, dashboard tests + token-generation drift + typecheck, store-core tests + typecheck, app tests + typecheck + `expo-doctor`, protocol tests, desktop Rust tests. The `app-expo-doctor` job is new and correctly distinguishes tool-crash from real failure (lines 295-313). The filter-the-known-CNG-warning pattern is a ticking time bomb but at least documented.
- **What is NOT tested:**
  - No end-to-end smoke test that starts a real server, opens a WebSocket, completes auth + key exchange, sends a message, and receives a stream. `test-client.js` exists but is not wired into CI.
  - No test that the server rejects **plaintext post-handshake** messages — because it doesn't reject them. A test that actually asserted the "encryption required" contract would fail today.
  - No test that `allowAlways` actually reaches the SDK as a legal behavior.
  - No test that `tunnel_failed` triggers **any** recovery action (because it doesn't).
  - No integration test on the `Supervisor._rollbackToKnownGood` path. Running `git checkout` in a test is scary, but a shell-stubbed version is trivial.
  - No Tauri `.app` bundling test — the exact failure mode the memory notes flagged (bundle caching) would not be caught.
  - `desktop-tests` runs `cargo test --locked` with stub `mkdir -p server-bundle ../dist` (line 365). That is the bare minimum required to satisfy `build.rs`. Actual dashboard bundling is not exercised in CI.
  - No iOS native build, no Android native build.
- The `store-core` tests test the crypto library in isolation, which is good. But the **integration** of crypto + WS is not tested end-to-end. A test that asserted "a `ws-server.js` that receives a plaintext frame after handshake closes the connection" would have caught the downgrade bug.

---

## Top 5 "Almost-Right" Findings

1. **Encryption required but not enforced.** `ws-server.js:800` gate is `msg.type === 'encrypted' && client?.encryptionState`. After a successful key exchange, plaintext frames fall through to `_handleMessage` and are processed. Same pattern on the client side (`connection.ts:601-617`). The project advertises "E2E encryption" and the crypto is clean, but the transport-level enforcement is absent. FILE:LINE — `packages/server/src/ws-server.js:800`, `packages/app/src/store/connection.ts:601`.

2. **Tunnel health check accepts any 200.** `waitForTunnel` in `tunnel-check.js:21` gates on `res.ok` alone, never validating the body is from the Chroxy server. A cloudflared misroute, a reverse proxy default page, or a squatted hostname responding 200 passes the check and the user sees a QR code for something that will not connect. FILE:LINE — `packages/server/src/tunnel-check.js:20-24`.

3. **`pushManager` TDZ window.** The `session_event` handler closure at `server-cli.js:186` captures `pushManager`, but `pushManager` is defined at line 285. Today's event ordering is safe because `sessionManager.createSession` happens at line 180 (before the listener is registered), but a reordering or a future synchronous event emitted by `SessionManager`'s constructor would produce `ReferenceError` at startup. FILE:LINE — `packages/server/src/server-cli.js:195` (reference) vs `server-cli.js:285` (definition).

4. **Auth-failure map eviction evicts by insertion order, not by age.** `evictOldestIfFull` in `ws-auth.js:18-23` uses `map.keys().next().value` — the first inserted key. Under `MAX_AUTH_FAILURE_ENTRIES=10_000`, an attacker holding open connections from rotating IPs can repeatedly displace a legitimate blocked IP's failure record, effectively resetting its backoff. FILE:LINE — `packages/server/src/ws-auth.js:18-23`.

5. **Notification-path permission response sent as plaintext.** `notifications.ts:226-228` uses `socket.send(JSON.stringify(...))` directly instead of `wsSend`. When E2E encryption is active, this is the only message type that leaks over the wire plaintext, and it leaks the `requestId` + decision — enough for a downstream observer to reconstruct which permission prompt the user just answered. FILE:LINE — `packages/app/src/notifications.ts:226`.

---

## Top 5 "Actually Wrong" Findings

1. **Tunnel never restarts after `tunnel_failed`.** `tunnel/base.js:149-158` emits `tunnel_failed` after 3 recovery attempts and returns. `server-cli.js:55-60` and `supervisor.js:215-217` both log and do nothing. The server sits in the process table, port bound, unreachable to the user, until manual intervention. This is a direct contradiction of the "supervisor auto-restart" claim. FILE:LINE — `packages/server/src/supervisor.js:215-217`.

2. **`allowAlways` is not a valid SDK `behavior`.** `permission-manager.js:262-263` passes `behavior: 'allowAlways'` directly to the Agent SDK `canUseTool` callback. The SDK accepts `'allow'` or `'deny'`. The "Allow Always" button (visible in `packages/app/src/components/PermissionDetail.tsx`) therefore resolves incorrectly — either silently denies or errors in the SDK. FILE:LINE — `packages/server/src/permission-manager.js:263`.

3. **Named-tunnel URL detection parses cloudflared log strings.** `cloudflare.js:100` keys off `[Rr]egistered.*connection|[Cc]onnection.*registered|Serving tunnel`. Upstream cloudflared log format changes would silently break this, producing a false 30s timeout on a correctly-running tunnel. A cloudflared update would surface as "tunnel timed out, try again" with zero diagnostic value. FILE:LINE — `packages/server/src/tunnel/cloudflare.js:100`.

4. **Supervisor rollback runs `git checkout` in the user's working tree.** `supervisor.js:562-564` resolves the repo via `git rev-parse --show-toplevel` from `__dirname`, then runs `git checkout <ref>`. If Chroxy is installed via `npx` from a cache directory, the resolved repo is whichever git dir happens to be the ancestor. If installed from a source clone with uncommitted edits, those edits are silently clobbered. "Use git reflog" is not acceptable recovery guidance for a daemon-triggered rollback. FILE:LINE — `packages/server/src/supervisor.js:552-564`.

5. **`handleKeyExchange` returns silently when the client omits `salt`.** `ws-auth.js:255-258` falls back to the raw DH shared key when `msg.salt` is absent. This was added as backward compat for old clients, but there is no server-side gate that enforces "salt required from clients with `protocolVersion >= N`". The effect: an attacker-controlled or downgraded client can opt out of the per-connection key derivation, reintroducing the nonce-reuse condition the fix was meant to prevent. The server has no way to know it happened. FILE:LINE — `packages/server/src/ws-auth.js:255-258`.

---

## Three Production Readiness Blockers

1. **Enforce encryption post-handshake.** Add a server-side check: if `client.encryptionState` is non-null and an inbound frame is not `{type:'encrypted'}`, close the connection with code 1008. Mirror the check on the client so a downgraded server produces a disconnect rather than a stream of errors. Until this lands, the "end-to-end encryption" claim is marketing, not engineering.

2. **Tunnel recovery must restart the tunnel, or the server must exit.** Either the supervisor owns tunnel lifetime and restarts it after `tunnel_failed` with indefinite jittered backoff (up to N per hour), or `tunnel_failed` triggers a supervisor shutdown so systemd/launchd/the user notices. The current "log and do nothing" path is worse than a crash because it masks unreachability with process uptime. Pair this with a structured health check of the tunnel — ping `/` through the tunnel URL, parse the body, assert `{status:'ok'}` — so a tunnel that appears up but isn't actually routing is distinguishable from a healthy one.

3. **Fix `allowAlways` and remove any SDK-breaking branches from the critical path.** "Allow Always" is a feature shipped in the UI. If it doesn't work, users will tap it, hit silent denial or a crash, and blame Chroxy. Replace `{behavior:'allowAlways', ...}` with `{behavior:'allow', ...}` (and track the persistent allow as a session rule via `setRules`), and write an integration test that exercises each button. Add a corresponding CI test that asserts every permission decision path reaches the SDK with a legal `behavior`.

Honorable mention: the `pushManager` TDZ window and the auth-failure map eviction are smaller, but both are "one reorder away from a startup crash" or "cheap to exploit" respectively. Before shipping to public users, add a unit test that constructs `SessionManager` + emits `session_event` synchronously during construction (to pin the TDZ-safe ordering), and swap `evictOldestIfFull` to evict by `firstFailure` timestamp.

---

## Overall Verdict

The product is further along than the code deserves — which is both a compliment to the UX work and an indictment of the below-the-waterline engineering. The protocol surface is broad, the recent extraction work (ws-auth, ws-history, ws-broadcaster, SessionStatePersistence, PermissionManager) is genuinely good, and the reconnect state machine is better than most RN apps ship. But the five "actually wrong" findings above are not edge cases — they are on the happy path, and the fact that they survived to v0.6.9 strongly suggests nobody tested cloudflared restart, nobody tapped "Allow Always", and nobody ran a plaintext frame against a "required-encryption" server. CI covers unit tests well but has no smoke test that would have caught any of this. The "close to production ready" phrasing is optimistic by about two weeks of focused hardening work, assuming no new surprises fall out of the first real multi-user deployment. **Do not ship to public users at v0.6.9. Fix the three blockers, add a smoke-test CI job that exercises the encryption-required happy path end-to-end, and re-audit.**
