# Skeptic's Audit: Chroxy v0.6.8 Full Codebase

**Agent**: Skeptic — Cynical systems engineer who has seen too many designs fail. Cross-references every claim against actual code.
**Overall Rating**: 3.0 / 5
**Date**: 2026-04-05

---

## Section Ratings

### Authentication & Session Token Validation — 2/5

The pairing flow issues `sessionToken` in `pairing.js`, but the WS reconnect path in `ws-auth.js` only validates the bearer token (API token), not the session token. The claim that "sessions are authenticated" is partially true — the initial connection is authenticated — but a reconnecting client can skip session-level validation entirely. Any bearer token that was ever valid can resume any session by guessing the session ID.

**Evidence**: `packages/server/src/pairing.js` issues tokens; `packages/server/src/ws-auth.js` validates bearer tokens but not session-to-token binding on reconnect.

### E2E Encryption Nonce Management — 2/5

`store-core/src/crypto.ts` uses a counter-based nonce scheme. The nonce counter resets to 0 on each new WebSocket connection. Since the shared key does not change between reconnects (it's derived once from the pairing handshake and persisted), this means every reconnect reuses nonce 0 with the same key. XSalsa20-Poly1305 with repeated nonces under the same key is a catastrophic break — an attacker who captures two sessions can XOR ciphertexts to recover the keystream.

**Evidence**: `packages/store-core/src/crypto.ts` — nonce counter is session-local; no mechanism to persist or advance counter across reconnects.

### Permission System — 3/5

The permission rule engine in `permission-manager.js` applies rules sequentially and the hook system in `permission-hook.js` runs an external shell command. This is functional, but there is no validation that the hook binary hasn't been replaced (TOCTOU). The claim in docs that hooks are "sandboxed" is misleading.

### WebSocket Protocol — 3/5

The protocol is well-defined and the auth flow (auth → auth_ok → server_mode → status → claude_ready) is consistently implemented. However, the `SERVER_PROTOCOL_VERSION` is a constant that never actually gates compatibility — a client with mismatched protocol version will not be rejected, it will silently proceed and potentially misparse messages.

### Error Handling — 3/5

Many handler functions in `handlers/` swallow errors silently or log at DEBUG level. If `session-handlers.js` throws during a client request, the client receives no error response. This isn't a security issue, but it violates the stated protocol contract.

---

## Top 5 Findings

1. **Nonce reuse on reconnect** (`store-core/src/crypto.ts`): Counter resets to 0 on each connection. Same shared key + same nonce = keystream reuse. A passive attacker capturing traffic from two separate sessions can XOR ciphertexts. This is a known-plaintext → full plaintext recovery scenario. **Severity: Critical.**

2. **Session token never validated on reconnect** (`ws-auth.js`): The session token issued during pairing is stored but never checked against the session ID during WS reconnects. Bearer-token auth only. **Severity: High.**

3. **Protocol version mismatch not gated** (`ws-server.js`): `SERVER_PROTOCOL_VERSION` is sent but never enforced. Old clients silently interoperate. When protocol changes break wire format, there will be no useful error. **Severity: Medium.**

4. **Hook binary not verified before execution** (`permission-hook.js`): The hook script path is loaded from config and executed without checking if it's been modified since configuration. An attacker with write access to the config directory can substitute any binary. **Severity: Medium.**

5. **Silent handler errors** (`handlers/*.js`): Several handler modules catch errors internally and do not propagate a structured error response to the requesting client. From the client's perspective, the request simply times out. **Severity: Low-Medium.**

---

## Concrete Recommendations

1. **Nonce continuity**: Persist the nonce counter to disk (or derive per-session keys from the shared key + a random session salt) so reconnects never reuse nonce 0.
2. **Session token binding**: Store `sessionToken → sessionId` mapping in `ws-auth.js` and validate on every connection attempt that uses a session ID.
3. **Protocol version enforcement**: Add a version check in the auth flow that returns `auth_error` with `reason: "protocol_version_mismatch"` for out-of-date clients.
4. **Hook binary integrity**: Record the hash of the hook binary at configuration time; verify on every execution.
5. **Structured handler errors**: Add a `sendError(ws, requestId, code, message)` utility and ensure all handler functions call it on failure.

---

## Overall Verdict

Chroxy's core architecture is sound — the WS protocol, session management, and CLI integration are well-designed. The critical failure is in the crypto layer: nonce reuse on reconnect undermines the entire E2E encryption guarantee. A passive network observer who captures two separate sessions of the same client can recover plaintext. Everything else is medium-severity operational debt. The project is not ready for production use as an encrypted remote terminal until the nonce continuity issue is fixed.

**Overall Rating: 3.0 / 5**
