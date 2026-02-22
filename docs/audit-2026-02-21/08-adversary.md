# Adversary's Audit: Chroxy Security Penetration Assessment

**Agent**: Adversary -- Penetration tester focused on attack surfaces and exploitation
**Overall Rating**: 3.2 / 5
**Date**: 2026-02-21

---

## Attack Surface Map

### Endpoints

| Endpoint | Auth Required | Protocol | Purpose |
|----------|--------------|----------|---------|
| `GET /` | No | HTTPS | Health check -- returns `{status, mode, hostname, version}` |
| `GET /version` | No | HTTPS | Version info -- returns `{version, uptime, ...}` |
| `POST /permission-hook` | No (localhost only) | HTTP | Claude Code permission callback |
| WebSocket `/` | Token + ECDH | WSS | Primary communication channel |
| WebSocket messages | Post-auth | E2E encrypted | 30+ message types |

### WS Message Types (Post-Auth Attack Surface)

Key message types that could be abused:

| Message | Risk Area |
|---------|-----------|
| `send_message` | Arbitrary input to Claude Code |
| `create_session` | Session creation with arbitrary CWD |
| `browse_files` | Directory listing |
| `read_file` | File content reading |
| `get_diff` | Git diff with user-supplied base ref |
| `get_untracked_files` | File listing outside session scope |
| `permission_response` | Approve/deny tool execution |
| `request_full_history` | Retrieve all conversation data |
| `register_push_token` | Register for push notifications |

---

## Authentication Analysis

### Token Generation
The auth token is generated with `crypto.randomBytes(32).toString('hex')` -- 256 bits of entropy. Sufficient.

### Token Comparison
`ws-server.js` uses `timingSafeEqual` for token comparison. Correct -- prevents timing side-channel attacks.

### Rate Limiting
`ws-server.js:261,680-710`: Failed auth attempts are tracked per IP address. After threshold, connections are rate-limited. The implementation:

```javascript
// Auth rate limiting: track failed attempts per IP
```

Rate limiting is keyed on `req.socket.remoteAddress`. Behind Cloudflare, this is Cloudflare's IP, not the client's. See Finding F1.

---

## Findings

### F1: IP-Based Rate Limiting Ineffective Behind Cloudflare (MEDIUM)

**Location:** `ws-server.js:261`

Rate limiting uses `req.socket.remoteAddress` to track failed auth attempts. Behind Cloudflare tunnel, all connections arrive from Cloudflare's proxy IPs. This means:

