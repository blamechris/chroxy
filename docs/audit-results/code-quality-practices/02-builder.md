# Builder's Audit: Codebase-Wide Code Quality

**Agent**: Builder -- Pragmatic full-stack dev focused on maintainability and readability
**Overall Rating**: 2.5 / 5
**Date**: 2026-03-15

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| `ws-server.js` | 2.5/5 | God class, triple-context-bag, legacy fork |
| `session-manager.js` | 3/5 | Extracted delegates but leaky shims |
| `sdk-session.js` / `cli-session.js` | 3.5/5 | Good extraction, logging inconsistency |
| `server-cli.js` | 3/5 | Mixed console/logger, forward refs |
| `config.js` | 3.5/5 | Clean schema, one inline map |
| Handler modules | 4/5 | Good patterns, one constant DRY miss |
| `push.js` | 3/5 | Exact duplication across two methods |
| `message-handler.ts` | 2/5 | 1500-line switch, module-level state |
| `connection.ts` | 2.5/5 | Dual-store duplication, inline connect() |
| `models.js` | 4/5 | Good factory, proxy is obscure |

---

## Finding 1: `message-handler.ts` — 1500-line switch is untestable

The `handleMessage` function dispatches ~50 message types via a single switch statement, reading and writing 20+ module-level mutable variables. Testing any one case requires setting up `_store`, `_connectionContext`, and all relevant module-level flags. Changes to any case can have unexpected interactions with shared module state.

**Fix:** Extract each case to a typed handler function and replace the switch with a Map-based dispatcher, identical to the server's `ws-message-handlers.js`.

---

## Finding 2: `console.log` in `cli-session.js` bypasses structured logger

**File:** `packages/server/src/cli-session.js:115,172,199,207,240,262,293`

15 direct `console.*` calls versus the `createLogger` pattern used everywhere else. When the server runs with `logFormat: json`, half the session lifecycle logs are raw strings that can't be machine-parsed. These also aren't captured by the dashboard's log listener.

**Fix:** Replace all with `const log = createLogger('cli-session')`.

---

## Finding 3: `send` and `sendLiveActivityUpdate` in `push.js` are copy-pasted

**File:** `packages/server/src/push.js:190-303`

Two 53-line methods share identical structure: rate-limit check, build message array, `fetchWithRetry`, parse response, prune invalid tokens. Only difference is which Set they iterate.

**Fix:** Extract `_sendToTokenSet(tokenSet, messages, category, logLabel)` private method.

---

## Finding 4: Backward-compatibility shims expose internal state

**File:** `packages/server/src/session-manager.js:151-168`

After extracting `SessionStatePersistence` and `SessionMessageHistory`, the SessionManager re-exposes the extracted objects' private fields as its own. The session manager directly iterates `this._pendingStreams` in `destroySession` (line 442) rather than calling through the history module's API. The abstraction leaked before it was finished.

---

## Finding 5: Dual store state for connection phase and client identity

**Files:** `packages/app/src/store/connection.ts`, `connection-lifecycle.ts`

`connectionPhase`, `savedConnection`, `connectionError`, `myClientId`, `connectedClients`, `serverVersion`, `isEncrypted`, and `sessionCwd` are written to both stores on every relevant event. Comments acknowledge this is a half-completed refactor. Every state transition that writes to one store but forgets the other creates a subtle divergence bug.

---

## Additional Issues

- **`ws-server.js` constructor**: 25+ instance variables and three inline context bags (`_handlerCtx`, `_historyCtx`, `_authCtx`). Handlers have no well-defined contract.
- **`ws-server.js` `start()` method**: 230 lines wiring HTTP, WebSocket, ping interval, auth cleanup, version check, log forwarding.
- **`VALID_PERMISSION_MODES` defined twice**: In `base-session.js:12` and `session-handlers.js:34`.
- **`DEFAULT_MAX_TOOL_INPUT_LENGTH` duplicated**: In `sdk-session.js:41` and `cli-session.js:12`.
- **`_handleEvent` in cli-session.js**: 223-line switch statement with 5 distinct behaviors in one case arm.
- **`envKeyForConfig` map rebuilt on every call**: Should be a module-level constant.
