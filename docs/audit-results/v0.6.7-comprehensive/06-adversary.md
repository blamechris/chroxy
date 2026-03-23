# Adversary Agent Report

**Rating: 3.0/5 | Findings: 10**

## Top Finding
Auth token is passed as a URL query parameter (`?token=...`). Browsers include the full URL in the `Referer` header on outbound requests, leaking the token to any external resource loaded by the dashboard.

## All Findings

1. **HTML injection via config meta tag** — Server-rendered config in HTML meta tag not escaped
2. **Auth token in URL query string** — Token leaked via Referer header to external resources
3. **No Content-Security-Policy on dashboard** — Dashboard serves no CSP header
4. **Prototype pollution in config merge** — Deep merge doesn't guard against `__proto__` keys
5. **Hook secret timing attack** — `Set.has()` comparison is non-constant-time
6. **POST /permission lacks rate limiting** — Permission endpoint can be brute-forced
7. **WebSocket origin not validated** — No Origin header check on WebSocket upgrade
8. **Session ID predictable** — Session IDs generated with insufficient entropy
9. **Error messages leak internals** — Stack traces and file paths included in client-facing errors
10. **Token rotation plaintext broadcast** — `token_rotated` sends raw token over unencrypted links
