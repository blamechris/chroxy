# Skeptic Audit: Desktop Vision Implementation Plan

**Rating: 4/5** -- The plan is well-grounded in real code, the phase structure is sound, and the vision is achievable. However, several estimates are optimistic, a few non-trivial gaps exist in the plan, and some claimed bugs need clarification. The deductions come from: (1) underestimating the React migration scope, (2) missing the `subscribe_sessions` server-side implementation complexity, and (3) omitting critical UX edge cases in multi-tab lifecycle management.

---

## Phase 0: Security + Critical Bugs

### Claim-by-claim verification

**1. "Fix `config.json` permissions (0o600)" -- 15 min**

VERIFIED. `writeFileRestricted()` in `packages/server/src/platform.js:12-18` already uses `0o600` for all writes via `writeFileSync` + `chmodSync`. Every call site that writes config files (`cli.js:86`, `cli.js:393`, `server-cli.js:151`, `connection-info.js:17`, `session-manager.js:334`) uses `writeFileRestricted()`. However, the settings file written by the Tauri desktop app at `packages/desktop/src-tauri/src/settings.rs:84` uses `fs::write()` directly, which does NOT set `0o600` permissions. The plan flags `settings.json` separately but should specify this is the **Rust-side** settings write, not the Node-side one. The Node side is already fixed.

**Estimate accuracy:** 15 min is realistic for the Rust fix. The Node side is already correct.

**2. "Remove token from HTML/URL rendering" -- 2-4 hours**

VERIFIED. Token is embedded in the HTML page source at `packages/server/src/dashboard.js:138`:
```js
token: ${apiToken ? JSON.stringify(apiToken).replace(/</g, '\\u003c') : '""'},
```
And in the URL at `packages/desktop/src-tauri/src/window.rs:26`:
```rust
format!("http://localhost:{}/dashboard?token={}", port, url_encode(t))
```
And in CLI output at `packages/server/src/server-cli.js:216,302,326` and `supervisor.js:209`.

This is more nuanced than "remove it." The token in HTML is used by `dashboard-app.js:7` (`var token = config.token`) for WebSocket authentication. You cannot simply remove it without providing an alternative auth mechanism for the dashboard. Options: session cookies, HTTP-only cookie set during dashboard load, or Tauri IPC bridge for the token. The 2-4 hour estimate is tight if you need to implement cookie-based auth as a replacement.

**Estimate accuracy:** 2-4 hours is realistic IF you go with cookie-based auth. If you try to keep the dashboard working in both Tauri WebView and standalone browser, the complexity doubles.

**3. "Add `safeTokenCompare` tests" -- 20 min**

VERIFIED. `safeTokenCompare` at `packages/server/src/crypto.js:115` is used in `ws-server.js:309` and `token-manager.js:78-79`. No tests found for it. The function is straightforward (padding + timingSafeEqual), 20 min is accurate.

**4. "Fix `_broadcastToSession` session filtering" -- 4-8 hours**

NEEDS CLARIFICATION. Looking at the actual implementation at `packages/server/src/ws-server.js:1038-1045`:

```js
_broadcastToSession(sessionId, message, filter = () => true) {
    const tagged = { ...message, sessionId }
    for (const [ws, client] of this.clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        this._send(ws, tagged)
      }
    }
  }
```

This sends to ALL authenticated clients, not just those viewing the session. The `filter` callback defaults to `() => true`, meaning every client gets every session's messages. This IS the bug: a client viewing session A receives broadcast messages from session B. However, calling this a "messages going to wrong sessions" bug is slightly misleading. The messages ARE tagged with `sessionId`, so well-behaved clients can filter on the client side. The mobile app already does this via its `activeSessionId` filtering.

The real risk is: (a) unnecessary bandwidth (sending all session data to all clients), and (b) information leakage if you add multi-tenant support later. For the current single-user model, it is a waste rather than a security vulnerability.

