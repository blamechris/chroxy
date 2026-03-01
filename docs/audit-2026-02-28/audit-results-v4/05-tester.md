# Tester Audit: Chroxy Desktop CLI Agent IDE

**Auditor Role:** QA Engineer (desktop app shipping experience)
**Date:** 2026-02-28
**Scope:** Testing strategy for the desktop-vision implementation roadmap

---

## Rating: 3.5 / 5 — Testable With Significant Gaps to Close

The vision is implementable from a testability standpoint, but the current test infrastructure has critical holes that need filling *before* Phase 1 begins. The mobile app has decent unit test coverage for its store layer and a solid Maestro E2E framework with a mock server, but the server package has **zero automated tests**. The desktop package has **zero tests** of any kind. The migration to React in Phase 1 is a high-risk rewrite that will be done blind unless the existing dashboard behavior is pinned by tests first.

**What is strong:**
- Zod schemas on every WS message type (both directions) make contract testing straightforward
- The existing mock server (`packages/app/.maestro/mock-server.mjs`) is a reusable pattern
- App store tests demonstrate good patterns: mock Zustand stores, `_testMessageHandler` hooks, `_testQueueInternals` exports
- Maestro flows cover the mobile connection/session lifecycle adequately
- The manual smoke test checklist (`docs/smoke-test.md`) is thorough and has file-to-scope mapping

**What is missing:**
- No server-side unit or integration tests at all (not even for `safeTokenCompare`)
- No desktop (Tauri) tests
- No cross-device sync tests
- No performance baselines
- The `_broadcastToSession` bug (Phase 0) has no regression test
- No test for the React migration parity (Phase 1)

---

## Current Test Coverage Inventory

### Server (`packages/server/`)

| Category | Files | Tests |
|----------|-------|-------|
| Unit tests | 0 | 0 |
| Integration tests | 0 | 0 |
| E2E tests | 0 | 0 |
| Manual test client | `test-client.js` | Ad-hoc CLI tool |

**Critical gaps:** `ws-server.js` (1000+ lines), `session-manager.js`, `crypto.js` (server-side `safeTokenCompare`), `event-normalizer.js`, `ws-schemas.js` validation, `ws-message-handlers.js`, `ws-forwarding.js`, `ws-permissions.js`, `ws-file-ops.js` -- all untested.

### Mobile App (`packages/app/`)

| Category | Files | Tests |
|----------|-------|-------|
| Store tests | `connection.test.ts`, `connection-connect.test.ts`, `message-handler.test.ts`, `persistence.test.ts` | ~50+ cases |
| Component tests | `xterm-html.test.ts`, `AnimatedMessage.test.ts`, `Icon.test.tsx`, `SessionOverview.test.ts` | ~15+ cases |
| Utility tests | `crypto.test.ts`, `formatters.test.ts`, `markdown.test.ts`, `syntax.test.ts`, `haptics.test.ts` | ~30+ cases |
| Hook tests | `useBiometricLock.test.ts`, `useLayout.test.ts`, `useSpeechRecognition.test.ts` | ~10+ cases |
| Maestro E2E | 8 flows via `run-all.yaml` | ConnectScreen, SessionScreen, file browser, messages |

### Desktop (`packages/desktop/`)

| Category | Files | Tests |
|----------|-------|-------|
| Rust unit tests | 0 | 0 |
| Tauri integration tests | 0 | 0 |
| Dashboard tests | 0 | 0 (vanilla JS has no test framework) |

---

## Per-Phase Test Plan

### Phase 0: Foundation (Security + Critical Bugs)

Phase 0 is entirely about regressions and correctness. Every fix here must have a test that prevents re-introduction.

#### Test Cases

**T0.1: Config file permissions (0o600)**
- Unit test: After `writeFileRestricted()` call, `statSync()` returns mode `0o100600`
- Negative test: Verify it does NOT write `0o644`
- Location: New file `packages/server/src/__tests__/platform.test.js`

