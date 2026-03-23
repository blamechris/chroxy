# Guardian Agent Report

**Rating: 2.8/5 | Findings: 11**

## Top Finding
Token rotation broadcasts the raw API token to all connected clients including unencrypted connections. An eavesdropper on a non-E2E link captures the new token.

## All Findings

1. **E2E key derivation uses fixed salt** — HKDF salt is static, reducing key uniqueness
2. **Hook secret uses non-constant-time comparison** — `Set.has()` is timing-vulnerable
3. **Nonce counter overflow** — No guard against integer overflow on nonce counter
4. **HTML injection in config meta tag** — Server config injected into dashboard HTML without escaping
5. **TOCTOU in file write validation** — Path validation and file write are not atomic
6. **SessionLockManager race** — Gap between async lock check and Map.set allows concurrent entry
7. **Token rotation plaintext broadcast** — `token_rotated` sends raw token to unencrypted clients
8. **No CSRF protection on dashboard endpoints** — POST endpoints lack CSRF token validation
9. **Permission response not authenticated** — Permission grant/deny not tied to original requester
10. **WebSocket frame size unbounded** — No max frame size enforcement on incoming messages
11. **Dashboard message handler untested** — 2,254 lines of core logic with no test coverage
