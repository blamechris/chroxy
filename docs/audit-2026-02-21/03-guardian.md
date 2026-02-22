# Guardian's Audit: Chroxy Security & Reliability Assessment

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-21

---

## Verification of Previous Findings (Feb 19)

Three security issues were flagged in the prior audit. All three are confirmed fixed:

| Finding | Status | Evidence |
|---------|--------|----------|
| Symlink path traversal in file browser | **FIXED** | PR #710. `ws-server.js` now calls `realpathSync()` before `startsWith()` check, resolving symlinks before path validation. |
| Missing Zod validation on WS messages | **FIXED** | PR #712. `ws-schemas.js` defines 20+ Zod schemas. `_handleMessage()` validates all incoming messages before processing. |
| EventNormalizer missing for session events | **FIXED** | PR #714. `event-normalizer.js` normalizes SDK/CLI session events into consistent WS protocol messages. |

---

## New Attack Surface Analysis

### Diff Viewer (`get_diff` handler)

`ws-server.js:1149` and `ws-schemas.js:159`:

```javascript
export const GetDiffSchema = z.object({
  type: z.literal('get_diff'),
})
```

**Finding: No `base` field validation.** The schema accepts any `get_diff` message but the handler at line 1151 passes `msg.base` directly to `_getDiff()`. While `_getDiff` (line 1946) uses git internally (which constrains what `base` can be), an attacker could pass arbitrary ref names. The `base` parameter should be added to `GetDiffSchema` with string validation and a reasonable pattern constraint.

**Severity: LOW** -- git will reject invalid refs, but defense-in-depth says validate at the schema layer.

### Untracked File Previews

Issue #716 flags binary file detection for untracked file previews. The current implementation reads file contents without checking if the file is binary. This is a **data exposure** risk if the preview inadvertently sends binary blobs (including compiled files that might embed secrets).

**Severity: LOW** -- requires authenticated access and the data is from the user's own repo.

### Slash Commands / Message Injection

Messages arrive via `sendMessage` on sessions. The SDK session (`sdk-session.js`) passes messages directly to the Claude Code SDK, which handles its own input sanitization. No additional sanitization is needed at the Chroxy layer -- the SDK is the trust boundary.

**Status: Clean.**

---

## Race Condition Analysis

Five areas checked for concurrency issues:

### 1. Encryption Nonce Counter
`ws-server.js:430,2653` -- `sendNonce` and `recvNonce` are incremented after each operation. JavaScript is single-threaded (no data races), but if `_send()` throws after encrypt but before nonce increment, the nonce desyncs.

**Risk: MEDIUM.** If `ws.send()` throws, `sendNonce++` at line 2653 still executes (it is after `encrypt()` but before the actual send completes). However, the WebSocket `send()` is fire-and-forget in Node.js -- it buffers internally. The real risk is if the client receives a corrupted message and increments `recvNonce` while the server does not. This is theoretical but worth a defensive check.

### 2. Session CWD Cache
`session-manager.js` caches the CWD of each session. If Claude Code changes the working directory (via `cd`), the cached CWD becomes stale. This affects `create_session` with a relative CWD path and diff operations.

**Risk: LOW.** CWD is set at session creation and rarely changes. But there is no TTL or refresh mechanism.

### 3. Concurrent Permission Responses
If two clients are connected and both respond to the same permission prompt, both responses arrive at the session. The session processes the first one; the second is silently dropped or causes an error.

**Risk: LOW.** Multi-client is a niche scenario. But there is no dedup logic for permission responses.

### 4. Session List Broadcast During Creation
`ws-server.js:994-1001` -- `createSession` is called, then the session list is broadcast. If another client sends `create_session` simultaneously, the broadcast might send a stale list. Node.js single-threading makes this safe in practice.

**Risk: NONE.** Event loop serialization prevents this.

### 5. Tunnel Crash During Message Send
If cloudflared crashes while a message is in flight, the WebSocket closes abruptly. The supervisor restarts the server, but any in-flight messages are lost.

**Risk: LOW.** The reconnection infrastructure replays history on reconnect. Only the single in-flight message is lost.

---

## Data Integrity

### Atomic Persistence
Session state is persisted to JSON files via `withSettingsLock` (promise-chain serialization). This prevents concurrent writes from corrupting the file. Verified in `session-manager.js`.

