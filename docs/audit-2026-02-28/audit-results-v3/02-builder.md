# Builder's v3 Re-Audit: Desktop Architecture Audit

**Agent**: Builder -- Pragmatic full-stack dev re-verifying effort estimates against source code
**Previous Rating (v2)**: 3.5 / 5
**Updated Rating (v3)**: 3.5 / 5 (unchanged, but priority matrix adjustments below)
**Date**: 2026-02-28

---

## Methodology

Re-read every file referenced in the v2 master assessment's priority matrix. Verified effort estimates by counting actual lines of code, identifying component boundaries, and tracing data flows through the real call graph. File:line references below point to the exact code that drives each estimate.

---

## Section-by-Section Ratings

| Section | v2 Rating | v3 Rating | Change | Rationale |
|---------|-----------|-----------|--------|-----------|
| Message Synchronization | 4/5 | 4/5 | -- | Still accurate. `_broadcastToSession` confirmed broken at `ws-server.js:1038-1044`. |
| Repository & Session Mgmt | 4/5 | 4/5 | -- | `maxSessions` confirmed configurable via constructor (`session-manager.js:75`). Audit got this wrong. |
| Tunnel Implementation | 5/5 | 5/5 | -- | Tunnel adapter pattern confirmed solid. Recovery code at `tunnel/base.js:92-144` is clean. |
| WebSocket Layer | 3/5 | 3/5 | -- | `seq` at `ws-server.js:1198-1200` confirmed. Protocol proposals still premature. |
| Data Flow Diagram | 5/5 | 5/5 | -- | Universally useful reference. |
| Proposed Protocol | 2/5 | 2/5 | -- | Still over-engineered. Correctly deferred by v2 master. |

---

## Priority Matrix Re-Verification

### Immediate (This Week) -- All Estimates Confirmed Accurate

| Action | v2 Estimate | v3 Revised | Rationale |
|--------|-------------|------------|-----------|
| Fix `config.json` permissions in `setup.rs` | 30 min | **15 min** | Single line change. `setup.rs:34` uses `fs::write()`. Replace with `std::os::unix::fs::PermissionsExt` + `set_permissions()` after write. Trivial. |
| Remove token from HTML/URL rendering | 2-4 hours | **2-4 hours** | Confirmed. `dashboard.js:136-140` embeds token in `window.__CHROXY_CONFIG__`. `window.rs:25-27` passes token in URL query string. Need to switch to HttpOnly cookie or session-based auth for the dashboard route. Involves changes to both `ws-server.js` (dashboard route handler) and `window.rs` (URL construction). 2-4 hours is right. |
| Add `safeTokenCompare` tests | 30 min | **20 min** | `crypto.js:115-135` has 5 code paths. Zero tests in `crypto.test.js`. The function is 20 lines. Writing 7 test cases is mechanical. Slightly faster than estimated. |
| Fix EventNormalizer completeness test | 20 min | **20 min** | Accurate. Need to add missing event types to test fixture. |

**Net assessment**: Immediate items are well-scoped. Total: 3-5 hours. Could be done in a single sitting.

---

### Short-term (Weeks 1-4) -- Several Estimates Need Revision