**Fix options:**
- Quick fix (1-2 hours): Filter by `client.activeSessionId === sessionId` in the default filter. This breaks if a client should receive events from non-active sessions (the `subscribe_sessions` future feature).
- Proper fix (4-8 hours as estimated): Add a `subscribedSessions` set to each client, check membership in `_broadcastToSession`, and make `switch_session` update subscriptions. This is the right approach for Phase 2's multi-tab feature anyway.

**Estimate accuracy:** 4-8 hours is accurate for the proper fix. If you defer to Phase 2 (where `subscribe_sessions` is needed anyway), you avoid fixing it twice.

**5. "Add `tauri-plugin-single-instance`" -- 1-2 hours**

VERIFIED. No single-instance plugin is referenced anywhere in `packages/desktop/`. The `ServerManager` in `server.rs:93-96` checks if already running before starting, but there is no OS-level prevention of launching two Tauri app instances, each spawning their own server child process on the same port. The 1-2 hour estimate is accurate -- Tauri has official single-instance plugin support.

### Phase 0 Verdict

**Total estimate of 1-2 days is realistic**, assuming the token removal uses cookie-based auth and you defer the broadcast filtering fix to Phase 2. If you try to do the broadcast fix properly here, add 1 day.

---

## Phase 1: React Migration (Weeks 2-3)

### What the plan says vs. reality

**"Set up Vite + React build pipeline" -- 2-3 days**

The plan says output to `packages/server/src/dashboard/dist/`, served by existing HTTP handler. Looking at the actual serving code at `ws-server.js:443-448`:

```js
const assetMap = {
  '/assets/dashboard-app.js': { read: () => readFileSync(join(__dirname, 'dashboard', 'dashboard-app.js')), type: 'application/javascript' },
  '/assets/xterm/xterm.js': { read: () => readModule('@xterm/xterm', 'lib/xterm.js'), type: 'application/javascript' },
  ...
  '/assets/dashboard.css': { read: () => readFileSync(join(__dirname, 'dashboard', 'dashboard.css')), type: 'text/css' },
}
```

This is a hardcoded asset map with explicit file paths. A Vite build will produce hashed filenames, multiple chunks, and a manifest.json. The existing serving code needs to be replaced with either:
- A static file server that serves everything from `dist/`
- Or manifest-based routing that maps requests to hashed files

This is not just "output to the same directory." The HTTP handler at `ws-server.js:332-509` needs modification to serve Vite's output format. Budget an extra 0.5-1 day for this.

**"Port core components to React" -- 5-7 days**

The dashboard is 1,793 lines of JS with 53 functions and 35 case branches in its message handler. It handles:
- WebSocket connection lifecycle (connect, auth, reconnect, heartbeat)
- 35+ message type handlers
- Chat view with markdown rendering, syntax highlighting (custom tokenizer for 16 languages)
- xterm.js terminal with fit addon
- Session tab management (create, rename, destroy, switch)
- Permission prompts with countdown timers
- Plan approval cards
- QR code modal
- Conversation history browser
- Model and permission mode selectors
- Status bar with cost, context, agent badges
- localStorage persistence (debounced, with message truncation)
- Background agent tracking
- Keyboard shortcuts

Porting all of this faithfully to React is closer to **7-10 days** for one developer. The 5-7 day estimate assumes you can skip or defer some features, but the plan says "Verify existing functionality preserved" which implies full parity.

**Where the plan can save time:** The mobile app (`packages/app/`) already has React/TypeScript implementations of many of these patterns -- markdown rendering, terminal view, WebSocket hooks, Zustand stores. The plan mentions "Share component patterns with mobile app" but does not quantify the savings. Realistically, the mobile app's message handler (`message-handler.ts`) and connection store (`connection.ts`) provide patterns but NOT directly reusable code (React Native vs React DOM, different rendering targets, different state shapes).

**Estimate accuracy:** Underestimated by 30-50%. Budget **3-4 weeks** for Phase 1, not 2.

**"WebSocket hook (`useWebSocket`)" -- 1 day**

