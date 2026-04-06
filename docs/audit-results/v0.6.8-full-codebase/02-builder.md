# Builder's Audit: Chroxy v0.6.8 Full Codebase

**Agent**: Builder — Pragmatic full-stack dev who will implement this. Revises effort estimates, identifies file-by-file changes.
**Overall Rating**: 4.1 / 5
**Date**: 2026-04-05

---

## Section Ratings

### Server Architecture — 4/5

The monorepo structure is clean and the separation between `packages/server`, `packages/app`, `packages/desktop`, and `packages/store-core` is sensible. The EventEmitter-based session lifecycle works well in practice. The handler split (`handlers/session-handlers.js`, `handlers/file-handlers.js`, etc.) is good for organization but creates a problem: handler functions have no consistent error propagation contract.

### File Operations — 3/5

`ws-file-ops/` is split into `reader.js`, `git.js`, `browser.js`, and `common.js`. This is reasonable but the input validation at the boundary is inconsistent. `reader.js` validates paths, but `git.js` does not validate that the repo path it receives is within an allowed root. An attacker who can send a WS message could potentially point git operations at an arbitrary directory.

### Session Lifecycle — 4/5

`session-manager.js` is the heart of the server. The `create → attach → destroy` flow is well-implemented. The race condition is in `destroy()`: if a client reconnects while `destroy()` is executing, the new connection can receive a partial session state. The fix is a `destroying` flag that `attach()` checks.

**Evidence**: `packages/server/src/session-manager.js` — `destroy()` is async and does not set a guard before starting cleanup.

### Handler Error Propagation — 2/5

Many handler modules in `packages/server/src/handlers/` catch errors at the top level and log them without sending a WS error response back to the client. The pattern:

```js
try {
  // ...
} catch (err) {
  logger.error('handler failed', err)
  // no ws.send(errorResponse)
}
```

appears in at least `session-handlers.js`, `file-handlers.js`, and `repo-handlers.js`. The client times out waiting for a response. This makes debugging extremely hard.

### Build & CI Pipeline — 4/5

CI runs server tests, lint, and app type-check on every PR. The dashboard is NOT built in CI before server tests run — instead CI creates a test fixture. This is intentional (avoids 30s dashboard build in every CI run) but means the CI-tested server and the production-built dashboard can drift. A full integration test that builds both and verifies the server correctly serves the dashboard is missing.

---

## Top 5 Findings

1. **Silent handler errors** (`handlers/*.js`): No structured error response is sent when handler functions throw. Clients time out silently. Fix: add `sendError(ws, requestId, code, msg)` and use it consistently. Effort: ~2 hours.

2. **Session destroy race** (`session-manager.js`): A reconnecting client during `destroy()` can receive partial state. Fix: add `this._destroying = true` at top of `destroy()`; `attach()` should reject while `_destroying`. Effort: ~1 hour.

3. **Git file op path validation** (`ws-file-ops/git.js`): Git operations don't validate that the target path is within the configured workspace root. Fix: add `assertWithinRoot(path, workspaceRoot)` call at each entry point. Effort: ~2 hours.

4. **Missing dashboard integration test**: The server is tested against a synthetic fixture, not the actual built dashboard. Fix: add a CI step that builds the dashboard and runs a curl smoke test against a real server instance. Effort: ~3 hours.

5. **`session-message-history.js` unbounded growth**: Message history for a session accumulates without a max size cap. Long-running sessions will consume increasing memory. Fix: ring buffer or `slice(-N)` with configurable `maxMessages`. Effort: ~1 hour.

---

## Concrete Recommendations

1. Create `packages/server/src/handler-utils.js` → add `sendError(ws, requestId, code, message)` → audit all handlers to use it.
2. Add `_destroying` guard to `SessionManager.destroy()` and check in `attach()`.
3. Add `assertWithinRoot(path, root)` to `ws-file-ops/common.js` and call it from `git.js` entry points.
4. Add integration test: `npm run build:dashboard && node test-server.js & sleep 2 && curl -f http://localhost:PORT/dashboard/`.
5. Add `maxMessages` config option to `session-message-history.js` with a sane default (1000).

---

## Overall Verdict

Chroxy is a well-built project for its stage. The architecture is clean, the code is readable, and the developer experience is good. The main gaps are operational: silent errors make debugging in production hard, and a few races in session lifecycle could cause confusing behavior under load. None of these are showstoppers, and the fixes are straightforward. I could implement all 5 recommendations in a day.

**Overall Rating: 4.1 / 5**
