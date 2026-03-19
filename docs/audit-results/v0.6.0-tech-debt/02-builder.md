# Builder's Audit: Chroxy v0.6.0 Tech Debt

**Agent**: Builder
**Overall Rating**: 2.9/5
**Date**: 2026-03-18

## Perspective

The Builder evaluates the codebase from the perspective of a developer who needs to ship features quickly and safely. Asks: *where does the architecture fight me?*

---

## 1. God Classes (2.0/5)

Four files exceed 1,000 lines and accumulate responsibilities beyond their original scope:

### message-handler.ts — 2,271 lines (app) / 2,209 lines (dashboard)
The message handler is the worst offender. Each copy handles:
- WebSocket message parsing and dispatch
- Session state management (messages, tool calls, costs)
- UI state derivation (streaming indicators, plan mode)
- Error recovery and reconnection state
- Delta batching and deduplication

A new developer cannot understand the message flow without reading 2,000+ lines. Feature work requires understanding both copies.

### ws-server.js — 1,145 lines
Despite prior extractions (WsPermissions, ws-file-ops), WsServer still handles:
- HTTP server lifecycle
- WebSocket upgrade and connection management
- Authentication and token validation
- Message routing to handlers
- Client state tracking
- Health check endpoints

### SessionScreen.tsx — 1,408 lines
The primary app screen combines:
- Chat view rendering
- Terminal view management
- Input handling (text + voice)
- Plan mode approval UI
- Agent monitoring panel
- Session lifecycle management

### lib.rs — 1,134 lines
The Tauri entry point handles:
- Window management
- Tray icon and menu
- System events
- IPC commands
- Auto-updater logic

---

## 2. Module Boundary Violations (2.5/5)

### WsServer reaches into SessionManager internals
`ws-server.js` accesses `SessionManager._sessions` (private Map) directly in at least 4 locations. This couples the WebSocket layer to the session storage implementation. If SessionManager changes its internal structure, WsServer breaks.

### WsPermissions reaches into SessionManager._sessions
Same pattern. The permission handler needs session references but obtains them by reaching through the manager rather than using the public API.

### Dashboard code inside server package
`packages/server/src/dashboard-next/` contains a full Vite+React application (TypeScript, Zustand, components). It is bundled by the server's build step but has completely different concerns, dependencies, and build tooling. This violates workspace separation and makes the server package responsible for React compilation.

---

## 3. Missing Types & Validation (3.0/5)

### Diverged app vs dashboard types
The app defines message types in `packages/app/src/types/`. The dashboard defines its own types in `packages/server/src/dashboard-next/src/types/`. These have drifted:
- Different optional field sets
- Different enum values for message status
- No shared source of truth

### No outbound server message validation
The server constructs WebSocket messages as plain objects and sends them with `JSON.stringify`. There is no runtime validation that outbound messages match the expected schema. `ws-schemas.js` exists but is only used in tests, and even there it validates inbound messages only.

### Wire types split across 5 locations
Protocol message types are defined in:
1. `packages/app/src/types/`
2. `packages/server/src/dashboard-next/src/types/`
3. `packages/server/src/ws-schemas.js`
4. Inline in `packages/server/src/ws-message-handlers.js`
5. Inline in `packages/server/src/ws-server.js`

---

## 4. Test Gaps (3.0/5)

### handler-utils.js — untested, security-critical
`handler-utils.js` (175 lines) contains path validation and sanitization used by file operation handlers. It has zero test coverage despite being on the security boundary.

### Screen components — untested
`SessionScreen.tsx` (1,408 lines), `ConnectScreen.tsx`, and `SettingsScreen.tsx` have no component tests. Given that SessionScreen contains complex state logic interleaved with rendering, this is a significant gap.

### Integration test gaps
No tests exercise:
- Concurrent session creation/destruction
- WebSocket reconnection after server restart
- End-to-end encryption roundtrip
- Plan mode approval flow through the full stack

---

## 5. Build & DX Friction (3.5/5)

### CI duplication
GitHub Actions workflows for server tests and app type checking share boilerplate (Node setup, cache, install). No reusable workflow or composite action.

### No .node-version file
The project requires Node 22 but has no `.node-version` or `.nvmrc` file. Developers must read CLAUDE.md to discover this. `nvm use` and `volta` would auto-detect with a dotfile.

### Dashboard build coupled to server
`npm run build` in the server package triggers the Vite build for the dashboard. A syntax error in a dashboard React component breaks the server build. These should be independent build targets.

---

## Summary

The architecture has grown features faster than it has decomposed responsibilities. The god classes make feature work slow and error-prone. Module boundary violations create hidden coupling. The message handler duplication is the most impactful issue — every WebSocket protocol change requires synchronized edits in two 2,000+ line files.

| Area | Rating | Priority |
|------|--------|----------|
| God classes | 2.0/5 | **High** |
| Boundary violations | 2.5/5 | **High** |
| Types & validation | 3.0/5 | Medium |
| Test gaps | 3.0/5 | Medium |
| Build / DX | 3.5/5 | Low |