This is reasonable if you are building a thin wrapper. However, the dashboard's WebSocket logic includes: auth flow, key exchange, reconnection with exponential backoff, heartbeat with RTT measurement, message validation, encryption/decryption, offline queue, and delta buffering. A proper `useWebSocket` hook that replicates all of this is 2-3 days, not 1.

### Phase 1 Missing Items

1. **Build pipeline integration with `npm run` scripts.** The plan says "The build output ships with the server package (no separate build step for users)" but does not specify how. Options: (a) pre-build during `npm publish`, (b) watch mode during dev, (c) build step in monorepo root. This needs a decision and implementation.

2. **CSP nonce handling.** The current dashboard uses per-request CSP nonces (`ws-server.js:478-483`). A Vite-built SPA with hashed chunks changes this -- you will need to either generate nonces at build time (impossible for dynamic nonces) or switch to hash-based CSP for scripts. This is a security-sensitive change that needs design.

3. **Theme/CSS migration.** The current `dashboard.css` is 908 lines of handwritten CSS. The React app needs a CSS strategy (CSS modules, Tailwind, styled-components). This is not mentioned in the plan.

---

## Phase 2: Sidebar + Session Tabs (Weeks 4-5)

### What the plan says vs. reality

**"Sidebar component with repo tree" -- 3-4 days**

The plan correctly identifies that `ConversationScanner` (`conversation-scanner.js`) already groups conversations by project path. Looking at the actual output shape from `scanConversations()` at line 207:

```js
return {
  conversationId,
  project: cwd || decodedPath,  // repo path
  projectName: cwd ? basename(cwd) : projectName,
  modifiedAt, modifiedAtMs, sizeBytes, preview, cwd
}
```

This returns a flat list, not grouped by repo. The sidebar needs to:
1. Group conversations by `project` field
2. Cross-reference with active sessions from `session_list` (which have `cwd` but no explicit repo grouping)
3. Handle the case where active sessions are in repos with no past conversations (new repos)
4. Handle repos where the directory no longer exists (stale conversations)

The grouping logic and repo state management is client-side work, but non-trivial. The 3-4 day estimate is reasonable for the UI component, but does not account for the data transformation layer.

**"Tab system for main pane" -- 2-3 days**

This is the simplest-seeming item but has hidden complexity:

- Each tab needs its own xterm.js Terminal instance (these are heavyweight DOM objects, ~500KB RAM each)
- Tabs need to be lazily initialized (you cannot create 5 terminals on first render)
- Inactive tabs need to stop receiving terminal writes to avoid invisible rendering cost
- Tab switching needs to trigger history replay for the newly visible session
- The current dashboard keeps ONE terminal instance and re-attaches it. Multiple terminals is a fundamentally different architecture.

**Estimate accuracy:** 3-5 days is more realistic, especially with the terminal lifecycle management.

**"`subscribe_sessions` (new): client subscribes to multiple session event streams simultaneously"**

This is the most under-specified item in the entire plan. The current `_broadcastToSession` (confirmed at `ws-server.js:1038-1045`) sends to ALL clients indiscriminately. To implement `subscribe_sessions`:

1. Add `subscribedSessions: Set<string>` to the client state object (`ws-server.js:543-551`)
2. Modify `_broadcastToSession` to check `client.subscribedSessions.has(sessionId)` instead of the default `() => true` filter
3. Add a new message handler for `subscribe_sessions` in `ws-message-handlers.js`
4. Update `switch_session` to auto-subscribe
5. Update session destruction to auto-unsubscribe
6. Handle the edge case: what happens when a subscribed session is destroyed while the client has it in a tab?
7. Update the Zod schema in `ws-schemas.js` to validate the new message type
8. Handle history replay: when subscribing to a new session, the client needs the history. Currently `switch_session` triggers replay. Should `subscribe_sessions` also trigger replay for newly added sessions?

This is 2-3 days of server-side work that the plan does not estimate because it is listed under "Server-side support needed" without a time estimate. The total Phase 2 estimate should be increased by 2-3 days.

**"Repo discovery (past conversations)" -- 1-2 days**

