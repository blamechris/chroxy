# Skeptic's Audit: Chroxy Project Status vs Competitive Action Plan

**Agent**: Skeptic -- Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 4.0 / 5
**Date**: 2026-02-21

---

## Methodology

Cross-referenced every action item in the competitive analysis roadmap against actual merged PRs, open issues, and current code. Verified claims by checking file contents, git history, and CI status. No claim taken at face value.

---

## Phase 1: Core Polish (Week 1) -- 7 Items

| # | Action Item | Status | Evidence |
|---|-------------|--------|----------|
| 1 | Permission UX: acceptEdits mode | **NOT STARTED** | Grep for `acceptEdits` across entire codebase returns zero results. Only `approve`, `auto`, and `plan` modes exist in `sdk-session.js:589` and `cli-session.js:123-125`. |
| 2 | Diff viewer for file changes | **DONE** | `ws-server.js:1149` handles `get_diff`, `ws-schemas.js:159` defines `GetDiffSchema`, `diff-parser.test.js` has tests. PR #607 issue open for app-side viewer but server plumbing exists. |
| 3 | Context window / cost display | **DONE** | `status_update` WS message with cost/tokens/percent. Collapsible settings bar in app shows model/permission/cost/context. |
| 4 | Model switching | **DONE** | `models.js` + `model_changed` WS message. Settings bar allows live switching. |
| 5 | Plan mode approval UI | **DONE** | `PlanApprovalCard` with Approve/Give Feedback. Tracks `_inPlanMode` across turns. |
| 6 | Background agent monitoring | **DONE** | `agent_spawned`/`agent_completed` events. SettingsBar badge + detail view. |
| 7 | Multi-session support | **DONE** | `session-manager.js`, `CreateSessionModal`, `SessionPicker` with horizontal scroll. |

**Phase 1 Score: 6/7 done, 1 not started (acceptEdits)**

---

## Phase 2: Reliability & Security (Week 2) -- 5 Items

| # | Action Item | Status | Evidence |
|---|-------------|--------|----------|
| 8 | E2E encryption | **DONE** | NaCl-based encryption in `ws-server.js:378-430`, ECDH key exchange, nonce counters. `crypto.test.js` covers it. |
| 9 | Reconnection resilience | **DONE** | `ConnectionPhase` state machine (`disconnected`/`connecting`/`connected`/`reconnecting`/`server_restarting`). `lastConnectedUrl` tracking. 6-attempt retry with backoff. |
| 10 | Supervisor auto-restart | **DONE** | `supervisor.js` owns tunnel, forks child, backoff 2s->10s over 10 attempts. Named tunnel mode. |
| 11 | Push notifications | **DONE** | `push.js` (PushManager) via Expo Push API. Rate-limited per category. |
| 12 | Symlink path traversal fix | **DONE** | PR #710 merged. `resolve(path)` before `startsWith` check in file browser. |

**Phase 2 Score: 5/5 done**

---

## Phase 3: UX Differentiation (Week 3) -- 3 Items

| # | Action Item | Status | Evidence |
|---|-------------|--------|----------|
| 13 | Voice input | **DONE** | `expo-speech-recognition` native module. Mic button in InputBar. Interim results. PR #503. |
| 14 | Auto-connect on launch | **PARTIAL** | Implemented at `ConnectScreen.tsx:79-98`: loads `savedConnection` from SecureStore and calls `connect()`. However, no timeout tuning -- fails silently after full retry chain (~19s). |
| 15 | Zod schema validation | **DONE** | `ws-schemas.js` with 20+ schemas. PR #712. `ws-schemas.test.js` covers validation. |

**Phase 3 Score: 2/3 done, 1 partial**

---

## Phase 4: Strategic (90-Day) -- 5 Items

