# Minimalist's Audit: Chroxy Codebase Re-Baseline

**Agent**: Minimalist — Ruthless complexity hunter who measures value per line of code
**Overall Rating**: 2.5 / 5
**Date**: 2026-02-26

---

## Section Ratings

| Area | Rating | Notes |
|------|--------|-------|
| Server | 3/5 | Functional but carrying significant dead weight |
| App | 3/5 | TypeScript helps, but message-handler.ts is a growing liability |
| Desktop | 2/5 | 2768-line template string is the antithesis of maintainability |
| WS Protocol | 2.5/5 | Over-specified schema with minimal runtime utility |
| Testing | 2.5/5 | 6.3:1 test-to-code ratio in ws-server.test.js is a maintenance burden |
| Security | 3.5/5 | Lean where it counts — token auth, E2E encryption |
| CI/CD | 4/5 | Appropriately minimal pipeline |
| Documentation | 2/5 | reference.md adds maintenance cost without staying current |

---

## Top 5 Findings

### 1. dashboard.js: 2768-Line HTML Template String Monolith

**Severity**: High
**Status**: Open

`packages/server/src/dashboard.js` is a single function that returns a 2768-line JavaScript template literal containing the entire web dashboard — HTML structure, CSS styles, and JavaScript application logic.

**Evidence**:
- `dashboard.js` — `export function generateDashboard(token)` returns one template string
- ~400 lines of CSS, ~1800 lines of JavaScript, ~500 lines of HTML, all inlined
- Zero linting coverage on embedded JS/CSS (ESLint cannot parse template string contents)
- No syntax highlighting in editors (treated as a string, not as HTML/JS/CSS)
- Every dashboard change requires finding the right spot in a 2768-line string

**Cost analysis**: This file has the worst maintainability-to-value ratio in the codebase. It cannot be tested, linted, or split. It will only grow.

**Recommendation**: Extract to a minimal static frontend build. Even a single `index.html` + `script.js` + `style.css` served statically would be a massive improvement. No framework needed — just file separation.

---

### 2. ws-schemas.js: 463 Lines of Schema with Only 4 Runtime Callers

**Severity**: Medium
**Status**: Open

`packages/server/src/ws-schemas.js` defines 463 lines of Zod schemas covering every client and server message type. However, only 4 call sites in the entire codebase actually invoke these schemas at runtime:

1. `ws-server.js` — `ClientMessageSchema.safeParse()` on incoming messages
2. `ws-server.js` — `ServerMessageSchema.safeParse()` on outgoing messages (dev mode only)
3. Two test files that validate message shapes

**Evidence**:
- `ws-schemas.js` — 463 lines defining ~30 message type schemas
- Grep for `safeParse` and `parse` referencing these schemas — 4 call sites
- Server-side outgoing validation is dev-mode only (`if (process.env.NODE_ENV === 'development')`)
- In production, only inbound client messages are validated

**Cost analysis**: 463 lines of schema maintained in sync with two separate codebases (server handlers + app message-handler.ts) for the benefit of a single `safeParse` call. And as Finding #1 from the Skeptic shows, the schema is already out of sync — `list_conversations` and `resume_conversation` are missing.

**Recommendation**: Either commit to the schema fully (validate all outgoing messages in production, generate TypeScript types from Zod schemas for the app) or simplify to a lightweight validation approach. The current middle ground gives the maintenance cost of a schema without the safety benefits.

---

### 3. codex-session.js: 555 Lines of Speculative Provider Code

**Severity**: Medium
**Status**: Open

`packages/server/src/codex-session.js` is a 555-line session provider for OpenAI's Codex CLI. It is registered in `providers.js` but has no test coverage, no documentation, and no evidence of production use.

**Evidence**:
- `codex-session.js` — 555 lines implementing the session interface for Codex
- `providers.js` — registered as `codex` provider
- Zero test files for codex-session
- No mention in CLAUDE.md, setup guides, or user-facing documentation
- Codex CLI itself has uncertain long-term support from OpenAI

**Cost analysis**: 555 lines of untested code for a provider that is not documented and may never be used. Every change to the session interface requires updating this file to maintain compatibility (or accepting silent divergence).

**Recommendation**: Remove from the main branch. If there is user demand for Codex support, develop it on a feature branch with tests and documentation before merging.

---

### 4. ws-server.test.js: 7758 Lines at a 6.3:1 Test-to-Code Ratio

**Severity**: Medium
**Status**: Open

`packages/server/tests/ws-server.test.js` is 7758 lines long — over 6 times the size of the code it tests. The file contains extensive setup/teardown boilerplate repeated across test cases, deeply nested describe blocks, and verbose mock configurations.

**Evidence**:
- `ws-server.test.js` — 7758 lines
- `ws-server.js` — ~1230 lines (6.3:1 ratio)
- Many tests duplicate setup code instead of using shared fixtures
- Some tests verify internal implementation details rather than observable behavior

**Cost analysis**: At this ratio, maintaining the tests is more expensive than maintaining the code. Test changes often take longer than feature changes. The file is too large to navigate efficiently.

**Recommendation**: Extract shared setup into test helpers (some already exist in `test-helpers.js` but are underused). Split into focused test files by concern: `ws-server-auth.test.js`, `ws-server-session.test.js`, `ws-server-protocol.test.js`. Remove tests that verify implementation details. Target a 2:1 ratio.

---

### 5. mode WS Message Is Dead State

**Severity**: Low
**Status**: Open

The `mode` WebSocket message type is defined in schemas, handled in the server, and processed in the app, but it corresponds to no user-visible state or behavior change. It appears to be a remnant of an earlier design where "mode" switching (e.g., between chat and plan mode) was a distinct concept, before plan mode got its own dedicated message types (`plan_started`, `plan_ready`).

**Evidence**:
- `ws-schemas.js` — `mode` type defined in both client and server schemas
- `ws-message-handlers.js` — handler exists, sets an internal flag
- `message-handler.ts` — processes `mode` messages, updates store
- No UI element reads or displays the mode state in a way that differs from plan mode
- Plan mode has its own dedicated messages that supersede this

**Cost analysis**: Small per-file impact but adds noise to every audit, every schema review, and every "what does this do?" investigation.

**Recommendation**: Remove the `mode` message type from schemas, handlers, and the app. If a future use case arises, add it back with clear semantics.

---

## Verdict

Chroxy has accumulated complexity faster than it has shed it. The project works — the core session flow, WebSocket protocol, and mobile app are functional and reasonably well-built. But for a codebase at v0.2.0, there is a surprising amount of dead weight: a 579-line unused database module, a 555-line speculative provider, a 463-line schema with 4 callers, and a 7758-line test file. The dashboard is a 2768-line string that cannot be linted or tested. Every one of these represents ongoing maintenance cost with diminishing returns. The most impactful improvement would not be adding features — it would be removing code. Delete session-db.js, delete codex-session.js, extract the dashboard, split the test monolith. The codebase would be smaller, faster to navigate, and cheaper to change.
