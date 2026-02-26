# Skeptic's Audit: Chroxy Codebase Re-Baseline

**Agent**: Skeptic — Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-26

---

## Section Ratings

| Area | Rating | Notes |
|------|--------|-------|
| Server | 4/5 | Solid core, but dead code and schema gaps undermine confidence |
| App | 4/5 | Well-structured TypeScript, but new monolith forming in message-handler |
| Desktop | 3/5 | Dashboard is a single 2768-line template string — fragile and hard to test |
| WS Protocol | 3/5 | Schema validation exists but is incomplete; new message types bypass it entirely |
| Testing | 4/5 | Good coverage where tests exist, but critical new features have zero coverage |
| Security | 4/5 | Auth model is sound; token rotation broadcast and missing CSP are concerns |
| CI/CD | 4/5 | GitHub Actions pipeline works well; lint and type checks catch regressions |
| Documentation | 2/5 | reference.md is significantly stale — missing 9+ server types and 8+ app files |

---

## Top 5 Findings

### 1. CRITICAL: list_conversations and resume_conversation Bypass ClientMessageSchema

**Severity**: Critical
**Status**: Broken in production

The `list_conversations` and `resume_conversation` message types are handled in `ws-message-handlers.js` (lines 427-473), but they are **never reachable**. The `ClientMessageSchema` Zod discriminated union in `ws-schemas.js` (lines 432-463) does not include either type. When the app sends these messages, they fail `safeParse` validation in `ws-server.js` (lines 969-976), which rejects all unknown types before dispatch.

**Evidence**:
- `ws-schemas.js:432-463` — `ClientMessageSchema` union lists all valid types; neither `list_conversations` nor `resume_conversation` is present
- `ws-server.js:969-976` — parse failure path returns an error to the client and short-circuits
- `ws-message-handlers.js:427-473` — handler code exists but is dead code; never executed

**Impact**: The conversation history feature advertised in v0.2.0 is completely non-functional over WebSocket. The app can render the HistoryScreen UI but receives no data.

**Recommendation**: Add both message types to the `ClientMessageSchema` Zod union. Add integration tests that verify round-trip message flow from client send through schema validation to handler dispatch and response.

---

### 2. acceptEdits Missing from Dashboard Permission Select

**Severity**: Medium
**Status**: Fix in progress (PR #935)

The dashboard's permission mode dropdown (`dashboard.js:31-35`) hardcodes the available options but omits `acceptEdits`, which is a valid permission mode supported by the server and the mobile app. Users on the web dashboard cannot select this mode.

**Evidence**:
- `dashboard.js:31-35` — `<select>` element lists modes but omits `acceptEdits`
- `sdk-session.js` — `setPermissionMode` accepts `acceptEdits` as a valid value

**Impact**: Dashboard users have fewer permission controls than mobile app users.

**Recommendation**: PR #935 addresses this. Merge it.

---

### 3. Conversation Scanner Cache Has Cross-projectsDir Race

**Severity**: Medium
**Status**: Open

The conversation scanner's caching logic (`conversation-scanner.js:217-229`) tracks a `_pendingScan` promise to avoid duplicate scans, but it does not key this promise by `projectsDir`. If two requests arrive for different project directories while a scan is in flight, the second request may receive cached results from the wrong directory.

**Evidence**:
- `conversation-scanner.js:217-229` — `_pendingScan` is a single promise, not a map keyed by directory
- No guard checks whether the pending scan's `projectsDir` matches the new request

**Impact**: In multi-project setups, conversation lists could briefly show conversations from the wrong project.

**Recommendation**: Key `_pendingScan` by `projectsDir` (e.g., use a `Map<string, Promise>`), or invalidate the pending scan when the directory changes.

---

### 4. conversationHistoryLoading Spinner Has No Timeout

**Severity**: Medium
**Status**: Open

The Zustand store sets `conversationHistoryLoading = true` when the app sends a `list_conversations` request (`connection.ts:1029-1037`), but this flag is only cleared when a `conversations_list` response arrives. If the server never responds (e.g., due to Finding #1 above, or a network drop), the loading spinner persists indefinitely.

**Evidence**:
- `connection.ts:1029-1037` — `set({ conversationHistoryLoading: true })` with no corresponding timeout or error fallback
- No `setTimeout` or `AbortController` wrapping the request

**Impact**: Users see an infinite spinner on the HistoryScreen with no way to recover except navigating away.

**Recommendation**: Add a timeout (e.g., 10 seconds) that clears the loading state and shows an error message. Consider a retry button.

---

### 5. reference.md Is Missing 9+ Server Message Types and 8+ App Files

**Severity**: Low (documentation)
**Status**: Open

`docs/architecture/reference.md` has not been updated to reflect recent additions. At minimum, the following are missing:

**Server message types not documented**:
- `conversations_list`, `conversation_resumed`, `plan_started`, `plan_ready`, `models_updated`, `cost_update`, `budget_status`, `background_agents`, `agent_monitoring`

**App files not documented**:
- `message-handler.ts`, `HistoryScreen.tsx`, `VoiceInput.tsx`, `BiometricLock.tsx`, `OnboardingScreen.tsx`, `CostBudgetCard.tsx`, `AgentMonitor.tsx`, `ConversationSearch.tsx`

**Evidence**: Direct comparison of the file listing in reference.md against `ls packages/server/src/` and `ls packages/app/src/`

**Impact**: New contributors and audit agents cannot rely on reference.md as a source of truth.

**Recommendation**: Update reference.md or automate its generation from the codebase.

---

## Verdict

Chroxy's core server and app are competently built — the WebSocket protocol, auth model, and session management all work as advertised for the primary use case. But the codebase has accumulated dead code, schema gaps, and documentation drift that erode trust in newer features. The conversation history feature (Finding #1) is the most pressing issue: it shipped with UI on both app and dashboard but the server-side message path is broken at the schema validation layer. The documentation gap (Finding #5) is less urgent but compounds every other problem — you cannot audit what you cannot find. Fix the schema, delete or isolate the dead code, and update the docs before adding more features.
