# Builder Audit: Chroxy Desktop CLI Agent IDE

**Rating: 4.2 / 5 -- Highly buildable with targeted adjustments**

The vision document is unusually grounded. The existing server infrastructure does the heavy lifting, the protocol is mature, and the Tauri shell works. The main risk is Phase 1 scope creep -- the React migration touches a 2000-line vanilla JS app that handles 58+ message types, and the estimate of "5-7 days" for porting core components is optimistic unless you accept a deliberate feature-parity cut. Below is a detailed build plan with revised estimates, dependency chains, and concrete implementation guidance.

---

## 1. Revised Effort Estimates

### Phase 0: Foundation (Security + Critical Bugs)

| Item | Vision Estimate | Builder Estimate | Rationale |
|------|----------------|-----------------|-----------|
| Fix `config.json` permissions (0o600) | 15 min | 30 min | Includes adding test, verifying on Linux + macOS |
| Fix `settings.json` permissions (0o600) | 15 min | 30 min | Same as above; two files, one pattern |
| Remove token from HTML/URL rendering | 2-4 hours | 4-6 hours | Requires session-token or httpOnly cookie approach; CSP update; dashboard.js rewrite; testing auth flow end-to-end including Tauri WebView |
| Add `safeTokenCompare` tests | 20 min | 20 min | Agree -- unit tests against crypto.js |
| Fix `_broadcastToSession` session filtering | 4-8 hours | 6-8 hours | Needs careful analysis of every call site in ws-forwarding.js; regression testing with multi-session |
| Add `tauri-plugin-single-instance` | 1-2 hours | 1 hour | Plugin exists, add to Cargo.toml + lib.rs, test |
| **Phase 0 Total** | **1-2 days** | **2-3 days** | Token removal is the wild card. Budget 3 days. |

### Phase 1: React Migration

| Item | Vision Estimate | Builder Estimate | Rationale |
|------|----------------|-----------------|-----------|
| Vite + React build pipeline setup | 2-3 days | 1.5 days | Vite scaffold is fast; the integration with server's HTTP handler is the tricky part (see Build Pipeline section below) |
| Port core components to React | 5-7 days | 8-10 days | The 2000-line dashboard-app.js is tightly coupled IIFE with 30+ DOM mutation functions, custom markdown renderer, syntax highlighter, xterm.js integration, localStorage persistence, WebSocket reconnection, and 58+ message type handlers. Port order matters (see Build Order below). |
| WebSocket hook (`useWebSocket` + Zustand) | 1 day | 2 days | Need to build a desktop-specific Zustand store. Cannot directly reuse mobile's `connection.ts` -- it imports `react-native`, `expo-secure-store`, `expo-device`, `haptics`. Must extract a shared core and write a web adapter layer. |
| Verify existing functionality preserved | 1-2 days | 2-3 days | Manual verification of every feature: session tabs, chat rendering, terminal view, permissions, plan mode, QR pairing, conversation history, model/permission selectors, reconnection, status bar, keyboard shortcuts. Build a smoke-test checklist. |
| **Phase 1 Total** | **9-13 days** | **14-17 days** | ~3 weeks realistic. Can compress to 2.5 if you cut QR modal and conversation history from initial port. |

### Phase 2: Sidebar + Session Tabs

