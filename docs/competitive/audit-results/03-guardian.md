# Guardian's Audit: Happy vs Chroxy Architecture

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages
**Overall Rating**: 3.8 / 5
**Date**: 2026-02-19

---

## Section-by-Section Ratings

| # | Section | Rating | Notes |
|---|---------|--------|-------|
| 1 | Topology | 4/5 | Accurately maps trust boundaries, misses some nuance on tunnel trust |
| 2 | Wire Protocol | 4/5 | Good enumeration, but message count errors undermine trust in the analysis |
| 3 | Ordering | 5/5 | Correctly identifies ordering guarantees and their limits |
| 4 | Providers | 4/5 | Provider isolation well-described, registry is a clean extension point |
| 5 | Connectivity | 4/5 | Fair comparison of failure modes, understates tunnel reliability |
| 6 | Events | 4/5 | Event flow accurate, transient event loss correctly flagged |
| 7 | Encryption | 3/5 | "Server decrypts" framing is a non-issue — server IS the user's machine |
| 8 | State | 4/5 | Ring buffer limitations real, persist debounce too long |
| 9 | RPC | 5/5 | Correctly identifies Happy's bash RPC as extremely dangerous |
| 10 | Feature Matrix | 4/5 | Good overview, some factual errors |

---

## Top 5 Findings

### 1. "Server Decrypts" is NOT a Real Vulnerability

**Severity**: Informational (framing correction)

The document presents Chroxy's "server-decrypts" encryption model as a security deficit compared to Happy's "true E2E." This framing is incorrect for Chroxy's threat model.

**Analysis**: In Chroxy's architecture:
- The server runs on the user's own machine
- The server has direct access to the Claude Code process
- The server already has full access to all data being encrypted
- Encrypting data FROM the server TO itself provides zero additional security

The actual trust boundary in Chroxy is between the user's machine and the Cloudflare tunnel. Chroxy's encryption protects this boundary. The server "decrypting" is the server reading its own data — this is expected behavior, not a vulnerability.

**Contrast with Happy**: Happy's relay is a third party. The relay server is NOT the user's machine. True E2E encryption is necessary because the relay operator could read messages otherwise. This is a legitimate security requirement for Happy's architecture, but it doesn't apply to Chroxy.

**Recommendation**: The document should add a "Threat Model" row to the encryption comparison table explaining why the trust boundaries are different.

### 2. Relay Trust Model — Metadata Exposure

**Severity**: Medium (architectural concern for relay adoption)

If Chroxy were to adopt a relay model, the relay server would see:
- Connection timestamps and durations
- Message sizes and frequencies
- IP addresses of both server and client
- Session creation/deletion patterns
- Which provider/model is being used (if not encrypted)

Even with E2E encryption, this metadata is valuable for profiling developer behavior. Signal Protocol faces the same challenge — the Signal servers see who talks to whom and when, even though they can't read message content.

**Recommendation**: If relay mode is ever considered, design it to minimize metadata exposure. Use padding, timing obfuscation, and minimize plaintext headers.

### 3. Happy's Bash RPC is Dangerous

**Severity**: Critical (for Happy, not Chroxy)

The document describes Happy's RPC layer which includes bash command execution. This is the most dangerous feature in either architecture:

- If the relay is compromised, an attacker can execute arbitrary commands on any connected agent
- If a client is compromised, the attacker can execute arbitrary commands through the relay
- The blast radius is every machine running a Happy agent

**Chroxy's approach is safer by design**: All mutations go through Claude Code's audited tool system. The file browser is read-only. There is no RPC endpoint for arbitrary command execution.

**Recommendation**: Do NOT adopt an RPC layer. Chroxy's read-only posture is a security feature, not a limitation.

### 4. Race Conditions Found

**Severity**: Medium to High

#### 4a. Key Exchange Timeout Race

In `packages/server/src/ws-server.js`, the ECDH key exchange has a 5-second timeout. If the client is slow (poor network, heavy load), the exchange silently falls back to plaintext.

```
Client connects → Server sends key_exchange →
  [5 second timeout] →
  Server falls back to plaintext → Client sends encrypted message →
  Server can't decrypt → Connection broken
```

**Impact**: Connection failure with no useful error message. The client thinks encryption is active; the server thinks it's plaintext.

**Fix**: Don't silently fall back. Either extend the timeout to 30 seconds or reject the connection if key exchange fails.

#### 4b. Multi-Client Permission Routing Bug

In `packages/server/src/session-manager.js`, when a permission response comes in, it's routed to the session that has a pending permission request. But the routing uses a simple lookup:

```javascript
// Current code (simplified)
_handlePermissionResponse(response) {
  const session = this._sessions.get(response.sessionId)
  if (session && session._pendingPermission) {
    session.respondToPermission(response)
  }
}
```

If two clients are connected and both see the same permission request, the first response is processed and the second is silently dropped. This is correct. But if the first client disconnects after seeing the permission request but before responding, the fallback logic routes to... nothing. The permission request is orphaned.

**Impact**: Claude Code hangs waiting for a permission response that will never come.

**Fix**: On client disconnect, check for orphaned permission requests and re-emit them to remaining connected clients.

#### 4c. Pending Streams Cleanup

