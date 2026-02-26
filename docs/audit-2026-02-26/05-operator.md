# Operator's Audit: Chroxy Codebase Re-Baseline

**Agent**: Operator — User experience advocate who evaluates every feature from the end user's perspective
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-26

---

## Section Ratings

| Area | Rating | Notes |
|------|--------|-------|
| Server | 4/5 | Reliable session management; user-facing issues are app-side |
| App | 3.5/5 | Good dual-view design; several empty states and feedback gaps |
| Desktop | 3/5 | Dashboard works but lacks polish — missing permission option, no loading states |
| WS Protocol | 3.5/5 | Protocol supports the UX well when it works; broken features are invisible |
| Testing | 3/5 | No E2E coverage for user-facing flows like history and LAN scan |
| Security | 4/5 | Biometric lock and E2E encryption are user-visible security wins |
| CI/CD | 4/5 | Fast feedback loop keeps the app stable for users |
| Documentation | 3.5/5 | Setup guides are clear; operational troubleshooting is sparse |

---

## Top 5 Findings

### 1. Queued Messages Provide No In-App Feedback

**Severity**: High
**Status**: Open

When the user sends a message while the server is processing a previous request, the message is queued internally. The app provides no visual indication that the message was queued rather than sent. From the user's perspective, they typed a message, hit send, and nothing happened.

**Evidence**:
- `connection.ts` — `sendMessage()` adds to an internal queue when a response is in flight
- No toast, badge, or inline indicator shows "message queued" state
- The message appears in the chat view as if it was sent, but no response arrives until the current turn completes
- Users have no way to distinguish "queued" from "lost" or "ignored"

**Impact**: Users may resend messages (creating duplicates), assume the app is broken, or lose trust in the send action.

**Recommendation**: Add a subtle visual indicator for queued messages — e.g., a clock icon or "Queued" label on the message bubble. Show a brief toast: "Message queued — will send after current response." Consider showing queue position if multiple messages are queued.

---

### 2. LAN Scan Empty State Is Missing

**Severity**: Medium
**Status**: Open

The LAN scan feature on the ConnectScreen triggers a scan for local Chroxy servers. If no servers are found, the UI shows nothing — no "No servers found" message, no troubleshooting hints, no suggestion to try manual entry.

**Evidence**:
- `ConnectScreen.tsx` — LAN scan results render as a list; empty list renders nothing
- No conditional rendering for the zero-results case
- Maestro flow `lan-scan.yaml` verifies the scanning state (spinner) but not the empty result state

**Impact**: Users who tap "Scan LAN" and find nothing have no guidance on what to do next. They may not realize they need to ensure their phone and server are on the same network, or that the server needs to be running.

**Recommendation**: Add an empty state component: "No servers found on your network. Make sure your Chroxy server is running and your phone is on the same Wi-Fi network." Include a "Try Manual Entry" button.

---

### 3. HistoryScreen Is a Dead End for New Users

**Severity**: Medium
**Status**: Open

The HistoryScreen (conversation history) is accessible from the navigation, but for new users with no conversation history, it shows a loading spinner that never resolves (due to the schema validation bug) or an empty list with no guidance.

Even with the schema bug fixed, new users who have never used Claude Code locally will have no conversations to show. The screen provides no explanation of what conversation history is, where it comes from, or how to create entries.

**Evidence**:
- `HistoryScreen.tsx` — renders a FlatList of conversations; empty list has no empty state
- No onboarding text explaining that conversations come from local Claude Code usage
- Combined with the schema bug (Finding #1 from Skeptic), the screen is doubly broken

**Impact**: New users navigate to the History tab, see nothing useful, and may be confused about the feature's purpose.

**Recommendation**: Add an empty state: "No conversations yet. Conversation history shows your previous Claude Code sessions from this machine. Start a new session to see it here." Include an illustration or icon to make the empty state feel intentional.

---

### 4. Dashboard Permission Select Is Missing acceptEdits Option

**Severity**: Medium
**Status**: Fix in progress (PR #935)

The web dashboard's permission mode dropdown omits the `acceptEdits` option, which allows Claude to make file edits without prompting for each one. This is a commonly used mode that is available in the mobile app but not on the dashboard.

**Evidence**:
- `dashboard.js:31-35` — `<select>` element lists: `default`, `plan`, `bypassPermissions` but not `acceptEdits`
- Mobile app's SettingsScreen includes `acceptEdits` in its permission picker
- PR #935 has been opened to fix this

**Impact**: Dashboard users who want to allow file edits must either switch to the mobile app or use the CLI directly.

**Recommendation**: Merge PR #935. Ensure the permission options are derived from a shared constant rather than hardcoded in two places.

---

### 5. Auto-Connect Failure Is Silent for 19 Seconds

**Severity**: Medium
**Status**: Open

When the app attempts to auto-connect to a previously saved server on launch, the retry logic makes 6 attempts with increasing delays (1s, 2s, 3s, 5s, 8s). During this time, the user sees a "Connecting..." state with no progress indicator, no retry count, and no option to cancel or switch to manual entry.

The total wait time before the app gives up is approximately 19 seconds. During this entire period, the user has no feedback about what is happening or how long they will wait.

**Evidence**:
- `connection.ts` — auto-connect retry logic with delays: `[1000, 2000, 3000, 5000, 8000]`
- `ConnectScreen.tsx` — shows "Connecting..." text during auto-connect with no progress detail
- No "Cancel" button visible during auto-connect attempts
- No "Attempt 3 of 6" or similar progress indicator

**Impact**: Users whose server is down or unreachable stare at "Connecting..." for 19 seconds before they can do anything. This feels like the app is frozen.

**Recommendation**: Show retry progress: "Connecting... (attempt 3 of 6)". Add a "Cancel" button that immediately stops retries and returns to the manual connect screen. Consider reducing the total retry time or showing a "Server appears to be offline" message after 3 failed attempts with an option to keep trying.

---

## Verdict

Chroxy's core user experience — connecting to a server, chatting with Claude, viewing terminal output — works well. The dual-view design, markdown rendering, and plan approval UI are thoughtful and functional. The gaps are in the edges: what happens when things are empty, slow, or broken. Queued messages are invisible, LAN scan shows nothing on failure, the history screen is a dead end, and auto-connect makes users wait 19 seconds with no feedback. These are not hard problems to solve — each is a matter of adding appropriate empty states, loading indicators, and user feedback. A UX polish pass addressing these five findings would make the app feel significantly more professional and trustworthy, especially for first-time users.