| Action | v2 Estimate | v3 Revised | Rationale |
|--------|-------------|------------|-----------|
| Surface tunnel status in tray menu | 1-2 days | **2-3 days** | Harder than estimated. Zero tunnel event wiring exists in the Rust side. `lib.rs` (452 lines) has only tray menu handlers -- no event listeners from the Node process. The Node server emits tunnel events (`tunnel_lost`, `tunnel_recovering`, etc.) but only over WebSocket. To surface in the tray, you need either: (a) parse Node stdout for tunnel events (fragile), or (b) add Tauri command that queries server health endpoint for tunnel status (reliable but requires new JSON field in health response + new Rust polling loop). Neither is trivial. |
| Add tunnel restart to tray menu | 1 day | **30 min** | Much easier than estimated. The tray already has restart (`handle_restart` at `lib.rs:323-338`). Tunnel restart IS a server restart -- the tunnel is a child of the server process. Just need to wire a dedicated menu item or just relabel. Unless the intent is to restart ONLY the tunnel without restarting the server, which would require a new WS message type + handler. Clarify the UX goal. As "restart server" alias: 30 min. As "tunnel-only restart": 2-3 days. |
| Fix `_broadcastToSession` to actually filter | 1-2 days | **4-8 hours** | Confirmed broken at `ws-server.js:1038-1044`. The default filter is `() => true` -- sends to ALL authenticated clients regardless of which session they're viewing. Fix: add `client.activeSessionId === sessionId` check. But requires verifying `activeSessionId` is consistently set on `switch_session` handling (`ws-message-handlers.js`). One-line fix in theory, but need to audit all 8 callers of `_broadcastToSession` to confirm they all should filter. Some callers (like `primary_changed` at line 1089) correctly broadcast to everyone. Need a design decision: always filter by active session, or make it caller's choice. 4-8 hours including testing. |
| Add orphan process detection on startup | 1-2 days | **1 day** | The PID is already written to `~/.chroxy/connection.json` (via `connection-info.js:14-18`, called from `server-cli.js` at 4 locations). The Rust `ServerManager` (`server.rs:93`) does NOT check for stale PIDs before starting. Fix: on `start()`, read `connection.json`, check if PID is alive (`kill(pid, 0)`), if alive refuse to start or kill it. Straightforward. 1 day is right. |
| Add re-entry guard to tunnel recovery | 30 min | **30 min** | Confirmed no guard exists. `tunnel/base.js:92-144` has a while loop that calls `_startTunnel()` synchronously. If the process close handler fires during recovery (e.g., the newly spawned tunnel dies immediately), you'd get nested recovery attempts. Simple boolean flag. 30 min accurate. |
| Permission notification when window hidden | 1-2 days | **1 day** | Currently: `dashboard-app.js:1499` fires browser `Notification` only when `!document.hasFocus()`. When the Tauri window is HIDDEN (close-hides-to-tray per `window.rs:57`), `document.hasFocus()` returns false, so the browser Notification API fires -- but Tauri WebView browser notifications may not render when the window is hidden (depends on macOS WebView behavior). Fix: use Tauri's `tauri-plugin-notification` (already in `Cargo.toml:14`) to send native OS notifications. Requires a Tauri command handler or `app.emit()` event from the WebView side. 1 day. |
| Replace `win.eval()` with `app.emit()` events | 1 day | **2-4 hours** | Only ONE `eval()` call exists: `window.rs:85-88`. It calls `window.__startPolling(port, token, tunnelMode)`. Replace with `app.emit("start_polling", payload)` from Rust, and `listen("start_polling", ...)` in the fallback page JS. `withGlobalTauri` is `false` in `tauri.conf.json:9`, so need to either set it to `true` or use the Tauri plugin JS SDK. If we set `withGlobalTauri: true`, the JS side gets `window.__TAURI__`. Either way, this is a small change: 1 Rust emit, 1 JS listener. 2-4 hours. |

---

### Medium-term (Months 1-3) -- Two Major Revisions

#### Vite Pipeline: v2 said "1-2 weeks", I now say 2-3 days

The v2 master assessment says "1-2 weeks". My v2 individual estimate said "1-2 days". After re-reading the code, I'm settling on **2-3 days**. Here's why:

**Current state**:
- `packages/desktop/package.json` has zero frontend tooling -- only `cargo tauri dev/build`
- `packages/desktop/dist/index.html` is a 394-line hand-written fallback page with inline CSS and JS
- `tauri.conf.json:6` points frontend dist to `"../dist"` (static files)
- No `vite.config.ts`, no React, no TypeScript, no bundler

**What "Vite pipeline" means**:
1. `npm install vite @vitejs/plugin-react react react-dom typescript` (10 min)
2. Create `vite.config.ts` with Tauri plugin (10 min)
3. Create `src/main.tsx` entry point (10 min)
4. Move the existing fallback page to a React component (2-4 hours)
5. Update `tauri.conf.json` frontendDist to Vite dev server in dev mode (10 min)
6. Wire `tauri dev` to start Vite dev server (30 min, via `beforeDevCommand` in tauri.conf)
7. Verify hot reload works end-to-end (1-2 hours debugging)
8. Verify production build works (`tauri build` runs Vite build first) (1-2 hours)

The "1-2 weeks" estimate in the master assessment likely conflates Vite setup with the React dashboard rewrite. The pipeline itself is 2-3 days. Tauri's official docs have a Vite + React template that does most of this.