When a client disconnects mid-stream, the `stream_start` event has fired but `stream_end` never will (for that client). If the client reconnects and receives a history replay, it may see a `stream_start` without a corresponding `stream_end`, causing the UI to show a perpetual "streaming" state.

**Fix**: On reconnect, inject a synthetic `stream_end` for any unclosed streams in the replayed history.

### 5. Data Integrity: Ring Buffer Limitations

**Severity**: Medium

The ring buffer (`_history`) in `session-manager.js` has a fixed size (default 100 messages). This means:

- Long sessions silently lose early messages
- There's no indication to the user that history has been truncated
- The persist debounce (5 seconds) means up to 5 seconds of messages can be lost on crash
- The JSON persistence file can become corrupted if the process crashes mid-write

**Recommendations**:
1. Increase ring buffer from 100 to 500 (memory cost is negligible for text messages)
2. Reduce persist debounce from 5 seconds to 2 seconds
3. Add a `history_truncated` flag to the `history` message so the client can show "earlier messages not available"
4. Use atomic file writes (write to temp, rename) to prevent corruption

---

## Additional Findings

### 6. Symlink Bypass in File Browser

**Severity**: Medium

The file browser in `packages/server/src/file-browser.js` uses `path.normalize()` + `startsWith()` to prevent path traversal. But this doesn't resolve symlinks:

```javascript
// Current defense
const resolved = path.normalize(path.join(baseDir, requestedPath))
if (!resolved.startsWith(baseDir)) {
  throw new Error('Path traversal detected')
}
```

A symlink inside the allowed directory can point to any location on the filesystem:

```
~/project/link -> /etc/passwd
```

Request for `~/project/link` passes the `startsWith` check because the normalized path is still under `~/project/`, but the actual file read follows the symlink to `/etc/passwd`.

**Impact**: Read-only access to any file on the machine, bypassing the directory restriction.

**Fix**: Use `fs.realpathSync()` to resolve symlinks before the `startsWith` check:

```javascript
const resolved = fs.realpathSync(path.normalize(path.join(baseDir, requestedPath)))
if (!resolved.startsWith(fs.realpathSync(baseDir))) {
  throw new Error('Path traversal detected')
}
```

### 7. Health Endpoint is Unauthenticated

The HTTP health endpoint (`GET /`) returns `{"status":"ok"}` without any authentication. While this is intentional (Cloudflare needs it for tunnel health checks), it also means anyone who discovers the tunnel URL can:

- Confirm the server is running
- Determine it's a Chroxy server (by response format)
- Potentially enumerate server state if more endpoints are added

**Risk**: Low for current functionality, but increases if more HTTP endpoints are added.

**Recommendation**: Keep the health endpoint unauthenticated (Cloudflare needs it), but add a `Server` header that doesn't reveal the software name. Don't add additional HTTP endpoints without authentication.

### 8. Permission Response Routing Fallback

When a `permission_response` arrives but no session has a matching pending permission, the response is silently dropped. This can happen when:

- The permission request timed out on the server side
- The session was deleted while the user was reviewing the permission
- A race condition between two clients

**Impact**: User taps "Allow" on their phone, nothing happens. No feedback, no error, no retry.

**Fix**: Send an error message back to the client when a permission response can't be routed:

```javascript
if (!session || !session._pendingPermission) {
  this._send(ws, 'error', {
    code: 'PERMISSION_EXPIRED',
    message: 'This permission request has expired or was already handled'
  })
  return
}
```

---

## Recommendations Summary

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| P0 | Fix symlink bypass in file browser | 30 min | Prevents filesystem read escape |
| P0 | Fix permission routing fallback — send error to client | 1 hour | Prevents silent permission failures |
| P1 | Remove silent encryption downgrade (fail instead of fallback) | 2 hours | Prevents plaintext data exposure |
| P1 | Authenticate health endpoint headers | 30 min | Reduces information disclosure |
| P2 | Add key rotation mechanism | 4 hours | Limits exposure window |
| P2 | Reduce persist debounce 5s → 2s | 15 min | Reduces crash data loss |
| P2 | Increase ring buffer 100 → 500 | 15 min | Retains more history |
| P3 | Add history_truncated flag | 1 hour | Better UX for long sessions |
| P3 | Atomic file writes for persistence | 2 hours | Prevents corruption |
| P3 | Inject synthetic stream_end on reconnect | 1 hour | Fixes perpetual streaming state |

---

## Verdict

The document provides a solid security comparison with one major framing error: treating "server decrypts" as a deficit. This reflects a misunderstanding of Chroxy's trust model — the server is the user's own machine. Fix this framing.

The actual security concerns are: the symlink bypass (real but limited — read-only), the permission routing bug (causes user frustration), the encryption downgrade race (real but narrow window), and the ring buffer data loss (availability, not confidentiality).

Chroxy has a fundamentally smaller attack surface than Happy because it has no RPC, no relay, and read-only file access. The bash RPC in Happy is the single most dangerous feature in either architecture — if the relay is compromised, every connected machine is compromised. Chroxy should never adopt RPC for this reason.

Overall: the architecture is sound for its threat model. Fix the identified bugs, harden the edges, and maintain the read-only security posture.