| Item | Vision Estimate | Builder Estimate | Rationale |
|------|----------------|-----------------|-----------|
| Sidebar component with repo tree | 3-4 days | 4-5 days | Tree state management (expanded/collapsed), grouping sessions under repos, handling the two types (active vs resumable), state sync with server |
| Tab system for main pane | 2-3 days | 3-4 days | Multi-tab xterm.js is the hard part: each tab needs its own Terminal instance, fit-on-switch, detach/reattach. See architecture notes below. |
| Welcome/quick-start screen | 1 day | 1 day | Agree -- static component with a few action buttons |
| Repo discovery (past conversations) | 1-2 days | 1.5 days | `list_conversations` already groups by project path. UI needs grouping logic + stale path handling |
| Add Repo manually (+ button) | 1 day | 1.5 days | Needs Tauri `dialog.open` for directory picker (native file dialog via IPC), then persist to settings, validate as git repo |
| Session creation from sidebar | 1 day | 1 day | Reuse create_session modal from Phase 1, pre-fill CWD from repo |
| Session resume from sidebar | 1 day | 0.5 days | Click handler sends `resume_conversation` -- minimal UI work |
| Server: `subscribe_sessions` message | (not estimated) | 2 days | New message type, schema validation, broadcast routing changes in ws-server.js, test coverage |
| Server: `list_repos` / `add_repo` / `remove_repo` | (not estimated) | 1.5 days | New server-side repo registry with persistence in settings.json |
| **Phase 2 Total** | **9-13 days** | **15-17 days** | ~3 weeks. The server-side work was underestimated. |

### Phase 3: Polish + Power Features

| Item | Vision Estimate | Builder Estimate | Rationale |
|------|----------------|-----------------|-----------|
| Native notifications for permission requests | 2-3 days | 2 days | Tauri notification plugin is already wired. Add window-focus detection + forward permission_request events |
| Tunnel status in sidebar footer | 1-2 days | 1 day | Health endpoint already returns tunnel info; just render it |
| Session naming / auto-labels | 1 day | 0.5 days | `rename_session` protocol exists. Auto-label from first message is client-only |
| Repo pinning / favorites | 1 day | 1 day | Persist to settings, sort pinned to top |
| Keyboard shortcuts | 1-2 days | 1.5 days | Cmd+1-9, Cmd+N, Cmd+W, Cmd+K(clear). React `useEffect` with `keydown` listener |
| Split pane (optional) | 3-5 days | 4-5 days | Requires a splitter component, dual terminal instances, layout state. Defer to Phase 3b. |
| Session search / filter | 1 day | 1 day | Client-side filter on session + conversation lists |
| **Phase 3 Total** | **10-15 days** | **11-13 days** | Largely agrees. Split pane is the big ticket item. |

### Summary Timeline

| Phase | Vision | Builder | Calendar |
|-------|--------|---------|----------|
| Phase 0 | 1-2 days | 2-3 days | Week 1 |
| Phase 1 | ~2 weeks | ~3 weeks | Weeks 2-4 |
| Phase 2 | ~2 weeks | ~3 weeks | Weeks 5-7 |
| Phase 3 | ~2 weeks | ~2 weeks | Weeks 8-9 |
| **Total to "daily driver"** | **~7 weeks** | **~9 weeks** | ~2.5 months |

This is aggressive but achievable for a solo full-stack dev working full-time. With interruptions and real-world friction, budget 3 months.

---

## 2. Critical Path Diagram

```
Phase 0                    Phase 1                          Phase 2                    Phase 3
========                   =======                          =======                    =======

[Token removal] ----+
[Broadcast fix] ----|
[Permissions fix] --+--> [Vite setup] --> [Zustand store] --> [Sidebar] --------+
[Single instance] --+         |               |                  |              |
                              v               v                  v              v
                         [ChatView] --> [InputBar] -------> [Tab system] --> [Shortcuts]
                              |               |                  |              |
                              v               v                  v              v
                         [TerminalView] [StatusBar] -----> [Multi-session  [Notifications]
                              |                            subscription]       |
                              v                                  |              v
                         [SessionBar] --> [Modals] -------> [Repo mgmt] --> [Split pane]
                              |                                  |
                              v                                  v
                         [Reconnection] --> [Verify] -----> [Welcome screen]
```

**Critical path (longest chain):**
```
Token removal --> Vite setup --> Zustand store --> ChatView --> TerminalView -->
SessionBar --> Modals --> Verify --> Sidebar --> Tab system --> Multi-session sub --> Keyboard shortcuts
```