| # | Action Item | Status | Evidence |
|---|-------------|--------|----------|
| 16 | Client-side persistence (AsyncStorage) | **NOT STARTED** | Issue #685 open. No AsyncStorage usage for conversation history. |
| 17 | Image/computer-use results | **NOT STARTED** | Issue #684 open. No image rendering in chat view. |
| 18 | Dynamic model list from SDK | **NOT STARTED** | Issue #686 open. Static model list in `models.js`. |
| 19 | Web client fallback | **NOT STARTED** | Issue #610 open. No web client code. |
| 20 | SQLite for session persistence | **PARTIAL** | Issue #679 open. Evaluated but not implemented. Currently JSON file persistence. |

**Phase 4 Score: 0/5 done, 1 partial, 4 not started**

---

## Stale Issues (Should Be Closed)

These issues have been resolved by merged PRs but remain open:

| Issue | Title | Resolved By |
|-------|-------|-------------|
| #662 | fix(server): resolve symlinks in file browser path traversal checks | PR #710 merged |
| #663 | test(server): add tests for browse_files and read_file WS handlers | PR #708 merged |
| #713 | docs: update WS protocol reference with missing client message types | Partially addressed by PR #712 (Zod schemas document all types) |
| #716 | feat(server): detect and skip binary files in untracked file previews | Labeled `from-review`, may be stale if untracked preview was scoped down |
| #665 | perf(app): memoize syntax tokenization in file viewer | Low-priority optimization, no activity |

---

## Scope Drift Analysis

The project has **two competing roadmaps**:
1. **Competitive analysis roadmap** (docs/competitive/) -- the source of the 20 action items above
2. **In-app-dev roadmap** (memory/roadmap.md) -- a separate internal tracking doc

These overlap but are not identical. The competitive roadmap is more ambitious (web client, Codex provider, MCP awareness). The in-app-dev roadmap is more tactical. Neither has been formally reconciled.

**29 open issues** remain in the tracker. Of these:
- 5 are stale (see above)
- 14 are roadmap features tagged `roadmap` (mostly 90-day items)
- 3 are audit findings (`audit-finding` label)
- The rest are low-priority enhancements

---

## Missing Work Not in Any Roadmap

1. **acceptEdits permission mode** -- mentioned in competitive analysis Phase 1 but never implemented. No issue exists for it.
2. **push.js has zero test coverage** -- `push.js` is referenced in `server-cli.js` but no `push.test.js` exists anywhere.
3. **App has zero component tests** -- all 243 app tests are utility/store tests. No screen or component rendering tests.
4. **ws-server.js is 2,691 lines** -- a god object handling auth, encryption, routing, session management, file browsing, diffs, and history replay. No decomposition plan exists.

---

## Scorecard Summary

| Phase | Items | Done | Partial | Not Started |
|-------|-------|------|---------|-------------|
| Phase 1: Core Polish | 7 | 6 | 0 | 1 |
| Phase 2: Reliability | 5 | 5 | 0 | 0 |
| Phase 3: UX | 3 | 2 | 1 | 0 |
| Phase 4: Strategic | 5 | 0 | 1 | 4 |
| **Total** | **20** | **13** | **2** | **5** |

Excluding the 90-day Phase 4 items: **13/15 items done in ~3 weeks**. That is genuinely impressive execution velocity.

---

## Top 5 Recommendations

1. **Close the 5 stale issues** -- they create false urgency and clutter the backlog. 10 minutes of work.

2. **Implement acceptEdits permission mode** -- it is the only Phase 1 item not done. The server plumbing (`permissionMode` switch in `sdk-session.js:576-600`) already supports it; the mode just needs to be wired as a fourth option alongside approve/auto/plan.

3. **Reconcile the two roadmaps into one** -- having two competing priority lists causes confusion. Pick the competitive roadmap as canonical and fold in-app-dev items into it.

4. **Add push.js tests** -- this is a production notification system with rate limiting logic that has zero test coverage. It is the biggest coverage gap.

5. **Plan the ws-server.js decomposition** -- at 2,691 lines, this file is the single biggest maintenance risk. Even splitting out the message handler `switch` into a separate router module would help significantly.
