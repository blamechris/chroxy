# Builder's Audit: Workspace Extraction (#2518, #2510)

**Agent**: Builder -- Pragmatic full-stack dev who will implement this
**Overall Rating**: 3.0/5
**Date**: 2026-03-19

## Methodology

Walked through both issues as if implementing them today. Counted files to move, identified every edit needed, mapped dependency chains, and estimated effort based on similar monorepo restructuring experience.

## Finding 1: #2518 File-by-File Change List

**Severity**: Informational (implementation plan)

### Files to move (~174 files)

All files under `packages/server/dashboard/` move to `packages/dashboard/`:
- `src/` directory (components, hooks, stores, utils, pages)
- `public/` directory (static assets)
- `index.html`
- `vite.config.js`
- `tsconfig.json` / `tsconfig.node.json`
- Test files (`__tests__/`, `*.test.*`)

### Files needing edits (~11 files)

| File | Change needed |
|------|--------------|
| `packages/server/src/http-routes.js` | Update `dashboardDistPath` resolution from `../dashboard/dist` to `../../dashboard/dist` or configurable |
| `packages/server/scripts/bundle-server.sh` | Update dashboard dist source path |
| `packages/desktop/src-tauri/tauri.conf.json` | Update `beforeBuildCommand` if it references dashboard path |
| `packages/desktop/vite.config.ts` | May need path alias updates |
| Root `package.json` | Add `packages/dashboard` to workspaces array |
| New `packages/dashboard/package.json` | Create with dashboard-specific deps (zustand, dompurify, xterm, etc.) |
| `.github/workflows/ci.yml` | Add dashboard build/test step |
| `.github/workflows/release.yml` | Update dashboard build references |
| `scripts/bump-version.sh` | Add dashboard package.json to version bump targets |
| `packages/server/package.json` | Remove dashboard-only dependencies |
| `packages/dashboard/package.json` | Add `@chroxy/protocol` and `@chroxy/store-core` as workspace deps |

### Critical path

1. `http-routes.js` dist resolution -- server must find dashboard dist at new path
2. `bundle-server.sh` path updates -- Tauri desktop build depends on this
3. Workspace hoisting -- dashboard deps must be accessible from new location

**Estimate**: 1.5-2 days (mechanical but tedious, high file count)

## Finding 2: #2510 File-by-File Change List

**Severity**: Informational (implementation plan)

### New files in store-core (~9 files, ~2,000 lines)

| File | Purpose | Est. lines |
|------|---------|-----------|
| `src/handlers/index.ts` | Handler registry and factory | ~150 |
| `src/handlers/auth.ts` | auth_ok, auth_error handlers | ~180 |
| `src/handlers/session.ts` | session_list, session_started, etc. | ~200 |
| `src/handlers/stream.ts` | stream_start, stream_delta, stream_end | ~250 |
| `src/handlers/tool.ts` | tool_start, tool_end, tool_result | ~200 |
| `src/handlers/permission.ts` | permission_request, permission_result | ~150 |
| `src/handlers/plan.ts` | plan_started, plan_ready, plan_approval | ~120 |
| `src/handlers/system.ts` | error, server_restart, models_updated | ~150 |
| `src/session-state.ts` | Shared SessionState type + createEmptySessionState() | ~100 |

### Files modified in app (~3 files)

- `packages/app/src/stores/connection.ts` -- Replace inline handlers with store-core imports + platform adapter
- `packages/app/src/stores/session.ts` -- Wire shared state management
- `packages/app/src/utils/message-handler.ts` -- Thin adapter calling store-core

### Files modified in dashboard (~3 files)

- `packages/dashboard/src/stores/connection-store.ts` -- Replace inline handlers with store-core imports + platform adapter
- `packages/dashboard/src/stores/session-store.ts` -- Wire shared state management
- `packages/dashboard/src/utils/ws-handler.ts` -- Thin adapter calling store-core

### The `createMessageHandler()` factory

Needs dependency injection for:
- State getter/setter (Zustand sub-stores vs monolithic store)
- Navigation (React Navigation vs browser router)
- Notifications (Expo push vs browser Notification API vs Tauri notifications)
- Storage (SecureStore vs localStorage)
- Audio (expo-av vs Web Audio API)

**Estimate**: 5-6 days (complex abstraction, significant test rewiring)

## Finding 3: Dependency Ordering Is Non-Negotiable

**Severity**: High (blocks implementation)

#2518 MUST come before #2510. Reasons:

1. Dashboard is currently inside `packages/server/`. Extracting shared code from a nested package into store-core while the source is inside another package creates circular workspace dependencies.
2. Post-#2518, both `packages/app/` and `packages/dashboard/` are peer packages that can cleanly depend on `packages/store-core/`.
3. The `http-routes.js` coupling needs resolution before store-core can own handler logic that both consumers import.

Attempting #2510 first would require temporary scaffolding that gets thrown away after #2518.

## Finding 4: App Sub-Stores vs Dashboard Monolith

**Severity**: High (architectural mismatch)

The app uses ~10 Zustand sub-stores with `useShallow` selectors:
- `connection.ts` (WebSocket state, reconnection)
- `session.ts` (active session, messages)
- `settings.ts` (user preferences)
- `terminal.ts` (xterm buffer state)
- Plus 6+ more for specific features

The dashboard uses a monolithic store pattern:
- `connection-store.ts` (everything in one store)
- `session-store.ts` (sessions + messages + UI state combined)

A `getStore()` abstraction that works for both is fundamentally different:
- App: `getStore('session').getState().messages` -- returns sub-store
- Dashboard: `getStore().getState().sessions[id].messages` -- returns slice of monolith

The adapter layer for this isn't trivial. It's not just "pass a different store" -- it's "pass a different state access pattern."

## Finding 5: Test Regression Risk

**Severity**: High (quality gate)

| Codebase | Test files | Test lines | Import rewiring needed |
|----------|-----------|------------|----------------------|
| App | 45+ | ~13,000 | Moderate (jest.mock paths change) |
| Dashboard | 88 | ~43,000* | Heavy (store mocks change shape) |

*Dashboard test line count includes generated/snapshot files.

Both test suites mock extensively:
- App: 10+ React Native module mocks in `jest.setup.js`
- Dashboard: Store mocks, WebSocket mocks, DOM mocks

Moving handlers to store-core means:
- Store-core tests must be framework-agnostic (no RN mocks, no DOM mocks)
- App/dashboard tests become integration tests (testing adapter + store-core)
- Existing snapshot tests may break if handler output shape changes

## Recommendation

Do #2518 first -- it's mechanical, well-scoped, and unblocks everything else. For #2510, start with the lowest-risk extractions: types and utilities (SessionState, createEmptySessionState, stream ID collision logic). Prove the pattern works in both consumers before attempting handler extraction. Do NOT attempt `createMessageHandler()` factory until the state architecture gap is addressed.