**Parallelizable work (off critical path):**
- Phase 0: All 6 items can be done in parallel (different files, no dependencies)
- Phase 1: StatusBar, InputBar, and Reconnection banner can be built in parallel once ChatView exists
- Phase 2: Welcome screen and repo discovery can parallel sidebar component
- Phase 3: Notifications, pinning, search are all independent

---

## 3. Component Architecture Recommendation

### Directory Structure

```
packages/server/src/dashboard-next/     # New React app (lives alongside legacy)
  vite.config.ts
  tsconfig.json
  index.html                            # Entry point (replaces getDashboardHtml)
  src/
    main.tsx                            # React root
    App.tsx                             # Top-level layout (sidebar + main pane)
    store/
      connection.ts                     # Desktop Zustand store
      types.ts                          # Shared types (copied from mobile, trimmed)
      message-handler.ts               # WS message dispatch
      utils.ts                         # stripAnsi, filterThinking, etc.
    hooks/
      useWebSocket.ts                  # Connect/disconnect/reconnect
      useTerminal.ts                   # xterm.js lifecycle per tab
      useKeyboardShortcuts.ts          # Global keyboard handler
      useTauriIPC.ts                   # Tauri command bridge (native dialogs, notifications)
    components/
      layout/
        Sidebar.tsx                    # Repo tree + session list + status footer
        MainPane.tsx                   # Tab bar + active terminal/content
        StatusBar.tsx                  # Model, cost, context, agent badges
        WelcomeScreen.tsx              # Quick-start actions
      chat/
        ChatView.tsx                   # Message list with auto-scroll
        ChatMessage.tsx                # Single message (response, user, tool, permission, etc.)
        InputBar.tsx                   # Message input + send/interrupt buttons
        PermissionPrompt.tsx           # Permission card with countdown
        PlanApproval.tsx               # Plan mode approval card
        ToolBubble.tsx                 # Collapsible tool use display
      terminal/
        TerminalTab.tsx                # Single xterm.js instance in a tab
        TerminalManager.tsx            # Manages multiple Terminal instances
      session/
        SessionTabs.tsx                # Horizontal tab bar
        SessionTab.tsx                 # Single tab with close, rename, busy dot
        CreateSessionModal.tsx         # New session form
        ConversationHistory.tsx        # Past conversations browser
      sidebar/
        RepoTree.tsx                   # Expandable repo list
        RepoItem.tsx                   # Single repo with sessions
        SessionItem.tsx                # Active or resumable session entry
        AddRepoButton.tsx              # + Add Repository
        StatusFooter.tsx               # Server/tunnel/client status
      shared/
        Modal.tsx                      # Reusable modal overlay
        Toast.tsx                      # Toast notification container
        ReconnectBanner.tsx            # Disconnection/reconnect UI
        QRPairingModal.tsx             # QR code display
    utils/
      markdown.ts                      # Markdown-to-HTML renderer
      syntax.ts                        # Syntax highlighter (port from dashboard-app.js)
      ws-protocol.ts                   # Message type constants, send helper
    styles/
      theme.ts                         # Color tokens, spacing, typography
      global.css                       # Reset + scrollbar + animation keyframes
```

### Key Design Decisions

**1. TypeScript, not JavaScript.** The vision doc says the server is "no TypeScript," but the desktop React app should be TypeScript. The mobile app already is. Type safety for a 58-message-type protocol is not optional.

**2. Zustand store: desktop-specific, not shared.** The mobile `connection.ts` is 1100+ lines with React Native imports (`Alert`, `AppState`, `SecureStore`, `Device`, `haptics`). Extracting a platform-agnostic core would require significant refactoring of both the mobile store and message-handler. Instead:

- Copy the `types.ts` file wholesale (it has zero RN dependencies)
- Copy `utils.ts` (also pure -- `stripAnsi`, `filterThinking`, `nextMessageId`, `createEmptySessionState`)
- Rewrite `connection.ts` for web (use `localStorage` instead of `SecureStore`, no haptics, standard `WebSocket` instead of RN's)
- Rewrite `message-handler.ts` for web (no `Alert`, no `AppState` listener)

This is a "fork and adapt" approach. It duplicates ~200 lines of store boilerplate but avoids the complexity of a shared package that bridges RN and web.

**3. xterm.js directly, not via WebView.** The mobile app wraps xterm.js in a WebView because React Native has no DOM. The desktop React app runs in a Tauri WebView which IS a browser. Use xterm.js directly as an npm import:

```tsx
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

function TerminalTab({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const term = new Terminal({
      disableStdin: true,
      convertEol: true,
      scrollback: 5000,
      // theme from styles/theme.ts
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();
    termRef.current = term;
    return () => term.dispose();
  }, []);

  // Write data from store
  useEffect(() => {
    const unsubscribe = useConnectionStore.subscribe(
      state => state.sessionStates[sessionId]?.terminalRawBuffer,
      // write new data to terminal
    );
    return unsubscribe;
  }, [sessionId]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
```

**4. Multi-tab terminal architecture.** The tricky part is keeping multiple xterm.js instances alive while only one is visible:

```
Tab 1 (visible):  <div style="display:block">  <Terminal instance A />  </div>
Tab 2 (hidden):   <div style="display:none">   <Terminal instance B />  </div>
Tab 3 (hidden):   <div style="display:none">   <Terminal instance C />  </div>
```

- Each tab gets its own `Terminal` instance that persists for the tab's lifetime.
- Hidden tabs continue receiving `stream_delta` writes (the Terminal buffers them internally).
- On tab switch: `display: none -> block`, call `fitAddon.fit()` to recalculate dimensions.
- Do NOT destroy and recreate terminals on switch -- xterm.js state is expensive to rebuild.
- Cap at 10 concurrent Terminal instances (beyond that, destroy oldest inactive + replay raw buffer on reactivation).

**5. CSS: CSS Modules or Tailwind? Neither.** Use a CSS-in-JS approach that maps 1:1 to the existing `dashboard.css`. I recommend plain CSS files with BEM-style naming imported via Vite's CSS modules support. The existing 900-line `dashboard.css` is well-organized and can be refactored into per-component CSS files with minimal changes:

```
styles/
  global.css          # Reset, scrollbar, keyframes (from dashboard.css lines 1-8, 487-491, 354-364)
  theme.ts            # Color constants extracted from CSS values
components/
  chat/ChatMessage.module.css    # .msg.* rules from dashboard.css
  chat/InputBar.module.css       # #input-bar rules
  ...
```

---

## 4. Build Pipeline Recommendation

### Vite Configuration

```ts
// packages/server/src/dashboard-next/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: '/dashboard/',  // All assets served under /dashboard/
  build: {
    outDir: '../dashboard/dist',  // Output next to legacy dashboard
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // Dev mode: proxy WS to local server
    proxy: {
      '/ws': {
        target: 'ws://localhost:8765',
        ws: true,
      },
    },
  },
});
```

### Server Integration (ws-server.js changes)

The server needs to serve both the legacy dashboard and the new React dashboard during the migration. After Phase 1 is complete, the legacy dashboard is removed.

**Migration strategy -- Two-URL approach:**

```
/dashboard         --> Legacy vanilla JS (unchanged during migration)
/dashboard-next    --> New React app (served from dist/)
```

This lets you develop and test the React app without breaking the working dashboard. When Phase 1 is verified, swap the URLs.

**Server-side changes to ws-server.js:**

```javascript
// Add to the asset map in ws-server.js start() method:
// Serve React app build output
if (req.method === 'GET' && req.url?.startsWith('/dashboard-next')) {
  // Serve from dashboard/dist/ (Vite build output)
  // index.html for all routes (SPA fallback)
  // Static assets with cache headers
}
```

After migration, the React app becomes the sole `/dashboard` handler:
- `getDashboardHtml()` is deleted
- `dashboard-app.js` (2000-line IIFE) is deleted
- `dashboard.css` is deleted
- React build output in `dashboard/dist/` is served at `/dashboard`

**Build integration with npm scripts:**

```json
// packages/server/package.json (add)
"scripts": {
  "dashboard:dev": "cd src/dashboard-next && npx vite",
  "dashboard:build": "cd src/dashboard-next && npx vite build",
  "prepublishOnly": "npm run dashboard:build"
}
```

The `prepublishOnly` hook ensures the React app is built before publishing the server package. The built files ship with the package (no build step for end users).

### Tauri Integration (No changes needed in Phase 1)

The Tauri WebView already loads `http://localhost:{port}/dashboard`. Once the React app is served at that URL, Tauri picks it up automatically. The `tauri.conf.json` CSP needs updating to allow the new asset paths:

```json
"security": {
  "csp": "default-src 'self' http://localhost:*; connect-src ws://localhost:* http://localhost:*; script-src 'self'; style-src 'self' 'unsafe-inline'"
}
```

Note: the `'unsafe-inline'` for scripts can be removed once the React app is fully CSP-compliant (no inline scripts). The nonce-based approach in the current `getDashboardHtml` is good but Vite's built output doesn't need it -- all scripts are external files.

### Development Workflow

```bash
# Terminal 1: Server (serves WS + legacy dashboard)
npm run server:dev

# Terminal 2: React dashboard dev server (HMR, proxies WS to server)
npm run dashboard:dev
# Opens at http://localhost:5173/dashboard/

# Terminal 3 (optional): Tauri dev mode
npm run desktop   # (cd packages/desktop && cargo tauri dev)
```

During development, open `http://localhost:5173/dashboard/` in a browser for fast iteration with HMR. The Tauri WebView will still load the server-hosted version (legacy during migration, React after).

---

## 5. Build Order -- Exact Sequence

### Phase 0 (Days 1-3): Clear the Decks

All items are independent. Do them in order of risk:

1. **`_broadcastToSession` fix** (Day 1) -- Highest risk, most complex. Audit every call site in `ws-forwarding.js` and `ws-server.js`. Write regression tests.
2. **Token removal from HTML** (Day 1-2) -- Change `getDashboardHtml()` to not embed the token. Instead, use a session cookie set via the `/dashboard` HTTP handler (httpOnly, sameSite=strict, path=/). Dashboard JS reads from cookie instead of `window.__CHROXY_CONFIG__.token`. Update Tauri WebView cookie handling.
3. **Config/settings permissions** (Day 2) -- Two `chmod 0o600` calls + tests.
4. **`safeTokenCompare` tests** (Day 2) -- Unit tests.
5. **Single-instance plugin** (Day 3) -- `cargo add tauri-plugin-single-instance`, wire in `lib.rs`.
6. **Smoke test everything** (Day 3) -- Full manual test pass.

### Phase 1 (Days 4-20): React Migration

**Week 1 (Days 4-8): Scaffold + Core Infrastructure**

1. **Vite + React scaffold** (Day 4)
   - `npm create vite@latest dashboard-next -- --template react-ts` inside `packages/server/src/`
   - Configure `vite.config.ts` (base path, output dir, WS proxy)
   - Add `dashboard:dev` and `dashboard:build` scripts
   - Verify empty React app loads at `/dashboard-next`

2. **Theme + global CSS** (Day 4)
   - Extract color tokens from `dashboard.css` into `theme.ts`
   - Port `global.css` (reset, scrollbar, keyframes)

3. **Zustand store + types** (Days 5-6)
   - Copy `types.ts` from mobile (zero changes needed -- no RN imports)
   - Copy `utils.ts` from mobile (zero changes -- pure functions)
   - Write desktop `connection.ts`: WebSocket connect/disconnect/reconnect, `localStorage` persistence
   - Write desktop `message-handler.ts`: port from mobile, replace `Alert` with console/toast, remove haptics/SecureStore/AppState

4. **WebSocket hook** (Day 6)
   - `useWebSocket()` wrapping the store's connect/disconnect
   - Token loading from URL query param or cookie
   - Auto-reconnect with health check

5. **App shell** (Days 7-8)
   - `App.tsx` with placeholder layout (header, content area, input bar, status bar)
   - Connection status indicator
   - Basic routing: connected vs disconnected state

**Week 2 (Days 9-13): Port Core Components**

6. **ChatMessage component** (Day 9)
   - Port the markdown renderer (the `renderMarkdown()` function in dashboard-app.js ~lines 400-500)
   - Port the syntax highlighter (the `highlightCode()` function ~lines 500-700)
   - Message types: response, user_input, tool_use, thinking, error, system
   - Handle streaming state (partial content during stream_delta)

7. **ChatView component** (Day 10)
   - Message list with auto-scroll (port the `userScrolledUp` detection)
   - Thinking dots animation
   - History replay deduplication

8. **PermissionPrompt + PlanApproval** (Day 10)
   - Permission card with allow/deny buttons and countdown timer
   - Plan approval card with approve/feedback buttons

9. **InputBar** (Day 11)
   - Auto-expanding textarea
   - Send button (Ctrl+Enter)
   - Interrupt button (Escape)
   - Disabled state when not connected or not ready

10. **TerminalView** (Day 11-12)
    - Direct xterm.js integration (not WebView)
    - FitAddon for responsive sizing
    - Write data from store's terminal buffer
    - View switching (Chat vs Terminal tabs)

11. **SessionBar** (Day 12)
    - Horizontal tab strip with active highlight
    - New session button (+)
    - Tab close, rename (double-click)
    - Busy dot indicator

12. **StatusBar** (Day 13)
    - Model name, cost, context usage, agent badges
    - Busy indicator

**Week 3 (Days 14-20): Modals, Edge Cases, Verification**

13. **CreateSessionModal** (Day 14)
    - Session name + CWD input
    - Model and permission mode selection

14. **QRPairingModal** (Day 14)
    - Fetch SVG from `/qr` endpoint
    - Display in modal

15. **ConversationHistory modal** (Day 15)
    - Fetch from `list_conversations`
    - Group by project, display with resume button

16. **ReconnectBanner** (Day 15)
    - Disconnected state, retry button, token re-auth
    - Port reconnection logic from dashboard-app.js

17. **Toast notifications** (Day 16)
    - Error toasts (session crashes, tunnel failures)

18. **Model/Permission selectors** (Day 16)
    - Dropdown selects in header (port existing logic)

19. **Keyboard shortcuts** (Day 17)
    - Ctrl+Enter send, Escape interrupt, Ctrl+N new session
    - View switching shortcuts

20. **Verification + bug fixes** (Days 18-20)
    - Side-by-side comparison: open legacy and React dashboards
    - Check every message type: stream, tool_use, permission, question, plan, error
    - Check session lifecycle: create, switch, rename, destroy
    - Check reconnection: kill server, verify reconnect
    - Check persistence: refresh page, verify messages restored
    - Fix bugs found during verification

21. **URL swap** (Day 20)
    - Move React app to `/dashboard`
    - Delete legacy `dashboard-app.js`, `dashboard.css`, `getDashboardHtml()`
    - Update server's HTTP handler

### Phase 2 (Days 21-37): Sidebar + Tabs

**Week 1 (Days 21-25): Layout Refactor + Sidebar**

22. **Layout refactor** (Day 21-22)
    - Change `App.tsx` from single-pane to sidebar + main pane layout
    - CSS Grid or Flexbox: `grid-template-columns: 260px 1fr`
    - Sidebar collapsible (toggle button or drag handle)

23. **Sidebar: StatusFooter** (Day 22)
    - Server status (healthy/unhealthy)
    - Tunnel URL (truncated, copy-on-click)
    - Connected clients count

24. **Sidebar: RepoTree** (Days 23-25)
    - Server-side: `list_repos` / `repo_list` / `add_repo` / `remove_repo` messages
    - Server-side: repo registry with persistence
    - Client-side: tree with expand/collapse per repo
    - Active sessions (bullet) grouped under their repo
    - Resumable conversations (circle) grouped under their repo
    - Add Repo button with Tauri native directory picker

**Week 2 (Days 26-30): Tab System + Multi-Session**

25. **Server: `subscribe_sessions` message** (Days 26-27)
    - New message type in `ws-schemas.js`
    - Handler in `ws-message-handlers.js`
    - Modify `_broadcastToSession` to check subscription list instead of just active session
    - `session_activity` lightweight updates (busy/idle/cost) for sidebar

26. **Multi-tab Terminal** (Days 28-29)
    - `TerminalManager` component managing N Terminal instances
    - Tab open: create Terminal, subscribe to session
    - Tab switch: show/hide div, fit active terminal
    - Tab close: dispose Terminal, unsubscribe
    - Cap at 10 concurrent terminals

27. **SessionTabs refactor** (Day 30)
    - Move from horizontal session bar to tab bar in main pane
    - Each tab maps to a session (not just a selector)
    - Middle-click or X button to close tab
    - Tab drag-reorder (optional, defer if time-constrained)

**Week 3 (Days 31-37): Repo Management + Welcome + Polish**

28. **Session creation from sidebar** (Day 31)
    - Click + next to repo name
    - Pre-fill CWD from repo path
    - Open as new tab on creation

29. **Session resume from sidebar** (Day 32)
    - Click resumable session
    - Send `resume_conversation`
    - Open as new tab when session_created arrives

30. **Welcome screen** (Day 33)
    - Shown when no tabs are open
    - Quick-start actions: Add Repository, Start New Session
    - Recent sessions list
    - Keyboard shortcut hints

31. **Repo discovery** (Days 34-35)
    - Invoke `list_conversations` on connect
    - Group by project path
    - Merge with manually-added repos
    - Handle stale paths (repo moved/deleted)

32. **Integration testing** (Days 36-37)
    - Full end-to-end: sidebar repo, create session, switch tabs, resume conversation
    - Multi-client: desktop + mobile connected simultaneously
    - Tab lifecycle: open 5 tabs, switch between them, close 3, open 2 more
    - Reconnection with multiple tabs open

---

## 6. Component Reuse Analysis (Mobile vs Desktop)

| Component | Mobile Implementation | Desktop Approach | Shareability |
|-----------|----------------------|-----------------|-------------|
| **types.ts** | RN-agnostic type defs | Copy wholesale | 100% -- no changes needed |
| **utils.ts** | Pure functions | Copy wholesale | 100% -- stripAnsi, filterThinking, nextMessageId |
| **message-handler.ts** | 972 lines, uses `Alert`, `AppState` | Fork and adapt | 60% -- core logic shared, platform bindings differ |
| **connection.ts** | 1100 lines, deep RN integration | Rewrite for web | 30% -- same shape, different platform APIs |
| **TerminalView** | WebView wrapping xterm.js HTML | Direct xterm.js import | 0% -- fundamentally different approach |
| **ChatMessage rendering** | React Native `<Text>` + custom markdown | React `<div>` + similar markdown | 40% -- rendering logic similar, component tree differs |
| **Theme/colors** | `COLORS` constant object | Similar tokens, CSS instead of StyleSheet | Concept shared, implementation differs |
| **WebSocket protocol** | Same message types | Same message types | 100% -- protocol is the shared contract |

**Recommendation:** Do not attempt a shared package in Phase 1. The overhead of abstracting platform differences (RN vs web for storage, navigation, notifications, haptics, WebView vs DOM) exceeds the benefit. Instead, use the mobile code as reference and fork the pure-logic parts. Revisit sharing in Phase 4 when the desktop app is stable.

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| xterm.js multi-tab performance | Medium | High | Test with 10 concurrent terminals early. Profile memory. Set hard cap. |
| Vite build output too large for server package | Low | Medium | xterm.js is ~800KB. Use dynamic import to code-split. |
| Token removal breaks Tauri WebView auth | Medium | High | Test the cookie-based approach in Tauri WebView before committing to it. Tauri's WebView may not support httpOnly cookies on localhost. Fallback: embed token in a `<meta>` tag instead of `window.__CHROXY_CONFIG__`. |
| React migration takes longer than estimated | High | Medium | Prioritize: ChatView + TerminalView + InputBar first. These cover 80% of daily use. Defer QR modal, conversation history, plan mode to "fast follow." |
| `subscribe_sessions` changes break mobile app | Low | High | Protocol version bump. New message type is additive. Server only sends if client subscribes. Mobile app never sends `subscribe_sessions`, so it's unaffected. |
| Sidebar layout breaks on narrow windows | Medium | Low | Set minimum window width in `tauri.conf.json` (900px). Add sidebar collapse at 700px. |

---

## 8. What I Would Cut to Hit 7 Weeks

If the timeline must be compressed to match the original 7-week estimate:

1. **Cut QR Pairing Modal from Phase 1.** The mobile app is the primary pairing mechanism. Desktop users can paste the URL manually. Save 1 day.
2. **Cut Conversation History Modal from Phase 1.** Resumable sessions appear in the sidebar in Phase 2. The standalone modal is redundant. Save 1 day.
3. **Cut Split Pane from Phase 3.** Tabs are sufficient for v1. Split pane is a "nice to have." Save 4 days.
4. **Simplify token removal.** Instead of a cookie-based approach, use a `<meta>` tag with a short-lived session token that expires. Less secure but faster to implement. Save 2 days.
5. **Skip drag-reorder on tabs.** Tabs open in creation order. Save 0.5 days.

Total savings: ~8.5 days, bringing the estimate down to ~7.5 weeks.

---

## 9. One Thing the Vision Gets Wrong

The vision document says "share component patterns with mobile app where possible (markdown renderer, terminal view)." This is aspirational but impractical for Phase 1:

- The mobile markdown renderer uses React Native's `<Text>` component tree with nested `<Text style={...}>` elements. The desktop renderer will use HTML `<div>`, `<code>`, `<pre>` with CSS classes. The rendering logic (parsing markdown) could theoretically be shared, but the output is fundamentally different.
- The mobile terminal view is a WebView bridge. The desktop terminal is a direct DOM integration.

The correct shared abstraction is the **WebSocket protocol**. Mobile and desktop speak the same protocol, handle the same message types, and maintain the same state shape (`SessionState`, `ChatMessage`, etc.). That's where the sharing happens -- at the data layer, not the component layer.

---

## 10. Final Assessment

This plan is buildable. The vision is clear, the server infrastructure is solid, and the phased approach is correct. The main risks are:

1. **Phase 1 is bigger than it looks.** The 2000-line vanilla JS dashboard packs a lot of functionality. Every message type handler, every edge case (countdown timers, reconnection states, plan mode, agent badges) needs porting. Budget 3 weeks, not 2.

2. **The Zustand store will take real work.** You cannot just copy the mobile store. The 200+ lines of platform-specific code (SecureStore, haptics, Alert, AppState) need web equivalents. Budget 2 days for this.

3. **Multi-tab xterm.js is the hardest technical challenge.** Managing multiple Terminal instances, keeping hidden ones alive, fitting on tab switch, capping memory -- this needs early prototyping.

Given these caveats, the plan rates **4.2/5** on buildability. The vision is strong. The estimates need adjustment. The build order above is the fastest path to a working IDE.