**T0.2: Token not exposed in HTML/URLs**
- Integration test: Start server, `GET /dashboard`, assert response body does NOT contain the raw API token string
- Grep test: No `token=` in any query parameter in rendered HTML
- Location: New file `packages/server/src/__tests__/ws-server.test.js`

**T0.3: `safeTokenCompare` correctness**
- Unit tests (already identified as needed by auditors):
  - Equal tokens return `true`
  - Different tokens return `false`
  - Different-length tokens return `false` (no early exit)
  - Empty strings handled safely
  - Timing: run 10,000 iterations of matching vs. non-matching, assert time delta < threshold (loose, flaky-resistant)
- Location: New file `packages/server/src/__tests__/crypto.test.js`

**T0.4: `_broadcastToSession` session filtering**
- Integration test with mock clients:
  - Create 2 sessions, subscribe 2 mock WS clients to different sessions
  - Send a session-scoped message for session A
  - Assert client subscribed to session B did NOT receive it
  - Assert client subscribed to session A DID receive it with `sessionId` tag
- Location: New file `packages/server/src/__tests__/ws-broadcast.test.js`

**T0.5: Single-instance guard (Tauri)**
- Manual test: Launch app, launch again, verify second instance activates the first window rather than creating a duplicate
- Automate later with Tauri test harness if available

#### Phase 0 Ship Gate Checklist

- [ ] `safeTokenCompare` has 5+ test cases, all passing
- [ ] Config/settings write permissions verified in test
- [ ] Token-in-HTML test passing
- [ ] `_broadcastToSession` regression test passing
- [ ] All existing app tests still pass (`cd packages/app && npx jest`)
- [ ] Smoke test: Regression Baseline from `docs/smoke-test.md`

---

### Phase 1: React Migration (The UI Foundation)

This is the highest-risk phase from a QA perspective. You are replacing a working 2000-line vanilla JS dashboard with a React app. The only way to do this safely is:

1. **Pin the current behavior** with tests before touching the dashboard
2. **Mirror tests** for the React version
3. **Visual regression** comparison

#### Pre-Migration: Pin Current Dashboard Behavior

Before writing any React code, create a Playwright test suite against the existing vanilla JS dashboard.

**T1.0: Dashboard behavior snapshot (pre-migration)**
- Start server in test mode
- Connect to `http://localhost:{port}/dashboard`
- Assert: Terminal view renders, input bar present, status bar present
- Assert: WebSocket connects and auth_ok received
- Assert: Can send a message and receive a streamed response (with mock session)
- Assert: Session list renders
- Assert: Model chips render and are clickable
- Screenshot baseline for visual regression

**Why Playwright (not Cypress, not Puppeteer):**
- Playwright has first-class Electron/WebView support via `electron.launch()` or direct browser context
- Tauri's WebView is Chromium-based (WebKit on macOS) -- Playwright supports both
- `@playwright/test` ships with screenshot comparison built in
- Active Tauri community uses Playwright (see `tauri-driver` + WebDriver protocol)

#### React Migration Tests

**T1.1: WebSocket hook (`useWebSocket` / Zustand store)**
- Unit test: Mock WebSocket, verify store state transitions (connecting -> authenticated -> receiving messages)
- Unit test: Reconnection logic on close
- Unit test: Message queueing during reconnection
- Pattern: Mirror `packages/app/src/__tests__/store/connection-connect.test.ts` for desktop store
- Location: `packages/desktop/dashboard/src/__tests__/store/`

**T1.2: React component parity**
- For each ported component, write a React Testing Library test:
  - `TerminalView`: Renders xterm.js instance, receives write data
  - `ChatMessage`: Renders sender, content, timestamps, tool bubbles
  - `InputBar`: Send button, interrupt button, input state
  - `StatusBar`: Model chips, cost, duration, token count
- Location: `packages/desktop/dashboard/src/__tests__/components/`

