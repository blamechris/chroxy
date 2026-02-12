# Adversary's Audit: E2E Test Suite

**Agent**: Adversary -- Security engineer who asks "what malicious inputs would break this?"
**Overall Rating**: 2.5 / 5
**Date**: 2026-02-12

## Section Ratings

| Area | Rating | Justification |
|------|--------|---------------|
| Auth & bypass | 3/5 | Core paths covered; pre-auth injection, auth timeout, type confusion untested |
| Input validation | 2/5 | Only empty string tested; no type fuzzing, no oversized messages, no null bytes |
| Rate limiting | 3/5 | Unit tests adequate; E2E has zero coverage; IP header spoofing untested |
| Permission system | 2/5 | Only happy-path allow; deny, timeout, multi-client race, bogus requestId untested |
| Session security | 3/5 | CRUD covered; cross-client destruction, max limit, name injection untested |
| Directory listing | 2/5 | Basic paths only; no traversal, no symlinks, no tilde expansion, no null bytes |
| Timing-safe comparison | 3/5 | Implementation correct; never tested for actual timing safety |
| Multi-client | 4/5 | Good coverage; missing malicious deviceInfo payloads |
| Drain mode | 1/5 | Zero E2E coverage |
| WebSocket robustness | 1/5 | No binary frames, no malformed JSON, no oversized messages, no flooding |

## Top 5 Findings

1. **Pre-auth message injection untested** -- `ws-server.js:541-542` guard never exercised. If removed during refactor, unauthenticated users gain full access.
2. **Non-string input can crash CLI session handler** -- `ws-server.js:630` calls `text.trim()` which throws TypeError if `data` is a number. **Potential actual bug.**
3. **Permission deny path and multi-client race completely untested** -- Only `allow` tested. Two clients could race to approve/deny the same permission request.
4. **IP-based rate limiting bypassable via header spoofing** -- `ws-server.js:283-286` trusts `x-forwarded-for` even when not behind a proxy.
5. **No WebSocket message size limit** -- `WebSocketServer` created without `maxPayload`; defaults to 100MB. No test exercises this.

## Recommended Security Tests

| Priority | Test | Target |
|----------|------|--------|
| P0 | Pre-auth message rejection | `ws-server.js:541-542` |
| P0 | Non-string input fuzzing (number, null, object, array) | `ws-server.js:630` |
| P1 | Permission deny flow | `ws-server.js:704-718` |
| P1 | Multi-client permission race | `ws-server.js:711-714` |
| P1 | Auth timeout enforcement (10s) | `ws-server.js:316-323` |
| P2 | Directory traversal attempts | `ws-server.js:1409-1455` |
| P2 | Oversized WebSocket message | `ws-server.js:273` |
| P2 | Non-JSON WebSocket frames | `ws-server.js:328-331` |
| P2 | Session name injection (XSS, long strings) | `ws-server.js:747` |
| P3 | Connection flood (50+ unauthenticated) | Server stability |

## Verdict

The E2E suite verifies functional correctness for the happy path but is insufficient for security assurance. It never tests pre-auth injection, never sends malformed or type-confused inputs, never exercises permission deny, never probes rate limiting, and never sends adversarial payloads. The most concerning finding is the potential TypeError crash from non-string input in CLI mode (`ws-server.js:630`). An adversary with WebSocket access would find several untested paths to explore.