#### Dashboard Rewrite: v2 said "12-18 days", I now say 8-12 days

After reading all 1,793 lines of `dashboard-app.js` line-by-line, I have a sharper estimate:

**Complexity breakdown by feature** (with actual line counts):

| Feature | Lines | React Effort | Notes |
|---------|-------|-------------|-------|
| Syntax highlighter (16 langs) | 100-313 (213 lines) | 0 days | **Drop-in library** (Prism/Shiki/Highlight.js). This is 12% of the file that costs zero effort. |
| Markdown renderer | 361-428 (67 lines) | 0 days | **Drop-in library** (react-markdown). Another 4% eliminated. |
| WebSocket connection/reconnect | 1204-1272 (68 lines) | 1-2 days | Custom hook. Map existing reconnect logic. |
| Message handler (switch statement) | 1306-1663 (357 lines) | 2-3 days | Zustand store + action dispatch. Most complex piece. |
| Message rendering (chat bubbles) | 611-815 (204 lines) | 2-3 days | Components: MessageBubble, ToolBubble, PermissionPrompt, QuestionPrompt, ThinkingIndicator. |
| Session tabs + modals | 818-1090 (272 lines) | 1-2 days | SessionTabs, CreateSessionModal, QRModal, HistoryModal. |
| Terminal (xterm.js) | 506-595 (89 lines) | 1 day | xterm.js + React wrapper. Well-contained. |
| Status bar + selects | 1093-1200 (107 lines) | 0.5 days | StatusBar, ModelSelect, PermissionSelect. Trivial. |
| Input bar + keyboard shortcuts | 1665-1793 (128 lines) | 0.5 days | InputBar component + global keydown handler. |
| localStorage persistence | 444-504 (60 lines) | 0.5 days | Custom hook or Zustand middleware. |
| Plan approval UI | 1628-1765 (relevant parts ~30 lines) | 0.5 days | PlanBanner, PlanApprovalCard. Small. |

**Total**: 8-12 days.

The v2 estimate of "12-18 days" was too high because it assumed the syntax highlighter and markdown renderer needed porting. They don't -- they're the first things you replace with libraries. That's 280 lines (16% of the file) that evaporate.

The v2 estimate also didn't account for the mobile app's existing patterns. `packages/app/` already has Zustand stores, WebSocket message handling, and React component patterns that can be studied (not copied directly, since app is React Native, but the architecture is transferable). The dashboard can follow the same patterns for `message-handler.ts` and `connection.ts`.

**Risk**: The markdown renderer handles streaming -- `dashboard-app.js:1446-1451` re-renders markdown on every `stream_delta` via `target.innerHTML = renderMarkdown(raw)`. In React, this needs careful memoization to avoid re-rendering the entire chat history on every token. The mobile app solves this with delta batching (`message-handler.ts:931-972`). Expect 1-2 extra days debugging streaming performance if naive approach is taken.

#### Tauri Command Bridge Scaffold: v2 said "1 week", I confirm 3-5 days

**Current state**: Zero `#[tauri::command]` handlers exist. `withGlobalTauri: false` in `tauri.conf.json:9`. No `.invoke()` calls from any JS.

**What's actually needed** (for the dashboard rewrite):

The dashboard currently connects via `ws://localhost:{port}` to the Node server. In a React dashboard, this pattern works fine. The Tauri command bridge is NOT a prerequisite for the dashboard rewrite -- the dashboard can use WebSocket just like it does today.

What the Tauri command bridge IS needed for:
1. **Server management**: Start/Stop/Restart from the React UI (currently tray-only). 3-4 commands.
2. **Settings read/write**: Load/save desktop settings. 2 commands.
3. **Tunnel status query**: Poll tunnel state. 1 command.
4. **Window management**: Show/hide, fullscreen. 2 commands.

That's ~8-10 commands total. Each command is ~20 lines of Rust + a JS invoke wrapper. The scaffolding (setting `withGlobalTauri: true`, registering commands in `lib.rs`, creating a TypeScript invoke wrapper) takes 1 day. The individual commands take 2-3 days. **3-5 days total**.

