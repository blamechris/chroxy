# Futurist's Audit: Chroxy v0.6.0 Tech Debt

**Agent**: Futurist
**Overall Rating**: 3.0/5
**Date**: 2026-03-18

## Perspective

The Futurist examines the codebase for trajectory — where is the debt headed? What will hurt more next month than it does today? Asks: *what gets worse with every feature?*

---

## 1. Debt Trajectory: Message Handler Fork (1.5/5)

### Super-linear divergence
The message handler duplication is not static debt — it is actively worsening. Each new feature accelerates divergence:

- **v0.3.0**: Dashboard added enriched tabs, app did not. Dashboard handler grew `handleEnrichedTab()` (47 lines) with no app counterpart.
- **v0.4.0**: App added plan mode detection, dashboard did not. App handler grew `handlePlanMode()` (63 lines) with no dashboard counterpart.
- **v0.5.0**: Both added agent monitoring — independently. Different state shapes, different update logic, different edge cases handled.
- **v0.6.0**: Environment management added to both — again independently. Dashboard handler knows about Docker state; app handler knows about container status polling.

**Projection**: At current trajectory, the handlers will share less than 50% of their code by v0.8.0. At that point, extraction becomes a multi-week project rather than the multi-day project it is today.

### Cost of delay
Every sprint that passes without extraction:
- Doubles the merge conflict surface when extraction finally happens
- Introduces new platform-specific branches that must be reconciled
- Risks subtle behavioral differences that users experience as bugs

---

## 2. Architecture Bottleneck: WsServer (2.5/5)

### Still a god object
Despite prior extractions (WsPermissions, file-ops split), `ws-server.js` at 1,145 lines remains the central routing point for all WebSocket communication. Adding any new message type requires modifying WsServer. This is the bottleneck for parallel feature development — two developers working on different features will conflict in WsServer.

### Missing handler registration pattern
The message handler registry (`ws-message-handlers.js`) was a step in the right direction but stopped short. WsServer still manually dispatches to specific handler functions rather than using a plugin or middleware pattern. A handler registration system would allow new features to be added without modifying WsServer.

---

## 3. Missing Package Boundaries (2.5/5)

### No @chroxy/message-handler
The most obvious missing package. Shared message parsing, state management, and protocol types belong in a workspace package that both app and dashboard depend on.

### Dashboard inside server package
`packages/server/src/dashboard-next/` is a full React application living inside the server package. It has its own `tsconfig.json`, its own Vite config, its own `src/` tree with components, stores, and types. It should be `packages/dashboard/` — a first-class workspace member with its own `package.json`.

### Wire types split across 5 locations
Protocol message types are defined in 5 different places (see Builder report). A `@chroxy/protocol` package would be the single source of truth. Both app and dashboard would import types from it. The server would validate messages against it.

---

## 4. Scaling Concerns (3.5/5)

### Synchronous git operations block event loop
`environment-manager.js` and `session-manager.js` perform synchronous file I/O for state persistence (`writeFileSync`). With multiple concurrent sessions, these synchronous writes block the event loop and create latency spikes for all connected clients.

**Current impact**: Negligible with 1-3 sessions. Becomes noticeable at 5+ concurrent sessions.

### Session state serialization
`session-manager.js` serializes the entire session state map on every state change. As session history grows (long conversations), this serialization becomes expensive. No incremental update mechanism exists.

### No connection pooling for Docker
Each environment operation creates a new Docker CLI subprocess. With many environments, this creates process churn. A Docker API client (dockerode) with connection pooling would be more efficient, though this is a lower priority than the correctness issues.

---

## 5. Migration Surface (3.5/5)

### TypeScript migration is tractable
The server codebase (plain JS, ES modules) could be incrementally migrated to TypeScript. The module structure is clean enough that `allowJs: true` with gradual `.js` -> `.ts` conversion would work. The dashboard is already TypeScript, which means the tooling is in place.

Priority files for TS migration (highest bug-prevention value):
1. `ws-server.js` — most complex message dispatch
2. `session-manager.js` — most complex state management
3. `environment-manager.js` — Docker operations with many failure modes

### Protocol package foundation
`ws-schemas.js` (105 lines) contains the seed of a protocol package. The schemas define message shapes that could become TypeScript interfaces. Extracting these into `@chroxy/protocol` would be a good first step toward both the shared message handler and TypeScript migration.

---

## Summary

The most important insight from a trajectory perspective: **the message handler duplication is getting worse, not just existing.** Every feature that touches the WebSocket protocol adds new divergence. The cost of extraction is growing linearly with time. The current window — where the handlers still share ~80% of their code — is the cheapest it will ever be.

The WsServer god object and missing package boundaries are the architectural constraints that make feature development slow. They don't cause bugs directly, but they increase the time and risk of every change.

| Area | Rating | Trajectory |
|------|--------|------------|
| Message handler fork | 1.5/5 | Worsening rapidly |
| WsServer bottleneck | 2.5/5 | Worsening slowly |
| Package boundaries | 2.5/5 | Static |
| Scaling | 3.5/5 | Adequate for now |
| Migration surface | 3.5/5 | Favorable |