**T1.3: Full parity E2E**
- Playwright test suite that runs the same assertions as T1.0 against the React dashboard
- Screenshot comparison: React dashboard should be visually similar to vanilla dashboard (within threshold)
- Functional comparison: Every WebSocket message type rendered in vanilla dashboard must also render in React dashboard

**T1.4: xterm.js terminal integrity**
- Test: Write ANSI escape sequences, verify terminal renders colors
- Test: Resize event propagation (fit addon)
- Test: Multiple terminal instances can coexist (prep for Phase 2 tabs)
- Test: Terminal memory footprint stays under threshold after 10,000 lines of output

#### Phase 1 Ship Gate Checklist

- [ ] All T1.0 assertions pass against React dashboard (parity confirmed)
- [ ] Screenshot diff < 5% threshold (or manually approved)
- [ ] WebSocket store has 20+ unit tests
- [ ] All component tests passing
- [ ] xterm.js renders ANSI correctly
- [ ] Existing mobile app tests unaffected
- [ ] Smoke test: Full Regression Baseline + Chat + Permissions scopes

---

### Phase 2: Sidebar + Session Tabs (The IDE Layout)

This phase introduces the most complex user-facing state: multiple sessions visible simultaneously, tab lifecycle, repo tree state.

#### New WS Protocol Tests

**T2.1: `subscribe_sessions` message**
- Server test: Send `subscribe_sessions` with array of session IDs, verify server routes events for all subscribed sessions to that client
- Server test: Unsubscribing (re-sending `subscribe_sessions` with smaller array) stops events for dropped sessions
- Server test: Subscribing to non-existent session ID returns error or is silently ignored
- Client test: Store correctly routes incoming messages with `sessionId` tag to the correct session state slice
- Location: `packages/server/src/__tests__/ws-subscribe.test.js`

**T2.2: `session_activity` lightweight updates**
- Server test: Activity events include correct fields (busy/idle/cost)
- Client test: Sidebar re-renders with activity state change, does NOT trigger full history replay
- Performance: Activity updates for 5 concurrent sessions arrive within 100ms

**T2.3: `list_repos` / `repo_list` / `add_repo` / `remove_repo`**
- Server test: `list_repos` returns ConversationScanner discovered repos + manually added repos
- Server test: `add_repo` with valid directory succeeds, `add_repo` with non-existent path returns error
- Server test: `remove_repo` removes from list, does not destroy sessions
- Client test: Sidebar repo tree updates reactively

#### Component Tests

**T2.4: Sidebar component**
- Renders repo tree with correct hierarchy (repo -> active sessions -> resumable sessions)
- Click active session dispatches `switch_session`
- Click resumable session dispatches `resume_conversation`
- Click `+` button opens session creation modal
- Repo collapse/expand works
- Empty state (no repos) shows "Add a Repository" prompt
- Stress: 10 repos with 5 sessions each renders within 200ms

**T2.5: Tab system**
- Open tab dispatches `subscribe_sessions` including new session
- Close tab dispatches `subscribe_sessions` excluding closed session
- Close last tab shows welcome screen
- Tab switching does NOT cause full history replay (only if first open)
- Tab reordering (if implemented) persists across refreshes
- Keyboard shortcut Cmd+1-9 switches tabs (Phase 3 but test infra should be ready)
- Stress: Open 5 tabs with active terminals, verify no memory leak over 60 seconds

**T2.6: Welcome screen**
- Renders when no tabs open
- "Add a Repository" action works
- "Start New Session" action works
- Quick-start actions are keyboard-accessible

**T2.7: Session creation from sidebar**
- Modal renders with repo selector, name field, model selector, permission mode
- Creating session dispatches `create_session` with correct `cwd`
- New session appears in sidebar under correct repo
- New tab opens automatically

**T2.8: Session resume from sidebar**
- Click resumable session (circle icon) dispatches `resume_conversation`
- Session transitions from resumable to active in sidebar
- History replays in newly opened tab

#### Integration Tests

