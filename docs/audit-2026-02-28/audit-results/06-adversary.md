# Adversary's Audit: Desktop Architecture Audit

**Agent**: Adversary -- Red-team security engineer who thinks like an attacker
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

### Section 1: Message Synchronization -- Rating: 3/5

Fails to analyze security implications. Delta buffering means injected content is silently merged into legitimate responses. The `seq` numbers carry no authentication -- a MITM could inject messages with valid-looking sequences during reconnection. No per-message signing when encryption is bypassed (localhost).

### Section 2: Repository and Session Management -- Rating: 2/5

Significant security blind spots. State file contains full conversation history (500 messages with file contents). Tauri `setup.rs:34` creates `config.json` (containing API token) with `fs::write()` using default permissions -- world-readable on many systems. Session IDs are `randomUUID().slice(0, 8)` -- only 32 bits of entropy.

### Section 3: Tunnel Implementation -- Rating: 3/5

mDNS advertisement broadcasts server presence, version, port, and auth mode to entire LAN. Localhost encryption bypass treats ALL local processes as trusted. During tunnel recovery, only LAN/local connections work and they bypass E2E encryption.

### Section 4: WebSocket / Real-Time Communication -- Rating: 3/5

Multiple Zod schemas use `.passthrough()` allowing arbitrary extra fields. No authorization on session operations -- any authenticated client can operate on any session. Rate limiting only covers auth failures -- post-auth, unlimited expensive operations.

### Section 5: Data Flow Diagram -- Rating: 4/5

Accurate diagrams. Notes API token passed via environment variable (visible in `/proc/{pid}/environ`).

### Proposed Protocol -- Rating: 2/5

`sync_request` with arbitrary `lastSeq` enables information disclosure. `subscribe_sessions` has no access control. IPC channel proposal explicitly skips encryption with no authentication model. Message priority "critical" flag could be used for DoS via batching bypass.

---

## Top 5 Findings

### Finding 1: API Token Exposed in Dashboard HTML (CRITICAL)

**File:** `dashboard.js:151`, `window.rs:25-27`

The API token is embedded directly in the HTML response as `window.__CHROXY_CONFIG__` and appears in the URL query string (`?token=TOKEN`). This means:
- Token in browser history, web server logs, Referer headers
- Token in rendered HTML -- accessible to browser extensions and dev tools
- The Tauri CSP allows `connect-src ws://localhost:*`, so a malicious extension can read `window.__CHROXY_CONFIG__` and use the token

**Severity: CRITICAL** -- Token theft grants full control: all sessions, all history, arbitrary code execution via Claude with `auto` permission mode.

### Finding 2: Config File Written with Default Permissions (HIGH)

**File:** `setup.rs:34`

Tauri's `fs::write(&path, json_str)` creates `~/.chroxy/config.json` containing the API token with default permissions (typically 0o644, world-readable). The Node.js side uses `writeFileRestricted()` with `mode: 0o600` (`platform.js:15-17`), but the Rust setup code does not.

**Severity: HIGH** -- Any local user can read the auth token.

### Finding 3: No Authorization Boundary Between Sessions (HIGH)

**Files:** `ws-message-handlers.js:257-258, 97-100, 302-331, 563-597`

Once authenticated with the single shared token, any client has full access to all sessions. No per-session authorization. An attacker with a stolen token can: list all sessions, read full history, send input, set permission mode to `auto` (bypassing confirmation with `confirmed: true`), and execute arbitrary code in any session's working directory.

**Severity: HIGH** -- Token compromise = complete compromise. No defense in depth.

### Finding 4: WebView Dashboard XSS Could Escalate (MEDIUM)

**File:** `tauri.conf.json:11`

Tauri CSP allows `'unsafe-inline'` for scripts. The server-side dashboard uses per-request nonces, but the Tauri-level CSP is separate. Shell plugin enabled with `"open": true`. An XSS in dashboard content could open arbitrary URLs and potentially exploit Tauri WebView vulnerabilities.

### Finding 5: mDNS Service Advertisement Enables LAN Reconnaissance (MEDIUM)

**File:** `server-cli.js:184-188`

Broadcasts: hostname, server version, port, and auth mode (`'token'` or `'none'`). Any device on the LAN can enumerate Chroxy instances, determine versions, and attempt authentication.

---

## Attack Scenario Results

| Scenario | Result | Risk |
|----------|--------|------|
| Attacker on same LAN | Discovers server via mDNS; token brute-force rate-limited but token theft via config file trivial | High |
| Malicious tunnel traffic | E2E encryption protects content; no MITM defense against tunnel provider itself (no cert pinning) | Medium |
| Token theft | Complete compromise: all sessions, history, code execution via Claude | Critical |
| Local privilege escalation | Read `config.json` (world-readable) -> authenticate -> `auto` permission mode -> arbitrary commands | High |
| WebView sandbox escape | Limited by CSP, but `'unsafe-inline'` + shell `open` creates surface | Low-Medium |
| Session hijacking | Trivial with stolen token; session isolation is not a design concept | High |
| Data exfiltration via checkpoint | Git tags visible, checkpoint JSON readable with filesystem access | Medium |
| Cross-session data leakage | By design: `_broadcastToSession` sends to all clients, `request_full_history` has no access control | High |

---

## Concrete Recommendations

### CRITICAL
1. **Remove API token from HTML/URLs** -- Use session cookies or short-lived JWTs instead. Token should never appear in browser history or rendered pages.
2. **Fix config.json file permissions** -- Change `setup.rs:34` to set mode 0o600 on Unix.

### HIGH
3. **Add per-session access control** -- Session-scoped authorization. Prevent access to sessions not explicitly subscribed to.
4. **Add post-auth rate limiting** -- Per-client limits on `create_session`, `launch_web_task`, `request_full_history`, `browse_files`.

### MEDIUM
5. **Remove `'unsafe-inline'` from Tauri CSP** -- Match server-side nonce-based CSP.
6. **Add opt-out for mDNS** -- Allow disabling service discovery. Remove version from TXT records.
7. **Remove `.passthrough()` from Zod schemas** -- Strip unknown fields to prevent confusion attacks.

### LOW
8. **Add server identity verification to key exchange** -- Prevent MITM by tunnel proxies.
9. **Restrict `list_directory` default** -- Don't expose home directory structure.

---

## Verdict

The audit document treats authentication as a solved problem while ignoring that the single API token is exposed in HTML, URLs, and a world-readable config file. The system has no defense in depth: token compromise equals total compromise. The strongest security features (E2E encryption, constant-time token comparison, nonce-based replay prevention) are professional-grade but undermined by weak token lifecycle and lack of authorization boundaries. Fix token handling, add per-session authorization, and tighten the CSP before building the new desktop app on this foundation.