**Critical insight**: The Tauri command bridge and the dashboard React rewrite are PARALLEL tasks, not sequential. The dashboard can launch on WebSocket alone while the command bridge is built in parallel. The v2 master assessment lists them as sequential prerequisites ("Vite -> Tauri bridge -> Dashboard"), but only Vite is truly a prerequisite.

---

### Deferred Items -- All Correctly Deferred

Every item in the "Deferred (Probably Never)" list is correctly placed. No changes needed.

| Item | Verdict |
|------|---------|
| Binary serialization | Correct to defer. `stream_delta` is ~90 bytes. |
| Message priority | Correct to defer. 1-2 clients. |
| Protocol v2 | Correct to defer. Monorepo clients. |
| Shared-memory terminal | Correct to defer. Doesn't exist in Tauri. |
| Session templates | Correct to defer. Saves 5 seconds. |
| Filesystem repo discovery | Correct to defer. 5-7 days for debatable UX. |

---

## Top 5 Findings (v3)

### 1. Dashboard Rewrite Is 8-12 Days, Not 12-18

The v2 estimate over-counted by including the syntax highlighter (213 lines) and markdown renderer (67 lines) which are replaced by off-the-shelf libraries in a React rewrite. The remaining 1,513 lines decompose into ~10 React components + 1 Zustand store + 1 WebSocket hook. The mobile app's existing patterns (`message-handler.ts`, `connection.ts`) provide architectural templates.

**File references**: `dashboard-app.js:100-313` (syntax highlighter, replaced by Prism/Shiki), `dashboard-app.js:361-428` (markdown renderer, replaced by react-markdown).

### 2. Vite Pipeline Is 2-3 Days, Not 1-2 Weeks

The v2 master assessment inflated this by conflating Vite setup with the dashboard rewrite. Current state: `packages/desktop/package.json` has zero frontend dependencies, `dist/index.html` is a hand-written fallback page, and `tauri.conf.json:6` points to `"../dist"`. Tauri has official Vite + React templates. The pipeline is: install deps, create config, create entry point, move fallback page, wire `beforeDevCommand`. 2-3 days with debugging.

**File references**: `packages/desktop/package.json` (zero frontend deps), `packages/desktop/dist/index.html` (394 lines, static), `packages/desktop/src-tauri/tauri.conf.json:6` (`frontendDist: "../dist"`).

### 3. Tauri Command Bridge Is Parallel to Dashboard, Not a Prerequisite

The v2 priority matrix lists "Vite + React build pipeline (1-2 weeks)" then "Tauri command/event bridge scaffold (1 week)" then "Dashboard React rewrite (12-18 days)" as a sequential chain totaling 5-7 weeks. In reality, the dashboard can launch on `ws://localhost` (the current architecture) without any Tauri commands. The command bridge only adds native integration (start/stop server, settings, window management). These are independent work streams.

**Revised critical path**: Vite pipeline (2-3 days) -> Dashboard React rewrite (8-12 days) = **2-3 weeks** instead of 5-7 weeks. Tauri command bridge (3-5 days) runs in parallel.

### 4. "Surface Tunnel Status in Tray" Is Underestimated at 1-2 Days

The v2 master estimates 1-2 days. Actual effort is 2-3 days because there is ZERO event wiring between the Node server process and the Tauri tray. The Node server emits tunnel events over WebSocket, but the Rust side only monitors the server via HTTP health polling (`server.rs:237-305`). To surface tunnel status, you need to either: (a) add a tunnel status field to the health endpoint JSON, then parse it in the Rust health poll loop, then update a tray menu item -- or (b) add a new WebSocket client in Rust that subscribes to tunnel events. Both approaches require new code in both Node and Rust.

**File references**: `server.rs:237-305` (health poll -- no tunnel status parsing), `lib.rs:231-239` (menu state update -- only running/stopped, no tunnel state).

### 5. The `_broadcastToSession` Fix Needs a Design Decision Before Coding

The v2 master says "Fix `_broadcastToSession` to actually filter by session" at 1-2 days. The fix itself is 1 line (`ws-server.js:1041`: add `&& client.activeSessionId === sessionId`). But 3 of the 8 callers of `_broadcastToSession` intentionally broadcast to ALL clients (e.g., `primary_changed` at `ws-server.js:1089`, `session_context` in `ws-forwarding.js:182`). The design question: should `_broadcastToSession` always filter by active session (changing behavior for these callers), or should it be opt-in (add a separate `_broadcastToActiveSession` method)? This needs a 30-minute design discussion before writing code. Effort after that: 4-8 hours including tests.