**T2.9: Multi-session lifecycle (Playwright E2E)**
- Create session in repo A -> tab opens
- Create session in repo B -> second tab opens
- Switch between tabs, verify terminal shows correct content
- Destroy session in repo A -> tab closes, sidebar updates
- Resume a past conversation -> new tab opens with replayed history

**T2.10: Cross-device sync baseline**
- Desktop creates session -> mobile app connects -> mobile sees session in list
- Mobile sends message -> desktop tab shows message
- Desktop destroys session -> mobile session list updates
- Note: Requires running both mock mobile + Playwright desktop simultaneously. May need a shared mock server.

#### Phase 2 Ship Gate Checklist

- [ ] All new protocol messages have server-side + client-side tests
- [ ] Sidebar renders repos and sessions correctly (5+ component tests)
- [ ] Tab system handles open/close/switch without memory leaks
- [ ] Multi-session Playwright E2E passes
- [ ] Cross-device sync smoke test passes (manual or automated)
- [ ] Performance: 5 concurrent sessions with streaming do not drop frames
- [ ] Smoke test: Full Regression Baseline + Sessions + new sidebar interaction

---

### Phase 3: Polish + Power Features

Phase 3 is mostly additive features on a stable foundation. Testing is incremental.

#### Test Cases

**T3.1: Native notifications**
- Tauri test: Permission request triggers OS notification when window not focused
- Tauri test: Notification click brings window to foreground
- Test: Notification respects `show_notifications` setting (off = no notification)

**T3.2: Tunnel status in sidebar**
- Component test: Sidebar footer shows "Server OK", "Tunnel OK", client count
- Integration test: Health endpoint change -> sidebar footer updates within 5 seconds

**T3.3: Session naming / auto-labels**
- Unit test: Auto-label truncates first message to 50 chars
- Component test: Custom name appears in sidebar and tab title
- Integration test: `rename_session` -> sidebar and tab both update

**T3.4: Keyboard shortcuts**
- Playwright test: Cmd+N opens new session modal
- Playwright test: Cmd+W closes active tab
- Playwright test: Cmd+1 through Cmd+9 switch tabs
- Playwright test: Shortcuts disabled when modal is open

**T3.5: Split pane (if implemented)**
- Component test: Two terminals render side by side
- Performance test: Both terminals stream simultaneously without dropped frames
- Resize test: Dragging divider resizes both panes, xterm fit addon triggers

**T3.6: Session search/filter**
- Component test: Typing in search box filters sidebar sessions
- Edge case: Empty search restores full list
- Edge case: No results shows empty state

#### Phase 3 Ship Gate Checklist

- [ ] Notifications fire correctly on permission requests
- [ ] Keyboard shortcuts cover all documented shortcuts
- [ ] Performance benchmarks pass (see below)
- [ ] All Phase 1 and Phase 2 tests still pass (regression)
- [ ] Full smoke test checklist pass

---

### Phase 4: Expandability Platform

Phase 4 introduces pluggable panels. Each panel is a self-contained component with its own data subscription.

#### Test Architecture for Panels

Each new panel (file browser, diff viewer, checkpoint timeline, agent dashboard) should follow this test pattern:

```
panel-name/
  __tests__/
    PanelName.test.tsx          # React Testing Library
    usePanelNameData.test.ts    # Hook/store unit test
  PanelName.tsx
  usePanelNameData.ts
```

**T4.1: File browser panel**
- Component test: Renders directory tree from `file_listing` messages
- Component test: Click file dispatches `read_file`, shows content
- Integration test: Navigate up/down directory hierarchy
- Existing protocol: `browse_files` and `read_file` already exist and work

**T4.2: Diff viewer panel**
- Component test: Renders git diff with syntax highlighting
- Component test: Shows file-by-file diff navigation
- Integration test: `get_diff` returns diff, panel renders it