1. All users share the same rate limit counter (one user's failures affect others)
2. An attacker using direct access (bypassing Cloudflare) can spoof source IPs to avoid rate limiting

**Cloudflare sets `CF-Connecting-IP` and `X-Forwarded-For` headers**, but the code does not use them.

**Impact:** Auth brute-force is constrained by token entropy (256 bits), so this is not immediately exploitable. But the rate limiting is security theater in its current form.

**Recommendation:** Use `CF-Connecting-IP` header when behind Cloudflare tunnel, fall back to `remoteAddress` for direct connections.

### F2: create_session Accepts Arbitrary CWD (HIGH)

**Location:** `ws-server.js:975-1005`

```javascript
case 'create_session': {
  const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : undefined
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : undefined

  if (cwd) {
    try {
      const stat = statSync(cwd)
      if (!stat.isDirectory()) { /* error */ }
    } catch (err) { /* error */ }
  }

  const sessionId = this.sessionManager.createSession({ name, cwd })
```

The only validation is that `cwd` is an existing directory. An authenticated attacker can create a session rooted at **any directory on the system** -- `/`, `/etc`, `/root`, etc. The file browser (`browse_files`) restricts paths to the session's CWD, but `create_session` does not restrict what that CWD can be.

**Impact:** An authenticated user (who has the token) can browse and instruct Claude to operate on any directory. This bypasses the file browser's path traversal checks by legitimately setting the CWD to a sensitive directory.

**Recommendation:** Restrict `cwd` to subdirectories of the server's configured root, or to the user's home directory. Alternatively, log `create_session` CWD choices for audit.

### F3: browse_files Path Traversal (FIXED)

**Location:** PR #710 merged.

Previously, symlinks could bypass the `startsWith(cwd)` check. Now fixed with `realpathSync()` before comparison.

**Status: RESOLVED.**

### F4: read_file Size Unbounded (LOW)

**Location:** `ws-server.js` `read_file` handler.

There is no file size limit on `read_file`. A client could request reading a multi-GB log file, causing the server to allocate that much memory.

**Impact:** DoS via memory exhaustion. Requires authentication.

**Recommendation:** Add a file size check before reading (e.g., `statSync(path).size < MAX_FILE_SIZE`).

### F5: request_full_history No Rate Limit (LOW)

**Location:** `ws-server.js` `request_full_history` handler.

An authenticated client can spam `request_full_history` to force the server to serialize and encrypt the entire message history repeatedly. For long sessions, this is CPU and memory intensive.

**Impact:** Performance degradation / DoS. Requires authentication.

**Recommendation:** Rate-limit `request_full_history` to once per 5 seconds per client.

### F6: Permission Hook Endpoint Accepts Localhost Only (GOOD)

**Location:** `ws-server.js` `POST /permission-hook` handler.

The permission hook only accepts connections from localhost. This is correct -- it is the callback endpoint for Claude Code's permission system and should not be externally accessible.

**Status: SECURE.**

### F7: Auth Token Visible to Cloudflare (MEDIUM)

**Architecture note:** The auth token is sent in the first WebSocket message, which passes through Cloudflare's proxy **before** E2E encryption is established. The flow is:

1. Client connects via WSS (TLS terminates at Cloudflare)
2. Client sends `{ type: 'auth', token: '...' }`
3. Server validates token
4. ECDH key exchange establishes E2E encryption
5. Subsequent messages are E2E encrypted

This means Cloudflare can see the auth token in transit. For Quick Tunnels (random URL), this is Cloudflare's infrastructure. For Named Tunnels, same.

**Impact:** A compromised or malicious Cloudflare edge node could extract the auth token. Low probability but non-zero for a security-conscious assessment.

**Recommendation:** Move ECDH key exchange before authentication, then send the auth token encrypted. This requires protocol changes but eliminates the Cloudflare-in-the-middle exposure.

### F8: Health Endpoint Leaks Hostname and Version (LOW)

**Location:** `ws-server.js:315`

```javascript
res.end(JSON.stringify({
  status: 'ok',
  mode: this.serverMode,
  hostname: hostname(),
  version: SERVER_VERSION
}))
```

The unauthenticated health endpoint returns the machine's hostname (e.g., `chris-macbook-pro.local`) and the exact server version. This is information disclosure useful for:
- Fingerprinting the server
- Identifying the machine behind the tunnel
- Targeting version-specific vulnerabilities

**Recommendation:** Remove `hostname` from the response. Version is borderline -- useful for client compatibility checks but aids attackers.

### F9: No Message Size Limit (LOW)

**Location:** WebSocket server configuration.

The WebSocket server does not configure `maxPayload`. The default is 100MB (ws library default). An authenticated client could send a 100MB message, forcing the server to buffer and process it.

**Recommendation:** Set `maxPayload` to a reasonable limit (e.g., 1MB) on the WebSocket server.

### F10: Push Token Registration Accepts Any Token (LOW)

**Location:** `register_push_token` handler.

An authenticated client can register any Expo push token. There is no validation that the token belongs to the device. An attacker with the auth token could register their own device to receive all push notifications (permission prompts, idle alerts).

**Impact:** Information disclosure via push notification hijacking. Requires authentication.

**Recommendation:** Associate push tokens with a client fingerprint (e.g., include a unique client ID in the token registration and validate on subsequent connections).

---

## Encryption Analysis

### Positive Findings

- **NaCl (TweetNaCl)** is used for symmetric encryption after ECDH key exchange. This is a well-audited, constant-time implementation.
- **Nonces are sequential counters**, separate for send and receive directions. This prevents nonce reuse.
- **Direction constants** (`DIRECTION_CLIENT`, `DIRECTION_SERVER`) prevent reflection attacks (server cannot decrypt its own messages).
- **No encryption downgrade.** Once ECDH completes, all subsequent messages must be encrypted. There is no "fall back to plaintext" path.

### Concerns

- **Pre-auth ECDH.** The key exchange happens before authentication, so any connector can establish an encrypted channel. This wastes CPU on unauthenticated connections.
- **Nonce is a JavaScript number.** Safe to `2^53 - 1` (9 quadrillion). Not a practical concern but not documented.
- **No key rotation.** The shared key persists for the lifetime of the connection. Long-running sessions use the same key for all messages.

---

## Top 5 Recommendations (Ordered by Exploitability)

1. **Restrict `create_session` CWD** (F2, HIGH). An authenticated attacker can access any directory on the system. Add allowlist or restrict to subdirectories of the configured server root.

2. **Fix rate limiting to use Cloudflare headers** (F1, MEDIUM). `CF-Connecting-IP` should be used when behind Cloudflare. Current rate limiting is per-proxy-IP, not per-client-IP.

3. **Move auth after ECDH** (F7, MEDIUM). The auth token is visible to Cloudflare in plaintext. Establishing encryption before auth eliminates this exposure.

4. **Remove hostname from health endpoint** (F8, LOW). Unnecessary information disclosure on an unauthenticated endpoint.

5. **Add maxPayload to WebSocket server** (F9, LOW). Set a reasonable message size limit (1MB) to prevent memory exhaustion from oversized messages.
