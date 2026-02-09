# Futurist Architecture Audit: In-App Iterative Development

**Agent**: Futurist -- forward-thinking architect, 6-12 month horizon
**Overall Rating**: 2.6 / 5
**Date**: 2026-02-09

---

## Executive Summary

The architecture is well-suited for its stated goal -- a personal dev tool that can update itself. The supervisor/IPC design is elegant for that use case. However, strong implicit assumptions (single user, single machine, Claude Code, mobile-only client) limit evolution. The most valuable near-term investments are reducing technical debt and adding extension points, not expanding scope.

---

## Section-by-Section Ratings (Future-Proofing)

| Section | Rating | Summary |
|---------|:------:|---------|
| 1. Multi-Device | 2/5 | WS plumbing supports multiple clients. No device identity. Permission prompts race. |
| 2. Team Development | 1/5 | Single-tenant architecture. Shared mutable state. Dead end without redesign. |
| 3. Plugin Architecture | 2/5 | EventEmitter foundation exists. No middleware pattern or hook points. |
| 4. CI/CD Integration | 3/5 | Deploy primitives solid. Missing HTTP API for external triggering. |
| 5. Different AI Models | 2/5 | Deep Claude coupling: binary spawn, JSON events, `--resume`, `settings.json`. |
| 6. Desktop Client | 4/5 | Protocol and state management are portable. Best extensibility score. |
| 7. Self-Hosted vs Cloud | 2/5 | Local process model, filesystem state, PID files. Cannot become hosted service. |
| 8. Composability | 3/5 | Clean boundaries. TunnelManager and CliSession are standalone. WsServer is a god object. |
| 9. API Design Longevity | 3/5 | Additive WS protocol is good. No message versioning. IPC protocol too rigid. |
| 10. Technical Debt | 2/5 | Dual-state model, WsServer god object, no types on server. Time bombs. |

---

## Technical Debt Forecast

1. **No TypeScript on server** (High regret, 3-6mo): As codebase grows with supervisor + deploy + IPC, refactoring without types becomes error-prone. Interface mismatches between server events and app types.

2. **Dual state model in `connection.ts`** (High regret, 1-3mo): Flat fields + `sessionStates` Record. Every update written twice via `updateActiveSession()`. 350+ lines of boilerplate. `connectionPhase` refactor will be extremely painful.

3. **`WsServer` god object** (Medium regret, 3-6mo): 1185 lines handling HTTP, WS, auth, permission hooks, three routing modes, delta buffering, keepalive, broadcasting. Architecture adds more. Will exceed 1500 lines.

4. **Module-level mutable state in `connection.ts`** (Medium regret, 1-3mo): 10+ module-level variables outside Zustand store. Effectively global state. Impossible to test in isolation.

5. **Permission hook writing to `~/.claude/settings.json`** (Medium regret, 3-6mo): Modifying a third-party config file with read-modify-write cycles. Race conditions. Format changes from upstream will break.

---

## Top 5 Changes for Long-Term Extensibility

### 1. Extract WsServer message handling into middleware/router pattern
`_handleSessionMessage()` switch statement → `Map<string, Handler>` with registered functions. Enables plugins, testing, and extension without modifying core file.

### 2. Introduce `SessionProvider` interface
Abstract away Claude-specific coupling. `CliSession` → `ClaudeCliProvider`. SessionManager creates sessions via factory. Enables mock providers for testing and future model support.

### 3. Add protocol versioning to `auth_ok` and IPC
`protocolVersion: 1` in `auth_ok`. Client sends supported version in `auth`. Enables negotiation and backward compatibility. Trivially backward-compatible.

### 4. Collapse dual-state model in `connection.ts`
Remove flat state fields. Always read from `sessionStates[activeSessionId]`. Use selector `useActiveSession()`. Highest-ROI refactor before implementing the architecture.

### 5. Add deploy lifecycle hook system to supervisor
`~/.chroxy/hooks/` directory with `pre-deploy.sh`, `post-deploy.sh`, `on-rollback.sh`. Matches git hooks pattern. Enables CI, notifications, metrics without modifying supervisor.