**T4.3: Checkpoint timeline**
- Component test: Renders timeline of checkpoints chronologically
- Component test: Click checkpoint dispatches `restore_checkpoint`
- Integration test: Create checkpoint -> appears in timeline -> restore -> new session created

**T4.4: Agent monitoring dashboard**
- Component test: Renders agent tree with parent-child relationships
- Component test: Cost per agent displayed
- Live test: Spawn subagents -> dashboard updates in real time

#### Phase 4 Ship Gate Checklist

- [ ] Each panel has isolated component + hook tests
- [ ] Panels do not interfere with each other (mount panel A, unmount, mount panel B -- no leaked state)
- [ ] Performance: 3 panels open simultaneously, all receiving WebSocket data -- no dropped frames
- [ ] All prior phase tests still pass

---

## Test Framework Recommendations

### Server Tests

| Tool | Purpose |
|------|---------|
| **Vitest** | Unit tests for server modules (fast, ESM-native, no config pain with ES modules) |
| **ws** (test client) | Integration tests using actual WebSocket connections to a test server instance |
| **Zod schemas** | Contract validation for both directions -- schemas already exist, use them in tests |

**Why Vitest over Jest for the server:** The server is ES modules with no TypeScript. Jest requires `--experimental-vm-modules` or transform config for ESM. Vitest handles ESM natively and has the same API.

**Server test architecture:**

```
packages/server/
  src/
    __tests__/
      crypto.test.js          # safeTokenCompare, encrypt/decrypt
      session-manager.test.js # Session lifecycle, limits, timeouts
      ws-server.test.js       # HTTP health, WS auth, message routing
      ws-broadcast.test.js    # _broadcastToSession filtering
      ws-schemas.test.js      # Schema validation edge cases
      event-normalizer.test.js # Event mapping, delta buffering
      helpers/
        mock-session.js       # Reusable mock CliSession/SdkSession
        test-server.js        # Boots ws-server on random port for integration tests
  vitest.config.js
```

### Desktop Dashboard Tests (React)

| Tool | Purpose |
|------|---------|
| **Vitest + React Testing Library** | Component unit tests |
| **Playwright** | E2E tests against the served dashboard |
| **Playwright screenshot comparison** | Visual regression between vanilla and React dashboards |

### Desktop App Tests (Tauri)

| Tool | Purpose |
|------|---------|
| **`cargo test`** | Rust unit tests for `server.rs`, `config.rs`, `settings.rs`, `node.rs` |
| **Playwright + `tauri-driver`** | E2E tests that launch the full Tauri app and interact via WebDriver |
| **Tauri's `tauri::test`** | Integration tests for Tauri commands (if IPC commands are added later) |

**Tauri E2E approach:**

Tauri provides `tauri-driver`, a WebDriver-compatible binary. Combined with Playwright's WebDriver support or direct CDP connection, you can:

1. Build the app in debug mode: `cargo tauri build --debug`
2. Launch via `tauri-driver`
3. Connect Playwright to the WebView
4. Run the same Playwright tests that work against `http://localhost:{port}/dashboard`

This means the Phase 1 Playwright tests against the served dashboard also work against the Tauri WebView with minimal changes (different connection method, same assertions).

### Mobile App Tests (Existing)

No changes needed to the testing framework. Continue using:
- Jest for unit tests
- Maestro for E2E flows

**New Maestro flows needed for cross-device testing:**
- `session-sync-desktop.yaml`: Connect while desktop is connected, verify session list matches
- `session-message-sync.yaml`: Send message from mobile, verify desktop received it (requires coordinated mock)

---

## Performance Benchmarks to Establish

These benchmarks should be measured in Phase 1 and tracked as regression thresholds through Phase 4.

### Terminal Performance

| Metric | Target | How to Measure |
|--------|--------|----------------|
| xterm.js render latency | < 16ms per frame (60fps) | Performance.measure() around terminal.write() |
| Multiple terminal instances | 5 terminals, < 200MB total RSS | `process.memoryUsage()` + Chrome DevTools memory snapshot |
| Streaming throughput | 10,000 chars/sec without dropped frames | Mock server blasting `stream_delta`, measure actual render rate |
| Terminal buffer cap | Stable at 50k chars, no growth | Monitor buffer length over time |

