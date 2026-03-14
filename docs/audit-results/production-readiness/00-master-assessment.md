# Production Readiness Audit — Master Assessment

**Date**: 2026-03-14
**Target**: Chroxy v0.3.x (server package)
**Aggregate Rating: 3.3/5**

## Auditor Panel

| # | Agent | Persona | Rating | Key Contribution |
|---|-------|---------|--------|------------------|
| 1 | Skeptic | Cynical systems engineer | 3.2/5 | Unhandled rejections, PostAuthQueue leak, respawn race |
| 2 | Builder | Pragmatic full-stack dev | 3.2/5 | Missing server error handlers, config validation gaps |
| 3 | Guardian | Paranoid SRE | 3.2/5 | Failure mode catalog (6 FMs), listener leak, process orphans |
| 4 | Minimalist | Ruthless simplicity engineer | 3.2/5 | Context redundancy, dead code (Gemini provider) |
| 5 | Adversary | Red-team security engineer | 3.8/5 | --no-auth footgun, localhost bypass, info leakage |
| 6 | Operator | On-call SRE | 3.5/5 | Silent catch blocks (7+), push reliability, no correlation IDs |

## Consensus Findings

Issues ranked by cross-agent agreement:

| Finding | Agents Agreeing | Severity |
|---------|----------------|----------|
| Silent error swallowing (empty catch blocks, push failures, tunnel verification) | 6/6 | High |
| Missing global error handlers (HTTP/WS `.on('error')`, `unhandledRejection`) | 5/6 | High |
| Push notification reliability (no retry, no timeout, no circuit breaker) | 5/6 | Medium |
| Config validation gaps (no range checks on port, maxSessions, sessionTimeout) | 4/6 | Medium |
| Respawn/process management races (guard race, orphaned processes) | 4/6 | Medium |

## Contested Points

**WsClientManager / ws-client-sender abstraction level**
- Minimalist: Over-abstracted thin wrappers, should be inlined.
- Builder, Guardian: Extraction is fine — improves testability and separation of concerns.
- **Verdict**: Keep the extractions. The testability benefit outweighs the indirection cost.

## Risk Heatmap

```
                  LOW IMPACT          MEDIUM IMPACT        HIGH IMPACT
              +------------------+------------------+------------------+
  LIKELY      | Config no-range  | Push silent drop | Silent catch     |
              | checks           | Tunnel verify    | blocks (7+)      |
              |                  | proceeds on fail |                  |
              +------------------+------------------+------------------+
  POSSIBLE    | Dead code        | Listener leak    | Missing global   |
              | (Gemini)         | (50+ sessions)   | error handlers   |
              | Context redund.  | Respawn race     |                  |
              +------------------+------------------+------------------+
  UNLIKELY    | Origin header    | localhost bypass  | --no-auth with   |
              | missing          | behind proxy     | no warning       |
              | Version in /     | Permission DoS   |                  |
              +------------------+------------------+------------------+
```

## Recommended Action Plan

### P0 — Fix Before Next Release

1. **Add global error handlers to HTTP and WS servers**
   `.on('error')` on both the HTTP server and WebSocketServer. Log and recover gracefully.

2. **Add timeout to push.js fetch**
   Wrap Expo Push API calls with `AbortController` + 10s timeout. Prevent indefinite hangs.

3. **Log all silent catch blocks**
   Audit every `.catch(() => {})` and add `logger.warn()` with context. Zero empty catches.

4. **Add config range validation**
   Port: 1-65535. maxSessions: 1-100. sessionTimeout: 1000-3600000ms. Reject invalid at startup.

### P1 — Next Sprint

5. **Push retry with exponential backoff**
   3 retries (1s, 4s, 16s) with circuit breaker (5 failures in 60s = disable for 5 min).

6. **--no-auth runtime warning**
   Log a prominent warning at startup when `--no-auth` is active. Repeat every 60s.

7. **Sanitize error messages to clients**
   Strip file paths, stack traces, and internal state from all error responses sent over WebSocket.

8. **Add request correlation IDs**
   Generate a UUID per incoming WS message, propagate through session manager and session.

### P2 — Backlog

9. **Metrics endpoint** (`/metrics` behind auth) — connection count, message throughput, error rate.
10. **Structured logging** — JSON log format with consistent fields for log aggregation.
11. **Backpressure monitoring** — Track and log WebSocket `bufferedAmount` per client.
12. **Tunnel verification logging** — Log each retry attempt and final outcome (success/proceed-anyway).

## Final Verdict

**3.3/5 — Functional but not hardened.**

Chroxy works reliably for its primary use case: a single developer running Claude Code remotely. The architecture is sound, security fundamentals are solid, and the codebase is lean.

The gaps are in operational resilience — silent failures, missing error boundaries, and absent telemetry. These matter when the server runs unattended (supervisor mode) or when debugging issues after the fact.

The P0 items are straightforward fixes (estimated 2-3 hours total) that would meaningfully improve reliability. The P1 items round out production readiness. P2 items are for when the user base grows beyond one.
