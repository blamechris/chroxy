# Skeptic Agent Report

**Rating: 3.0/5 | Findings: 11**

## Top Finding
Desktop tray `kill_port_holder` kills any process on the configured port without verifying it belongs to Chroxy. A user running another service on the same port loses that process.

## All Findings

1. **Nonce counter overflow** — No overflow guard on encryption nonce counter; wraps past MAX_SAFE_INTEGER
2. **Cost budget per-session vs global confusion** — Budget enforcement unclear whether it applies per-session or globally
3. **Tunnel URL race** — QR code displayed before tunnel URL is fully routable
4. **Config merge precedence undocumented edge cases** — Deep merge of nested objects may produce unexpected results
5. **Supervisor backoff resets on success** — A single successful start resets backoff, enabling rapid crash loops
6. **Missing history replay on auto-switch** — When a session is destroyed and auto-switched, history is not replayed
7. **Token rotation broadcast to unencrypted** — `token_rotated` sends raw token over non-E2E connections
8. **WebSocket close code semantics** — Custom close codes not consistently interpreted across clients
9. **CliSession drops messages before ready** — Messages sent before CLI process is ready are silently dropped
10. **kill_port_holder kills unrelated processes** — Desktop tray kills any process on the port, not just Chroxy
11. **Push notification payload size** — Large session names may exceed Expo push payload limits