### WebSocket Performance

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Message latency (localhost) | < 5ms roundtrip | `ping/pong` timestamp delta |
| Message latency (tunnel) | < 200ms roundtrip | Same, over Cloudflare tunnel |
| Concurrent session event fan-out | 5 sessions, all events delivered < 50ms | Timestamp on server send vs. client receive |
| Reconnection time | < 3 seconds to re-auth | Measure from disconnect to auth_ok |

### UI Performance

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Sidebar render with 10 repos, 50 sessions | < 100ms | React Profiler or `performance.mark()` |
| Tab switch latency | < 200ms to first paint | Time from click to terminal visible |
| History replay for 500 messages | < 2 seconds | Time from switch_session to last message rendered |
| Dashboard initial load | < 1.5 seconds | Playwright `page.goto()` to interactive |

### Benchmark Test Script

Create `packages/server/bench/` with scripts that:
1. Spawn a server with mock sessions
2. Connect N clients
3. Blast messages and measure throughput
4. Report metrics as JSON for CI tracking

---

## Cross-Device Testing Strategy

Cross-device sync is a core promise of the product. Testing it requires coordinating multiple clients against one server.

### Approach: Shared Mock Server + Parallel Test Runners

```
                  Mock Server (port 9876)
                 /          |            \
    Playwright (desktop)  Maestro (mobile)  WS test client
```

**Scenarios to test:**

1. **Session visibility sync**: Desktop creates session -> mobile `list_sessions` response includes it
2. **Message delivery sync**: Desktop sends `input` -> mobile receives `stream_delta` for same session
3. **Session lifecycle sync**: Mobile destroys session -> desktop `session_list` update arrives
4. **Concurrent input**: Both clients send `input` simultaneously -> server queues correctly, no messages lost
5. **Reconnection sync**: Desktop disconnects and reconnects -> receives full history replay, mobile is unaffected

**Practical implementation:**

For CI, use a shared mock server (extend `packages/app/.maestro/mock-server.mjs` to support multi-client scenarios). Run Playwright desktop tests and a Node.js WS client (simulating mobile) in parallel. Maestro is harder to run in CI headlessly, so the mobile side uses a programmatic WS client instead.

For local dev, the existing `docs/smoke-test.md` covers the manual cross-device flow.

---

## Known Failure Modes (What Breaks in Practice)

From experience shipping desktop apps, here is what will break:

### 1. xterm.js Memory Leaks with Multiple Instances

**Risk:** Opening and closing tabs creates and destroys xterm.js Terminal instances. If cleanup is not thorough (dispose listeners, detach DOM, cancel animations), memory grows until the app is sluggish.

**Mitigation:** Write a memory leak test: open 10 tabs, close them, force GC, measure heap. Repeat 5 times. Heap should be stable (+/- 10%).

### 2. WebSocket Reconnection Race Conditions

**Risk:** Desktop app reconnects while server is broadcasting a history replay. Client receives partial replay + live events interleaved.

**Mitigation:** The existing `isSessionSwitchReplay` flag in the mobile app handles this. Ensure the desktop store has the same guard. Write a test that simulates reconnection during replay.

### 3. Tauri WebView CSP Blocking localhost

**Risk:** The CSP in `tauri.conf.json` currently allows `http://localhost:*` and `ws://localhost:*`. When the server port changes or tunnel URLs are loaded, the WebView silently blocks connections.

**Mitigation:** Integration test: Start server on random port, verify WebView can connect. Test with various CSP configurations.

### 4. Node.js Child Process Zombies

**Risk:** `ServerManager.stop()` sends SIGTERM then waits 5 seconds before SIGKILL. If the Node process spawns grandchild processes (cloudflared, claude), those can orphan.