The plan says "ConversationScanner already groups by repo path." Verified: the scanner returns `project` and `cwd` fields. However, the `list_conversations` handler at `ws-message-handlers.js:437-444` simply returns the flat list. The grouping into a repo tree needs to happen somewhere -- either a new server-side endpoint (`list_repos` as proposed) or client-side grouping.

The plan proposes `list_repos` as a new message type (in the "New Protocol Messages Needed" section) but does not include its server-side implementation in the Phase 2 effort estimates.

**"Add Repo manually" -- 1 day**

This requires:
1. Server-side persistence of manually-added repos (where? `~/.chroxy/repos.json`? Added to `config.json`?)
2. Validation (directory exists, is a git repo)
3. New message handlers: `add_repo`, `remove_repo`
4. UI: directory picker (Tauri has native file dialog, but the React app runs in WebView and cannot access the filesystem directly -- this needs a Tauri IPC bridge)

The Tauri IPC bridge for file dialog is a missing piece. Currently `lib.rs` has NO Tauri IPC commands defined (no `#[tauri::command]` functions). Adding Tauri commands for file picking is straightforward but is not mentioned in the plan. Budget 0.5 days extra.

### Phase 2 Missing Items

1. **Tauri IPC commands for native features.** The plan says "Tauri IPC is for desktop-native features only: Clipboard, native notifications, file dialogs, window management" but the existing Tauri app has ZERO IPC commands implemented. Every native feature (file dialog for "Add Repo", clipboard for sharing, native notifications for permission requests) requires implementing Tauri commands in Rust and calling them from the React UI via `@tauri-apps/api`. This is 2-3 days of work spread across Phase 2-3.

2. **State management architecture.** The plan says "Zustand store, mirrors mobile app's `connection.ts` pattern" but the mobile app's store is designed for a single active session. A multi-tab desktop needs fundamentally different state: per-tab message history, per-tab terminal buffer, per-tab busy/idle state, plus global state (repo list, connection status, sidebar selection). This state design is non-trivial and affects the entire React component architecture.

3. **Tab persistence across page reloads.** The Tauri WebView will reload the page when navigating or during updates. Which tabs were open, which was active, and scroll positions need to be persisted. The current dashboard uses localStorage for messages but not for tab state.

---

## Phase 3: Polish + Power Features (Weeks 6-8)

**"Native notifications for permission requests" -- 2-3 days**

The Tauri app already has notification support via `tauri_plugin_notification` (used in `lib.rs:438-451`). However, these are triggered from the Rust side (server state changes). For permission request notifications, the trigger comes from a WebSocket message in the React UI. Two approaches:
- The React app calls `@tauri-apps/plugin-notification` directly from JS (simplest, ~1 day)
- Or the React app sends a message to Rust via IPC, which sends the notification (more control, but requires IPC setup)

**Estimate accuracy:** 1-2 days is more realistic given the plugin already exists. The 2-3 day estimate is conservative (on the right side of conservative -- which is good).

**"Split pane (optional)" -- 3-5 days**

This is a significant UI feature. Recommendations:
- Use a library like `react-resizable-panels` rather than building from scratch
- Each pane needs its own terminal instance (see tab concerns above)
- Split pane + tab system interaction needs design: can you split two tabs? Can each pane have its own tab bar?

**Estimate accuracy:** 3-5 days is realistic for a basic implementation. Add 2 days if split-within-tabs is needed.

---

## Phase 4: Expandability Platform (Months 3-6)

Phase 4 estimates are appropriately vague ("Months 3-6"). Specific observations:

**"File browser panel" -- Builds on existing `browse_files` / `read_file` protocol**

Verified. `browse_files` and `read_file` handlers exist in `ws-message-handlers.js:370-388`. The file browser panel is pure client-side work once the protocol is available.

**"Diff viewer panel" -- Builds on existing `get_diff` protocol**

Verified. `get_diff` handler exists at `ws-message-handlers.js:384-388`. The diff viewer needs a React component for unified/side-by-side diff rendering. Libraries like `react-diff-viewer` exist.

**"Checkpoint timeline" -- Builds on existing checkpoint system**

