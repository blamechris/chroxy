# Operator's Audit: Local Desktop Chat Hub for Chroxy

**Agent**: Operator -- A meticulous UX designer who thinks in user journeys, not features. Mentally walks through every interaction, asking "what happens when the user does X?"
**Overall Rating**: 2.5 / 5
**Date**: 2026-02-24

---

## Section Ratings

| Section | Rating | Justification |
|---------|--------|---------------|
| First-run experience | 2/5 | No onboarding, silent failures, invisible Node 22 dependency, blank screen during startup |
| Daily workflow | 3/5 | Solid session backbone, but dashboard lacks terminal, file browser, client persistence |
| Session management UX | 3/5 | Functional tab bar with keyboard shortcuts, but missing health indicators, busy dots, notification badges |
| Error states | 2/5 | Dead-end fallback page, no reconnect backoff, no multi-client awareness in UI |
| Accessibility | 1/5 | Near-zero ARIA markup, no focus management, no keyboard tab navigation, no themes |
| Chell comparison | 2/5 | Server-side capabilities are strong, but desktop UI surfaces maybe 40% of them |

---

## Top 5 Findings

### 1. First-Run Is a Dead Screen

On first launch, the Tauri app auto-starts the server (`auto_start_server: true` in `settings.rs:9`). Server health polling runs for up to 60 seconds (`server.rs:217-243`). During this time, the user sees a static "Server Not Running" page (`dist/index.html:56-59`) -- centered gray dot, one sentence, and a code hint. No progress indicator, no "Starting server..." state, no dependency checker.

If Node 22 isn't installed, `node::resolve_node22()` fails and the user gets a system notification they might miss. The fallback page has no JavaScript -- it can't even detect when the server comes up.

**Recommendation:** Show a startup loading state with progress stages: "Resolving Node 22... Starting server... Waiting for health check..." If Node 22 is missing, show a diagnostic panel in-window (not just a system notification).

### 2. Dashboard Loses Everything on Window Close

The dashboard has zero client-side persistence. Closing and reopening loses:
- All chat messages (DOM destroyed)
- Scroll position
- Expanded/collapsed state of tool bubbles
- Permission prompt history (only last turn replayed from server)

The mobile app solved this with `persistence.ts` and `expo-secure-store`. The dashboard has nothing equivalent. For a "daily driver" desktop app, this is unacceptable -- developers expect to open the app in the morning and see yesterday's conversations.

### 3. No Terminal View

The dashboard ignores `raw` WebSocket events entirely -- terminal output goes nowhere. The mobile app has full xterm.js terminal emulation (`TerminalView.tsx`, `xterm-html.ts`). For a developer who uses Claude Code for coding tasks, not seeing what the agent is doing in the terminal is like watching a movie with half the screen blacked out.

On desktop, xterm.js can run natively (no WebView wrapper needed), making this easier to implement than on mobile.

### 4. Accessibility Is Near-Zero

The entire dashboard has exactly 2 ARIA attributes (`dashboard.js:61` -- `role="status"` on toast container, and `dashboard.js:1308` -- toast close `aria-label`).

Missing:
- No `role="log"` on chat messages container
- No `role="tablist"` / `role="tab"` / `aria-selected` on session tabs
- No `role="alertdialog"` on permission prompts
- No `aria-live` on streaming message area
- No visible focus indicators beyond browser default
- Session tabs are `div` elements, not keyboard-focusable
- No light mode / high contrast mode
- No `prefers-color-scheme` media query

A screen reader user would have a very poor experience. Keyboard-only users can send messages but cannot navigate session tabs.

### 5. Session Tab Bar Lacks Information Density

The horizontal tab bar (`dashboard.js:164-211`) shows only session name + close button per tab. Missing from the mobile app's `SessionPicker`:
- Busy/idle indicator (pulsing green dot for active sessions)
- Health indicator (red dot for crashed sessions)
- Notification badges for unread permission prompts
- Working directory display
- Model label
- Session type indicator (CLI vs PTY)

All this data is available via the WebSocket protocol (`SessionInfo` type has `isBusy`, `model`, `cwd`, `type`). The dashboard just doesn't render it.

---

## Recommendations

1. **Replace fallback page with startup loading UI.** Show progress stages during server startup. Show diagnostic panel if Node 22 is missing.
2. **Add localStorage/IndexedDB persistence.** Save messages per session, restore on window reopen. Show "Restored N messages from previous session" toast.
3. **Add xterm.js terminal view with view switcher.** Chat/Terminal/Files tabs, matching the mobile app's `viewMode` concept.
4. **Add ARIA roles and keyboard navigation.** `role="log"`, `role="tablist"`, `role="tab"`, `role="alertdialog"`, focus management, visible focus indicators. Add `prefers-color-scheme` for light mode.
5. **Enrich session tabs.** Show busy dot, health indicator, notification badge, working directory, model label per session. Consider vertical sidebar for information density.

---

## Verdict

The desktop experience is a thin UI layer over an excellent server backbone. The server-side `SessionManager` is production-grade with cost budgets, idle timeouts, state serialization, and comprehensive WS protocol. The Tauri shell handles lifecycle management well. But the dashboard that connects them was built as a debugging tool and never designed for daily use. The gap between server capabilities and UI exposure is the single biggest UX debt. A developer comparing Chroxy desktop to Chell.sh would pick Chell after 60 seconds, even though Chroxy's server is more capable. The good news: the foundation is solid, and the improvements needed are incremental, not architectural.