**Mitigation:** Write a Rust test for `ServerManager` that verifies no orphaned processes after stop. Check `ps` output after test teardown.

### 5. State Desync Between Desktop and Mobile

**Risk:** Desktop and mobile maintain independent Zustand stores. If the server sends a session_list update and one client misses it (network glitch), stores diverge.

**Mitigation:** Periodic reconciliation test: After a test scenario, both clients request `list_sessions` and verify they agree. The existing mobile reconnection flow re-requests state; verify the desktop does the same.

### 6. Dashboard Build Not Shipped

**Risk:** The React dashboard is built by Vite into `packages/server/src/dashboard/dist/`. If the build step is forgotten or the dist directory is gitignored, users get a blank page.

**Mitigation:** CI check: After `npm install`, verify `packages/server/src/dashboard/dist/index.html` exists and contains `<div id="root">` (or whatever the mount point is). Add a `postinstall` or `prepare` script that builds the dashboard.

---

## Recommended Test Infrastructure Setup (Immediate)

Before Phase 0 work begins, invest 2-3 days in test infrastructure:

### Day 1: Server Test Framework

```bash
cd packages/server
npm install -D vitest
```

Create `vitest.config.js`:
```js
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.js'],
  },
})
```

Add to `package.json`:
```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

Write the first 3 tests: `safeTokenCompare`, `formatIdleDuration`, one schema validation test.

### Day 2: Playwright Setup for Dashboard

```bash
npm install -D @playwright/test
npx playwright install chromium
```

Create `packages/server/e2e/` with a test that:
1. Starts the server on a random port
2. Opens the dashboard in Playwright
3. Asserts basic rendering
4. Tears down

This becomes the visual regression baseline for Phase 1.

### Day 3: Rust Test Infrastructure

In `packages/desktop/src-tauri/`, add unit tests to `server.rs`:
- `ServerManager::new()` initializes with correct defaults
- `resolve_cli_js()` finds cli.js in monorepo layout
- `check_cloudflared()` returns `false` when binary not on PATH

Run with `cd packages/desktop/src-tauri && cargo test`.

---

## CI Pipeline Recommendation

```yaml
# .github/workflows/test.yml
jobs:
  server-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: cd packages/server && npm test

  app-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: cd packages/app && npx jest --ci

  desktop-rust-tests:
    runs-on: macos-latest  # Tauri needs macOS for WebView
    steps:
      - run: cd packages/desktop/src-tauri && cargo test

  dashboard-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx playwright install chromium
      - run: cd packages/server && npx playwright test

  # Added in Phase 2:
  desktop-e2e:
    runs-on: macos-latest
    steps:
      - run: cargo tauri build --debug
      - run: npx playwright test --config=e2e/tauri.config.ts
```

---

## Summary: Test Investment Per Phase

| Phase | New Tests Needed | Effort | Priority |
|-------|-----------------|--------|----------|
| **Pre-Phase 0** | Server test framework + first tests | 2-3 days | CRITICAL |
| **Phase 0** | 15-20 server unit/integration tests | 2 days | CRITICAL |
| **Phase 1** | Dashboard E2E baseline + React parity tests | 3-4 days | HIGH |
| **Phase 2** | Protocol tests + sidebar/tab component tests + multi-session E2E | 4-5 days | HIGH |
| **Phase 3** | Incremental feature tests | 2-3 days | MEDIUM |
| **Phase 4** | Per-panel test suites | 1-2 days per panel | MEDIUM |

**Total test investment: ~15-20 days across the full roadmap**, roughly 20% of total development time. This is appropriate for a project transitioning from prototype to daily-driver desktop app.

The most important single action is **setting up Vitest for the server package and writing the Phase 0 regression tests**. Everything else builds on that foundation. Without server-side tests, the new protocol messages for Phase 2 (`subscribe_sessions`, `session_activity`, `list_repos`) will ship without verification, and the `_broadcastToSession` bug fix will have no regression guard.
