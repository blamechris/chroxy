# Skeptic's Audit: Codebase-Wide Code Quality

**Agent**: Skeptic -- Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 3.1 / 5
**Date**: 2026-03-15

---

## Section Ratings

| Module | Rating | Summary |
|---|---|---|
| `crypto.js` | 4.5/5 | Solid. One subtle edge case. |
| `ws-server.js` | 3.0/5 | Overly large, EADDRINUSE exits whole process |
| `session-manager.js` | 3.2/5 | Aliasing debt, naming bug, unawaited promises |
| `sdk-session.js` | 3.5/5 | Good, but 5-min safety timeout has a gap |
| `supervisor.js` | 2.5/5 | Rollback is fictional for most deployments |
| `ws-auth.js` | 3.5/5 | Auth rate-limit uses correct IP, but pair flow is slightly divergent |
| `push.js` | 3.8/5 | Solid, minor issue with rate-limit-before-send ordering |
| `session-handlers.js` | 2.8/5 | Unawaited async destroy, null dereference on last-session destroy |
| `config.js` | 3.5/5 | `costBudget` type mismatch schema vs code |
| `rate-limiter.js` | 4.0/5 | Correct sliding window, no unbounded memory guard |
| App `connection.ts` | 3.3/5 | Module-level mutable state shared across connections |
| App `message-handler.ts` | 2.8/5 | 2179 lines, module-level state is a reconnect hazard |

---

## Finding 1 — Unawaited Async Promise: `destroySessionLocked` (Critical Bug)

**File:** `packages/server/src/handlers/session-handlers.js:77-78`

`destroySessionLocked` is an `async` function (session-manager.js line 401). When the return value is discarded, two things happen:

1. The `ctx.primaryClients.delete(targetId)` and the client-session reassignment loop on lines 82-99 run **before** the lock is actually acquired. This defeats the entire purpose of the lock.
2. Any error thrown inside `destroySessionLocked` becomes an unhandled promise rejection.

**Fix:** `await ctx.sessionManager.destroySessionLocked(targetId)` and make the handler async.

---

## Finding 2 — Session Naming Off-By-One

**File:** `packages/server/src/session-manager.js:261`

```js
const sessionName = name || `Session ${this._sessions.size + 1}`
```

If a session is destroyed between two creations, the counter regresses. Destroy session 2 (size drops to 1), create a new session — it gets named "Session 2" again. Now you have two sessions with identical names.

**Fix:** Use a monotonically incrementing counter (`this._sessionCounter`) rather than `_sessions.size`.

---

## Finding 3 — Auth Rate Limiter Uses Wrong IP Through Cloudflare

**Files:** `ws-server.js:563-575`, `ws-auth.js:41,128`

Through a Cloudflare tunnel, every connection's `socketIp` is Cloudflare's egress IP. All clients share one auth failure counter. Three failed auth attempts from three different attackers could block all legitimate users simultaneously.

**Fix:** Use `client.ip` (cf-connecting-ip-aware) for auth failure tracking.

---

## Finding 4 — `destroySession` Client Loop Has Null Dereference Path

**File:** `packages/server/src/handlers/session-handlers.js:67-99`

The `listSessions().length <= 1` guard runs before the lock is acquired. A concurrent destroy could eliminate the remaining session, causing `firstSessionId` to be `null`. The code sets `c.activeSessionId = firstId` unconditionally, leaving the client sessionless with no recovery path.

---

## Finding 5 — Rollback Feature is Non-Functional for Most Deployments

**Files:** `supervisor.js:500-539`, `cli/deploy-cmd.js:110-114`

The `known-good-ref` file is only written by `chroxy deploy`. A user running `npx chroxy start` never runs `deploy`, so rollback never exists. When 3 crashes occur, the supervisor exits entirely. The "deploy crash rollback" feature is actually a "guaranteed supervisor death" for anyone not using `chroxy deploy`.

---

## Finding 6 — Module-Level Mutable State in `message-handler.ts`

**File:** `packages/app/src/store/message-handler.ts`

Over a dozen module-level mutable variables that persist across reconnects. If `_pendingKeyPair` is set during auth handshake and the connection drops mid-exchange, the stale key pair persists into the next connection attempt if health check fails first.

The 2179-line file is larger than `ws-server.js` and `session-manager.js` combined, and its implicit reset protocol is only correct if every disconnect path calls every cleanup function in the right order.
