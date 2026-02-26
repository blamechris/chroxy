# Builder's Audit: Chroxy Codebase Re-Baseline

**Agent**: Builder — Pragmatic architect focused on code health, maintainability, and sustainable growth
**Overall Rating**: 3.8 / 5
**Date**: 2026-02-26

---

## Section Ratings

| Area | Rating | Notes |
|------|--------|-------|
| Server | 4/5 | Clean ES module architecture, but dead code and growing file sizes need attention |
| App | 3.5/5 | TypeScript + Zustand is solid, but message-handler.ts is becoming a monolith |
| Desktop | 3/5 | Functional but dashboard.js is a maintenance hazard |
| WS Protocol | 4/5 | Well-designed schema-first approach, schema just needs to stay current |
| Testing | 4/5 | Good patterns established, coverage gaps are known and bounded |
| Security | 4/5 | Fundamentals are right — E2E encryption, token auth, tunnel security |
| CI/CD | 4.5/5 | Solid pipeline with lint, type checks, and release automation |
| Documentation | 3/5 | CLAUDE.md is excellent; reference.md has fallen behind |

---

## Top 5 Findings

### 1. session-db.js Is Dead Code (579 Lines + Native Dependency)

**Severity**: High
**Status**: Open

`packages/server/src/session-db.js` is a 579-line SQLite-backed session persistence layer that has **zero production callers**. It imports `better-sqlite3`, a native addon that requires compilation during `npm install`. The module defines a full CRUD interface for sessions, messages, and conversation metadata, but nothing in the application imports it.

**Evidence**:
- `session-db.js` — 579 lines, exports `SessionDB` class
- `package.json` — `better-sqlite3` listed as a dependency, pulled in during install
- Grep for `session-db` or `SessionDB` across `packages/server/src/` — zero import statements outside of test files
- The file appears to be a prototype from a planned persistence feature that was never wired up

**Impact**: Adds ~2MB of native binaries to every install for no runtime benefit. Increases attack surface. Confuses contributors who assume it is used.

**Recommendation**: Remove `session-db.js` and `better-sqlite3` from dependencies. If the persistence feature is planned for a future release, move it to a feature branch.

---

### 2. message-handler.ts Is a New 1906-Line Monolith

**Severity**: High
**Status**: Open

`packages/app/src/message-handler.ts` has grown to 1906 lines. It handles 67 distinct message types in a single file with a large switch statement (or equivalent dispatch). The file mixes parsing logic, state mutations, side effects (notifications, navigation), and error handling.

**Evidence**:
- `message-handler.ts` — 1906 lines, single default export
- Handles message types including: `assistant`, `tool_use`, `tool_result`, `permission_request`, `plan_started`, `plan_ready`, `cost_update`, `models_updated`, `background_agents`, and 58 more
- Deeply coupled to the Zustand store — directly calls `set()` and `get()` throughout

**Impact**: Any change to message handling risks regressions across unrelated features. Testing requires mocking the entire store. New contributors face a steep learning curve.

**Recommendation**: Extract message handlers into per-category modules (e.g., `handlers/session.ts`, `handlers/plan.ts`, `handlers/cost.ts`). Use a registry pattern to dispatch by type. Each handler should be independently testable.

---

### 3. SdkSession planMode:false Has No User-Visible Capability Gate

**Severity**: Medium
**Status**: Open

When the Claude Code SDK reports `planMode: false` (i.e., plan mode is not available for the current model or configuration), `SdkSession` stores this internally but does not propagate it to clients. The app's plan mode UI (PlanApprovalCard, plan toggle) remains visible and interactive even when plan mode cannot work.

**Evidence**:
- `sdk-session.js` — stores `_planModeAvailable` but does not emit a capability message
- `PlanApprovalCard.tsx` — renders unconditionally based on `plan_started` events
- No `capabilities` or `plan_mode_available` message type in the WS protocol

**Impact**: Users can see plan mode UI elements that do nothing when plan mode is unavailable, creating confusion.

**Recommendation**: Add a `capabilities` message to the WS protocol that communicates feature availability. Gate plan mode UI on this capability.

---

### 4. dashboard.js Is a 2768-Line HTML Template String

**Severity**: High
**Status**: Open

`packages/server/src/dashboard.js` generates the entire web dashboard as a single JavaScript template literal string containing HTML, CSS, and JavaScript. At 2768 lines, it is the largest file in the server package.

**Evidence**:
- `dashboard.js` — single `export function generateDashboard()` returning a template string
- Contains inline `<style>` (400+ lines), `<script>` (1800+ lines), and HTML structure
- No syntax highlighting, no linting, no type checking for the embedded JS/CSS
- No hot reload — every change requires a server restart

**Impact**: Bugs in the embedded JavaScript are invisible to ESLint and CI. CSS changes require searching through a massive string. No component reuse is possible.

**Recommendation**: Extract the dashboard into a proper frontend build (even a simple Vite or esbuild setup). Serve the built assets statically. This enables linting, type checking, component splitting, and hot reload during development.

---

### 5. CliSession/SdkSession Feature Divergence with No Migration Path

**Severity**: Medium
**Status**: Open

`CliSession` (legacy `claude -p` subprocess) and `SdkSession` (Agent SDK) both implement the session interface but have diverged significantly in feature support. SdkSession supports plan mode, model switching, background agents, cost tracking, and dynamic model lists. CliSession supports none of these.

**Evidence**:
- `sdk-session.js` — implements `setModel()`, `setPlanMode()`, emits `plan_started`, `cost_update`, `models_updated`
- `cli-session.js` — no-ops or throws for `setModel()`, no plan mode support
- `providers.js` — both registered as valid providers with no feature-flag distinction
- No deprecation notice or migration timeline for CliSession

**Impact**: Users on CliSession silently lack features. The server must maintain two code paths indefinitely. Test matrix doubles.

**Recommendation**: Deprecate CliSession with a clear timeline. Add a startup warning when CliSession is selected. Document the migration path to SdkSession. Consider removing CliSession in v0.3.0.

---

## Verdict

Chroxy's architecture is fundamentally sound — the monorepo structure, ES module server, TypeScript app, and schema-driven WebSocket protocol are good choices that have scaled well to v0.2.0. The main concern is accumulation: dead code that was never cleaned up (session-db.js), files that grew past their natural boundaries (message-handler.ts, dashboard.js), and feature divergence between session providers that will only widen. None of these are crises, but they compound. Each new feature added on top of these foundations costs more than it should. A focused cleanup sprint — remove dead code, split the monoliths, deprecate the legacy provider — would restore the codebase to a state where the next round of features can land cleanly.
