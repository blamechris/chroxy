# Adversary Audit — Red-Team Security Engineer

**Overall Rating: 3.8/5**

## Key Findings

### 1. --no-auth Flag Disables ALL Security with No Runtime Warning
The `--no-auth` flag disables token validation, encryption negotiation, and all access controls. No log warning is emitted at startup. An operator who sets this for debugging and forgets to remove it has zero indication the system is fully open.

### 2. localhostBypass Can Disable Encryption Behind Reverse Proxy
When the server detects a localhost connection, it skips encryption. If deployed behind a reverse proxy (nginx, Caddy), all connections appear as localhost. E2E encryption is silently disabled for all clients.

### 3. Error Messages Leak Implementation Details
Error responses include raw error messages and sometimes partial stack traces. Examples: file paths, module names, internal state descriptions. An attacker can use these to map the server's internals.

### 4. Health Endpoint Exposes Version Without Auth
`GET /` returns `{"status":"ok","version":"0.3.0"}` without requiring authentication. Version disclosure aids targeted exploitation of known vulnerabilities.

### 5. No Origin Header Validation
WebSocket upgrade requests are accepted regardless of Origin header. While the token provides authentication, the lack of Origin validation leaves the door open for CSRF-adjacent attacks where a malicious page connects to a local Chroxy instance.

## Strong Points

- **Token comparison**: Uses `crypto.timingSafeEqual` for token validation. Correct.
- **Path traversal protection**: File operation paths are validated with `path.resolve` and checked against allowed directories. Comprehensive.
- **Schema validation**: Zod schemas validate all incoming WebSocket messages. Malformed messages are rejected before processing.
- **E2E encryption**: XSalsa20-Poly1305 (via TweetNaCl) for message encryption. Solid choice — authenticated encryption with no padding oracle risk.

## Verdict

The security posture is above average for a dev tool. The fundamentals (auth, encryption, input validation) are sound. The gaps are in operational security — configuration footguns (--no-auth, localhost bypass) and information leakage that matter when the tool is exposed beyond localhost.