**File references**: `ws-server.js:1038-1044` (current implementation, no filter), `ws-server.js:1089` (caller that should broadcast to all), `ws-forwarding.js:74` (caller that should filter).

---

## Revised Effort Summary

| Work Item | v2 Master Estimate | v3 Revised Estimate | Delta |
|-----------|-------------------|---------------------|-------|
| **Immediate items (total)** | ~4 hours | ~3.5 hours | Slightly faster |
| Fix config.json permissions | 30 min | 15 min | -50% |
| Remove token from HTML/URL | 2-4 hours | 2-4 hours | Same |
| safeTokenCompare tests | 30 min | 20 min | -33% |
| EventNormalizer test fix | 20 min | 20 min | Same |
| **Short-term items (total)** | ~7-11 days | ~5-8 days | -25% |
| Tunnel status in tray | 1-2 days | 2-3 days | +50% |
| Tunnel restart in tray | 1 day | 30 min (if alias) | -90% |
| Fix _broadcastToSession | 1-2 days | 4-8 hours | -50% |
| Orphan process detection | 1-2 days | 1 day | Same |
| Tunnel recovery re-entry guard | 30 min | 30 min | Same |
| Permission notification | 1-2 days | 1 day | Same |
| Replace win.eval() | 1 day | 2-4 hours | -60% |
| **Medium-term items (total)** | ~6-9 weeks | ~3-4 weeks | -50% |
| Vite pipeline | 1-2 weeks | 2-3 days | -70% |
| Tauri command bridge | 1 week | 3-5 days (parallel) | -30% |
| Dashboard React rewrite | 12-18 days | 8-12 days | -33% |

**Total medium-term critical path**: 2-3 weeks (Vite + Dashboard in series). Command bridge is parallel. v2 implied a 5-7 week sequential chain.

---

## What's Missing from the Priority Matrix

### 1. Dashboard CSS Migration (Not Mentioned)

`dashboard.css` is 908 lines of hand-written CSS. A React rewrite will need to either: (a) keep the CSS as-is and add React className bindings (fastest, 0 extra days), (b) migrate to CSS modules or Tailwind (2-3 extra days), or (c) use a component library like Radix/shadcn (3-5 extra days but better long-term). The priority matrix doesn't mention this decision. I recommend option (a) for the initial rewrite -- just import the existing CSS file. Refactor later.

### 2. Hot Reload Testing for Tauri + Vite (Not Mentioned)

Tauri's `cargo tauri dev` with a Vite frontend requires `beforeDevCommand: "npm run dev"` and `devUrl: "http://localhost:5173"` in `tauri.conf.json`. Getting hot reload to work reliably (especially with WebSocket connections to the Node server at a DIFFERENT port) requires CORS config and proxy setup. Budget 0.5-1 day for this within the Vite pipeline estimate.

### 3. Streaming Markdown Performance in React (Not Mentioned)

The current dashboard re-renders markdown on every `stream_delta` by setting `innerHTML` (`dashboard-app.js:1450`). In React, naive implementation causes full virtual DOM diffing on every token. The mobile app mitigates this with 100ms delta batching (`message-handler.ts:931-972`). The React dashboard needs the same pattern. This is accounted for in my 8-12 day estimate above but should be called out as a specific risk.

---

## Overall Rating: 3.5 / 5

Rating unchanged from v2. The audit document remains a strong inventory but a weak implementation guide. The v2 master assessment correctly identified what to defer and what to prioritize. The main correction needed is in the medium-term effort estimates: the critical path is 2-3 weeks, not 5-7 weeks, because (a) Vite is 2-3 days not 1-2 weeks, (b) dashboard is 8-12 days not 12-18 days, and (c) Tauri command bridge is parallel work not a serial prerequisite.

The security fixes in "Immediate" are correctly scoped and should be done first. The short-term items are mostly well-estimated with a few items that are easier than stated (win.eval replacement, _broadcastToSession fix) and one that's harder (tunnel status in tray).

---

*Builder v3 -- re-verified against source code on 2026-02-28*
