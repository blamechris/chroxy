# Minimalist's Audit: Chroxy v0.6.8 Full Codebase

**Agent**: Minimalist — Ruthless engineer who believes the best code is no code. Identifies what to cut and proposes minimal alternatives.
**Overall Rating**: 3.0 / 5
**Date**: 2026-04-05

---

## Section Ratings

### @chroxy/protocol Package — 2/5

`packages/protocol/` is a separate npm workspace package containing Zod schemas and TypeScript types. It has its own `package.json`, `tsconfig.json`, and build step. It is consumed by `packages/server` (which is plain JavaScript and therefore ignores the TypeScript types entirely, only using the compiled JS schemas) and `packages/store-core`.

This package exists because it once seemed like a good idea to share types. In practice:
- The server doesn't benefit from TypeScript types (it's JS)
- The schemas are not complex enough to justify a separate build step
- Every change to the protocol requires rebuilding `@chroxy/protocol` before other packages can use it
- The `dist/` files are checked into git (anti-pattern)

**Verdict**: Collapse into `store-core` or duplicate the Zod schemas into each consumer. The overhead of a separate package exceeds the benefit.

### Handler Over-Fragmentation — 3/5

`packages/server/src/handlers/` has 9 files:
- `checkpoint-handlers.js`
- `conversation-handlers.js`
- `environment-handlers.js`
- `extension-handlers.js`
- `file-handlers.js`
- `input-handlers.js`
- `repo-handlers.js`
- `session-handlers.js`
- `settings-handlers.js`
- `web-task-handlers.js`

Many of these have 1-3 functions and ~50-150 lines. The fragmentation doesn't provide meaningful isolation — all handlers import from the same shared utils and all are registered in the same `ws-message-handlers.js`. This is premature separation. 3-4 files would be sufficient: `session-handlers.js`, `file-handlers.js`, `settings-handlers.js`, and `misc-handlers.js`.

### Provider Registry — 3/5

`providers.js` defines a registry pattern for AI providers (Claude CLI, SDK, Gemini, Codex, Docker variants). The registry is extensible but the implementations are nearly identical in structure. Four of the six providers are wrappers around `CliSession` or `SdkSession` with slight configuration differences. The abstraction has been over-applied — the common config could be a parameter, not a separate registered provider.

### Tunnel Abstraction — 4/5

`tunnel/base.js` and `tunnel/cloudflare.js` are appropriately minimal. The abstraction is thin and justified — adding a second tunnel provider (ngrok, bore.pub) would be straightforward. No cuts needed here.

### Dashboard vs Server Coupling — 3/5

The server serves the dashboard from `packages/dashboard/dist/`. This is convenient for the desktop app but creates a tight coupling: the server must be built with the dashboard, and the dashboard's asset paths must match the server's routing assumptions. The blank dashboard bug (wrong Vite base path) is a direct consequence of this coupling. A cleaner approach: the desktop app serves its own dashboard; the server only provides the WebSocket endpoint.

---

## Top 5 Findings

1. **`@chroxy/protocol` package adds build complexity without value**: The server is JavaScript; it can't use the TypeScript types. The Zod schemas could live in `store-core/src/schemas.ts`. Eliminate the package, reduce the CI build graph. Estimated complexity reduction: ~200 lines of build config.

2. **Handler fragmentation increases cognitive overhead**: 9 handler files for ~500 total lines of handler logic. Consolidate to 4. No behavior change, just fewer files to grep.

3. **Provider registry over-abstraction**: `providers.js` registers 6 providers; 4 are nearly identical. Replace with a `createCliProvider(config)` factory. Removes ~100 lines of duplication.

4. **Dashboard served by server**: Coupling the SPA to the server's HTTP routes creates fragile path assumptions. The Tauri app should serve the dashboard directly from disk; the server should return 404 on `/dashboard` in non-desktop mode.

5. **`session-message-history.js` stores full message objects**: Full message content is stored in memory for every session. A session with 500 tool calls stores 500 complete objects. A summary (content length + type) would suffice for most use cases. Add a `summarize()` method and use it for in-memory storage.

---

## Concrete Recommendations

1. Move Zod schemas from `packages/protocol/src/schemas/` into `packages/store-core/src/schemas.ts`. Update imports. Archive/delete `packages/protocol/`.
2. Merge `extension-handlers.js`, `web-task-handlers.js`, and `environment-handlers.js` into a single `misc-handlers.js`.
3. Replace the 4 near-identical providers with a `createCliProvider({ sessionClass, defaultArgs })` factory function.
4. In `packages/desktop/`, serve the dashboard bundle from Tauri's asset server; remove the `/dashboard` route from `http-routes.js` in desktop builds.
5. Add `maxMessages: 1000` cap to `session-message-history.js` with a FIFO eviction.

---

## Overall Verdict

Chroxy has accumulated complexity in the right places (crypto, WebSocket protocol, session management) and in some wrong places (@chroxy/protocol build overhead, handler file proliferation). The core is not bloated, but the package structure adds friction to everyday development. The nonce reuse issue is a correctness bug, not a complexity problem — that's the other agents' territory. My cuts would reduce CI time by ~30s and reduce the number of files a contributor needs to understand by ~15%.

**Overall Rating: 3.0 / 5**