Verified. `create_checkpoint`, `list_checkpoints`, `restore_checkpoint`, `delete_checkpoint` handlers exist in `ws-message-handlers.js:510-609`. The protocol is complete; this is purely a visualization layer.

**"Multi-machine support" -- Connect to Chroxy servers on multiple dev machines"**

This is architecturally significant and under-estimated in impact. Currently:
- The React UI connects to ONE server at `ws://localhost:{port}`
- Token auth is per-server
- Session state is per-server

Multi-machine means:
- Multiple WebSocket connections (one per remote server)
- A connection manager that routes messages to the right server
- Auth per server
- The sidebar needs to show which server each repo/session belongs to
- What happens when two servers have sessions in the same repo?

This should be called out as a "Phase 5" feature, not lumped into Phase 4.

---

## Missing from the Plan

### 1. Error handling strategy for the React app

The dashboard's vanilla JS error handling is ad-hoc (try/catch around individual operations). The React app needs a systematic approach: error boundaries, toast notifications, error states in components, and recovery flows. This affects every component and should be part of the Phase 1 foundation.

### 2. Accessibility

No mention of keyboard navigation, screen reader support, ARIA attributes, or focus management in the sidebar/tab UI. For an IDE-class application, this is important and adds 15-20% to UI component estimates.

### 3. Testing strategy

The plan has no mention of tests for the React UI. No test runner selection (Vitest, Jest), no component test strategy (React Testing Library), no E2E test plan for the desktop app. The mobile app has Maestro flows; the desktop app needs an equivalent.

### 4. Window management in Tauri

The current `window.rs` manages two windows: `dashboard` (WebView) and `main` (fallback/loading). The React IDE will likely need:
- Minimum window size constraints (sidebar + main pane need ~1000px minimum)
- Window state persistence beyond position/size (sidebar width, panel splits)
- Multiple window support (detach a tab into its own window -- a "nice to have" for Phase 3)

### 5. Hot reload during development

Vite's dev server runs on its own port (e.g., 5173). The Tauri WebView loads `http://localhost:{port}/dashboard` from the Node server. During development, you need the Tauri WebView to load from Vite's dev server instead. This requires either:
- A Tauri dev config that changes the WebView URL
- Or a proxy in the Node server that forwards `/dashboard` to Vite in dev mode

This is a DX concern that affects every developer session during Phase 1+.

### 6. Mobile app compatibility during migration

The plan says "Same protocol, same server, same code path." But replacing the dashboard HTML/JS changes what the Tauri WebView loads. If the mobile app also uses any dashboard endpoints (e.g., for the QR code flow), those need to keep working. The QR code endpoint (`/qr`) is separate from `/dashboard`, so this is likely fine -- but worth verifying.

---

## Harder than Estimated

### 1. React Migration (Phase 1): +1-2 weeks

The dashboard has 1,793 lines of tightly-coupled vanilla JS with 53 functions, custom syntax highlighting, manual DOM manipulation, and intricate WebSocket lifecycle management. Converting this to idiomatic React (hooks, effects, Zustand store) while maintaining feature parity is not a mechanical translation. Each function that does `document.getElementById` + manual DOM updates needs to be rethought as declarative state -> render.

The custom syntax tokenizer alone (supports 16 languages) is 200+ lines that will need to become a React component or be replaced with a library (Prism, Highlight.js, Shiki).

### 2. Multi-tab terminal management (Phase 2): +2-3 days

xterm.js Terminal instances are DOM-bound. You cannot render them to a hidden div and expect them to work correctly (fit addon needs visible dimensions). Tab switching with terminals requires either:
- Destroying and recreating Terminal instances (loses scroll position, slow)
- CSS visibility toggling (keeps DOM alive, uses memory, fit addon still needs resize on show)
- Using xterm.js serialize addon to snapshot/restore terminal state (complex)

The mobile app sidesteps this because it only shows one terminal at a time. The desktop's multi-tab requirement is genuinely harder.

### 3. `subscribe_sessions` server implementation (Phase 2): +2-3 days