### Ring Buffer (Terminal)
`terminalRawBuffer` has a 100KB ceiling (`connection.ts`). Data beyond the ceiling is silently dropped (oldest data evicted). This is a design choice, not a bug -- but users should know terminal history is bounded.

---

## Failure Recovery Assessment

| Scenario | Recovery | Quality |
|----------|----------|---------|
| cloudflared crash | Supervisor detects exit, restarts child, tunnel auto-recovers | Good |
| Server crash (named tunnel) | Supervisor restarts within 2-10s backoff | Good |
| Server crash (quick tunnel) | New tunnel URL, requires re-scan QR | Acceptable |
| Phone disconnect (network) | Auto-reconnect with 6-attempt retry, history replay | Good |
| Phone disconnect (user) | `lastConnectedUrl` cleared, no auto-reconnect | By design |
| Claude Code crash | Session emits error, user can restart via new message | Acceptable |
| Node.js OOM | Process exits, supervisor restarts (if named tunnel) | Acceptable |

---

## Test Coverage Assessment

| Component | Test File | Tests | Coverage Quality |
|-----------|-----------|-------|-----------------|
| ws-server.js (2,691 LOC) | ws-server.test.js | Yes (102 setTimeout calls) | **Moderate** -- many handlers tested but mock `sendMessage` is a no-op |
| sdk-session.js | sdk-session.test.js | Yes | Good |
| cli-session.js | cli-session.test.js | Yes | Good |
| crypto (encryption) | crypto.test.js | Yes | Good |
| push.js | None | **Zero** | **Critical gap** |
| session-manager.js | session-manager.test.js | Yes | Good |
| event-normalizer.js | event-normalizer.test.js | Yes | Good |
| output-parser.js | output-parser.test.js | Yes | Good |
| App connection store | connection.test.js + connection-connect.test.js | 243 total | Moderate (utility-heavy, no component tests) |

---

## Additional Security Findings

### 1. Health Endpoint Hostname Leak
`ws-server.js:315`:
```javascript
res.end(JSON.stringify({ status: 'ok', mode: this.serverMode, hostname: hostname(), version: SERVER_VERSION }))
```
The health endpoint is **unauthenticated** and exposes the machine's hostname and server version. This is information disclosure -- an attacker scanning tunnel URLs can fingerprint the server.

**Recommendation:** Remove `hostname` from the health response. Keep `status` and `mode` (the app needs them). Version can stay if desired but hostname should not be exposed.

### 2. Unauthenticated ECDH Key Exchange
The ECDH key exchange happens before authentication. An attacker can complete the key exchange and establish an encrypted channel, then fail auth. This wastes server resources (ECDH is CPU-intensive) and could be used for DoS.

**Severity: LOW.** The auth rate limiter at `ws-server.js:680` limits failed attempts per IP. The ECDH computation is bounded.

### 3. Nonce Overflow (Theoretical)
Nonces are JavaScript numbers (`ws-server.js:745`: `sendNonce: 0, recvNonce: 0`). JavaScript integers are safe up to `2^53 - 1`. At 1000 messages/second, overflow would take ~285 million years. Not a practical concern, but worth documenting.

### 4. Send Error Nonce Desync
If `ws.send()` at `ws-server.js:2652-2653` fails (e.g., WebSocket is closing), the nonce is still incremented. The client will then be unable to decrypt subsequent messages because its expected nonce is behind.

**Recommendation:** Wrap the send in a try/catch and do not increment `sendNonce` on failure. Or close the connection on send failure (since recovery is impossible with desynchronized nonces).

---

## Top 5 Recommendations

1. **Add `base` field to `GetDiffSchema`** (`ws-schemas.js:159`) -- validate it as an optional string with a git ref pattern. Defense-in-depth.

2. **Remove `hostname()` from health endpoint** (`ws-server.js:315`) -- unnecessary information disclosure on an unauthenticated endpoint.

3. **Handle nonce increment on send failure** (`ws-server.js:2652-2653`) -- either skip the increment or close the connection. Desynchronized nonces are unrecoverable.

4. **Add CWD cache TTL or refresh** -- stale CWD in session-manager.js could cause `create_session` or diff operations to use wrong paths.

5. **Test concurrent permission responses** -- verify that two simultaneous `permission_response` messages do not corrupt session state. Even if multi-client is rare, it is an authenticated attack surface.