As detailed above, this touches `ws-server.js`, `ws-message-handlers.js`, `ws-schemas.js`, and `ws-forwarding.js`. It also changes the semantics of `_broadcastToSession`, which is called 15+ times across the codebase.

---

## Easier than Estimated

### 1. Welcome screen (Phase 2): 0.5 days, not 1

This is a static React component with two buttons ("Add Repository", "Start New Session") and maybe a recent repos list. No complex state management, no WebSocket integration. Half a day.

### 2. Session rename / auto-labels (Phase 3): 0.5 days, not 1

`rename_session` already exists in the protocol (`ws-message-handlers.js:334-347`). Auto-labeling from the first message is a one-line change in `session-manager.js:174` to set the name from the first `recordUserInput` call. The UI is a text input with save button.

### 3. Repo pinning / favorites (Phase 3): 0.5 days, not 1

This is a boolean flag per repo stored in localStorage or settings. UI is a star icon toggle. Sorting pinned repos to top is trivial.

### 4. Tunnel status in sidebar footer (Phase 3): 0.5-1 days, not 1-2

The health endpoint already returns tunnel status. The existing dashboard already shows connection status. This is re-rendering existing data in a new location.

---

## Suggested Additions

### 1. Session auto-labeling from first message (Phase 2, not Phase 3)

Move session naming to Phase 2. The sidebar is useless with labels like "Session 1", "Session 2". Auto-labeling should be part of the MVP sidebar experience. Implementation: when the first `user_input` is recorded in `session-manager.js:526-531`, also update the session name to a truncation of that input. Server-side change: 30 minutes. This makes the demo experience dramatically better.

### 2. Drag-and-drop tab reordering (Phase 3)

Tabs in IDE applications are expected to be reorderable. Use `@dnd-kit` or similar. This is 1-2 days and significantly improves the "daily driver" feel.

### 3. Cost budget indicator in sidebar (Phase 2)

The cost budget system is fully implemented in `session-manager.js:760-817` with `budget_warning` and `budget_exceeded` events. Surface this in the sidebar as a progress bar next to each session. Users need to see at a glance which sessions are burning money.

### 4. Session auto-restart after crash (Phase 3)

If a Claude Code process crashes (OOM, network error), the session is destroyed. The desktop app should offer "Restart session" in the sidebar, which creates a new session with `resumeSessionId` pointing to the crashed session's conversation. The checkpoint system already supports this (`restore_checkpoint` creates a new session from a past state).

### 5. Command palette (Phase 3)

Every IDE has Cmd+K or Cmd+P. For Chroxy Desktop: search sessions, switch repos, create sessions, change models. This is 2-3 days and massively improves keyboard-driven workflows. It also replaces the need for many individual keyboard shortcuts.

### 6. Session activity sparkline in sidebar

Instead of just "running" / "idle" indicators, show a tiny sparkline of token generation rate over the last 60 seconds. This gives instant visual feedback on whether an agent is actively working or stuck. Cost updates (`cost_update` events, already in the protocol) provide the data. This is 1 day and makes the sidebar genuinely informative.

---

## Summary

The implementation plan is well-researched and properly grounded in the existing codebase. The phase structure (security -> foundation -> IDE -> polish -> platform) is correct. The main risks are:

1. **Phase 1 is underestimated by 30-50%.** The dashboard is more complex than it looks, and converting 1,793 lines of imperative DOM code to idiomatic React takes longer than porting.

2. **Phase 2 is missing ~3-5 days of server-side work** for `subscribe_sessions`, `list_repos`, and the Tauri IPC bridge for file dialogs.

3. **Multi-tab terminal management is the hardest UI problem** in the plan and deserves its own design spike before committing to an approach.

4. **The plan correctly defers IPC-over-WebSocket** and binary serialization -- the vision document's "What's Deferred" section shows good judgment about what not to build.

Total realistic timeline: **10-12 weeks** for Phases 0-3 (vs. the plan's 8 weeks). Phase 4 timeline of 3-6 months is appropriately vague and depends on what gets built first.
