# Minimalist v3: Desktop Architecture Audit

**Perspective**: Ruthless engineer who believes the best code is no code
**v2 Rating**: 2.0/5
**Date**: 2026-02-28

---

## Task 1: Is the "Deferred (Probably Never)" List Complete?

The v2 master deferred 6 items. I reviewed each against actual code and agree with all 6. But the list is **incomplete**. These should also be deferred:

### Move to "Deferred (Probably Never)"

**1. Socket.IO v4-style connection state recovery** (currently Medium-term, est. 2-3 days)

The master assessment placed this in Medium-term based on the Historian's argument that "full replay of 500 messages over cellular is slow." I checked the actual replay path. The server replays messages from the in-memory ring buffer (`session-manager.js` 500-message cap). At ~200 bytes per message average, that is 100KB. Over a 1Mbps cellular link, 100KB takes 0.8 seconds. Over Cloudflare's CDN edge, probably less. The client already deduplicates against its local cache (`message-handler.ts:859-869`).

Building sequence-based differential sync to save <1 second on a reconnect that happens a few times per session is not worth 2-3 days of engineering plus the permanent maintenance burden of a second replay code path.

**2. Per-device token derivation** (currently Medium-term, est. 1-2 weeks)

This is a single-user tool. The user is already authenticated by physical access to the machine running the server. Token theft requires either (a) intercepting the Cloudflare tunnel URL + token, which E2E encryption already mitigates, or (b) access to `~/.chroxy/config.json`, which means the attacker is already on the machine. Per-device tokens solve a multi-user problem that does not exist. The token-in-HTML fix (Immediate) is the real fix. After that, the single shared token is adequate for a personal dev tool.

**3. Vite + React build pipeline** (currently Medium-term, est. 1-2 weeks)

This is listed as a "prerequisite" for the dashboard React rewrite. I address the React rewrite below (Task 4), but the build pipeline itself should be deferred because there is no React code to build. Adding Vite to a project that currently has zero frontend build steps (the dashboard is a single IIFE served inline) creates a new dependency chain (Vite, React, HMR, bundling) for no immediate value. If you never do the React rewrite, you never need Vite.

**4. Tauri command/event bridge scaffold** (currently Medium-term, est. 1 week)

The current desktop app has zero `#[tauri::command]` handlers. `withGlobalTauri: false` in `tauri.conf.json`. The only Rust-to-JS communication is one `win.eval()` call in `window.rs:85-88` that passes port/token to the loading page's polling function. The dashboard is loaded as an external URL (`http://localhost:{port}/dashboard`) in a WebView -- it has no Tauri integration at all and cannot call Tauri commands.

Building a "bridge scaffold" presupposes that the desktop UI needs to talk to Rust directly. It does not. The dashboard talks to the Node.js server over WebSocket, same as the mobile app. This is the correct architecture for a thin desktop wrapper. The Rust layer's job is process management and tray menu -- both of which already work.

### Updated "Deferred (Probably Never)" List (10 items)

Original 6:
1. Binary serialization (MessagePack/CBOR)
2. Message priority system
3. Protocol v2 with backward compatibility
4. Shared-memory terminal buffers
5. Session templates
6. Filesystem repo discovery

Added 4:
7. Socket.IO v4-style connection state recovery
8. Per-device token derivation
9. Vite + React build pipeline
10. Tauri command/event bridge scaffold

---

## Task 2: Should Anything in Short-term / Medium-term Be Cut Entirely?

### Short-term (Weeks 1-4): Assessment

| Action | Verdict | Rationale |
|--------|---------|-----------|
| Surface tunnel status in tray menu | **Keep** | Real UX win. Tunnel events already exist in code (`tunnel/base.js:100-150`). Tray menu is the natural place. |
| Add tunnel restart to tray menu | **Keep** | Already partially implemented -- `handle_restart` in `lib.rs:323-338` restarts the server. Needs a tunnel-only restart path. |
| Fix `_broadcastToSession` to actually filter | **Keep** | Confirmed: `ws-server.js:1038-1043` sends to ALL authenticated clients with `filter = () => true`. No `activeSessionId` check. With 1-2 clients today this is harmless but it is a correctness bug. |
| Add orphan process detection on startup | **Keep** | Real problem per Finding #9. `--no-supervisor` mode has no PID file. |
| Add re-entry guard to tunnel recovery | **Keep** | 30-minute fix, prevents real race condition. |
| Permission notification when window hidden | **Keep** | `window.rs:56-63` intercepts close to hide-to-tray. Hidden window means no permission prompt visible. Real UX gap. |
| Replace `win.eval()` with `app.emit()` events | **Cut entirely** | There is exactly ONE `win.eval()` call (`window.rs:85-88`) that triggers health polling on the loading page. This page is a standalone HTML file in `dist/index.html`. The dashboard itself loads as an external URL and has zero Tauri integration. Replacing this single eval with an event system requires: enabling `withGlobalTauri`, adding a Tauri event listener to the fallback page, importing Tauri JS API. Net result: same behavior, more code, new dependency. The current eval is safe (it calls a known function with port/token values that the Rust code already controls). |

### Medium-term (Months 1-3): Assessment

| Action | Verdict | Rationale |
|--------|---------|-----------|
| Vite + React build pipeline | **Defer** (see Task 1) | No React code exists. Prerequisite for a rewrite that may not happen. |
| Tauri command/event bridge scaffold | **Defer** (see Task 1) | Zero commands exist. Dashboard communicates via WebSocket to Node.js server. |
| Dashboard React rewrite | **Defer** (see Task 4) | 12-18 days for cosmetic improvement to a working UI. |
| Socket.IO v4-style recovery | **Defer** (see Task 1) | Saves <1s on reconnect. |
| Per-device token derivation | **Defer** (see Task 1) | Single-user tool. Fix token-in-HTML instead. |
| Faster startup (pre-warm, keep-alive) | **Keep but reframe** | 10-60s startup is real UX pain. But "pre-warm" is vague. The concrete fix is: keep the server running (auto-start on login, which already works via `tauri_plugin_autostart`). Don't solve startup latency; avoid it. |

**Net result**: Short-term loses 1 item (win.eval replacement). Medium-term loses 4 items to deferral and 1 gets reframed.

---

## Task 3: Minimum Viable Desktop App in 1 Week

The desktop app **already works**. Here is what it does today (verified against source):

**What exists** (`packages/desktop/`, 1,197 lines Rust):
- Tray icon with Start/Stop/Restart (`lib.rs:90-229`)
- Open Dashboard in WebView (`window.rs:24-65`)
- Loading page with health polling and QR code (`dist/index.html`, 395 lines)
- Tunnel mode selection (Quick/Named/None) in tray menu (`lib.rs:123-141`)
- Auto-start on login via LaunchAgent (`tauri_plugin_autostart`)
- Auto-start server on launch (`lib.rs:54-61`)
- Server process management with SIGTERM/SIGKILL (`server.rs:187-229`)
- Health polling with error detection (`server.rs:238-306`)
- Node 22 resolution (Homebrew, nvm, system PATH) (`node.rs`)
- OS notifications (`lib.rs:438-452`)
- Settings persistence (`settings.rs`)
- Close-hides-to-tray (`window.rs:56-63`)
- Window position/size persistence (`lib.rs:67-84`)

**What the dashboard provides** (loaded in WebView, 1,793 lines vanilla JS):
- Full chat interface with markdown rendering
- Syntax highlighting for 16 languages
- xterm.js terminal emulation
- Session tabs (create/rename/destroy)
- Permission prompts with countdown timers
- Plan approval cards
- QR code pairing modal
- Conversation history browser
- Model and permission mode selectors
- Reconnection banner
- Status bar (model, cost, context, agents)
- Keyboard shortcuts
- localStorage persistence
- Dark theme

**This is already a functional desktop app.** The question is not "what do I build in 1 week" -- it is "what 3-4 things would make the existing app notably better in 1 week?"

### The 1-week plan (priority order)

**Day 1-2: Tunnel URL in tray menu + copy to clipboard** (the single most requested desktop feature)

The tray menu currently shows: Start, Stop, Restart, Open Dashboard, settings toggles. It does NOT show the tunnel URL. Users must open the dashboard or check terminal output to find it. The server already broadcasts `tunnel_url` on the `tunnel_recovered` event. Surface this in the tray menu as a static label + "Copy URL" action.

Implementation: Add a `MenuItem` for tunnel URL in `lib.rs`. Parse the URL from server stdout (it is already logged) or add a tiny HTTP endpoint (e.g., `GET /tunnel-info`). Update on server start / tunnel recovery.

**Day 2-3: Fix `config.json` permissions in `setup.rs`** (30 minutes, critical security)

`setup.rs:34` uses `fs::write()` which creates files with 0o644 (world-readable). The token is in this file. Change to use `std::os::unix::fs::OpenOptionsExt` with mode 0o600. This is the v2 assessment's #1 Immediate priority.

**Day 3: Fix orphan process detection** (1 day)

Write a PID file in `--no-supervisor` mode. On startup, check if the PID is still alive. If stale, clean up and proceed. If alive, show "server already running" in tray with option to force-restart.

**Day 3-4: Permission notification when window is hidden** (1 day)

When the window is hidden (close-to-tray behavior), permission requests are invisible. The server already sends push notifications to mobile. For desktop: when a `permission_request` arrives and the dashboard window is hidden, fire an OS notification via `tauri_plugin_notification` with the tool name and a "Click to review" action that shows the window.

Implementation challenge: The dashboard is an external URL in a WebView. The Rust layer has no visibility into WebSocket messages flowing between the dashboard JS and the Node.js server. Two options: (a) add a second WebSocket listener in Rust that subscribes to permission events, or (b) simpler -- have the Node.js server hit a local HTTP callback when permissions are pending and the only connected client has not responded within N seconds. Option (b) avoids Rust WS complexity.

**Day 5: Polish + testing**

Test the full flow: install from scratch, first-run config generation, auto-start, tunnel establishment, QR scanning from mobile, permission approval from desktop.

### What I would NOT build in 1 week

- React rewrite (12-18 days, unnecessary)
- IPC channel (solves no user problem)
- Vite build pipeline (no React = no Vite)
- Tauri command bridge (dashboard uses WebSocket)
- Differential sync (saves <1s)
- Binary serialization (saves 1us)
- Multi-session subscription (no split-pane UI exists)
- Session templates (saves 5s of typing)
- Repo discovery (5-7 days alone)

---

## Task 4: Is the Dashboard React Rewrite Necessary?

**No.**

The v2 master says: "Dashboard React rewrite: 12-18 days, High UX." Let me examine what is actually wrong with the current dashboard.

### What the current dashboard does well

I read `dashboard-app.js` (1,793 lines). It is a single IIFE with ~35 global variables and direct DOM manipulation. The code is not pretty. But it:

- Renders markdown with a hand-rolled renderer (lines 361-428) that handles code blocks, headers, bold, italic, links, blockquotes, lists, and paragraphs. It works.
- Syntax-highlights 16 languages with a custom tokenizer (lines 100-313). It works.
- Manages WebSocket connection, reconnection, auth, history replay. It works.
- Handles session tabs, permission prompts, plan approval, model switching. It works.
- Persists messages to localStorage with debouncing. It works.
- Has a dark theme and keyboard shortcuts. It works.

### What is actually wrong

1. **Session switching flash**: `messagesEl.innerHTML = ""` hard-wipes and re-renders. Visible flash.
2. **No component reuse with mobile**: The mobile app uses React Native components that are completely separate.
3. **Maintenance cost**: 1,793 lines of vanilla JS with 35 globals is harder to extend than React components.

### Why a rewrite is not worth 12-18 days

Point 1 (session flash) can be fixed in the existing code in <1 day. Hide the container, swap content, show. Or maintain a DOM cache per session.

Point 2 (component reuse) is aspirational. The mobile app uses React Native with Zustand. The desktop uses a WebView. Even with a React rewrite, you cannot share React Native components in a web React app without a shared library, which is its own multi-week project. The rendering targets are fundamentally different.

Point 3 (maintenance) is real but proportional. How often does the dashboard change? It is 1,793 lines that are feature-complete. If you are adding features monthly, the maintenance tax matters. If the dashboard is stable, the rewrite buys nothing.

**The honest question**: Would a React dashboard look and feel meaningfully better to the end user? The current dashboard already has syntax highlighting, terminal emulation, markdown rendering, session tabs, permission prompts, a status bar, and a dark theme. A React rewrite would produce the same features with cleaner code internals. The user would not notice.

**Ship the current dashboard.** If in 6 months you are constantly fighting the vanilla JS to add features, reconsider then. Do not spend 12-18 days rewriting working code on spec.

---

## Task 5: Section Ratings

### Section 1: Message Synchronization (2/5)

The section accurately describes the event pipeline (EventNormalizer, delta buffering, WsForwarding). The data flow description is useful reference material. But 3 of 4 recommendations are waste: IPC channel (0.1ms savings), differential sync (<1s savings on localhost), and shared-memory terminal state (impossible in Tauri). The one useful recommendation -- message ack for permission responses -- is buried and under-specified.

### Section 2: Repository and Session Management (3/5)

Accurate inventory of session lifecycle, provider architecture, and state persistence. The checkpoint system description is genuinely useful. Recommendations are mixed: "filesystem repo discovery" is 5-7 days for a feature nobody asked for, "session templates" saves 5 seconds, "make session limit configurable" is trivially one line of code. "Desktop should own session lifecycle" is architecturally sound but does not require code changes -- the desktop already initiates sessions through the dashboard.

### Section 3: Tunnel Implementation (4/5)

Best section of the audit. Accurate description of the adapter registry, recovery logic, and E2E encryption. The recommendation to surface tunnel status in the desktop UI is the single most actionable item in the entire document. Minor deduction: recommends "add tunnel provider selection in desktop UI" when only one provider exists and the adapter registry is already extensible. Build the selector when the second provider ships.

### Section 4: WebSocket / Real-Time Communication (1/5)

The message catalog and protocol description are useful as reference. But every recommendation is over-engineered: message prioritization (1-2 clients, nothing to prioritize), binary serialization (1us savings), shared encryption for broadcast (O(N) where N is 1-2), sequence-based gap detection (already argued against above). The "Schema validation on every message" concern is unfounded -- Zod validation on a discriminated union of 36 types with pre-compiled schemas is negligible cost.

### Section 5: Data Flow Diagram (4/5)

The system architecture diagram and message flow sequences are genuinely excellent. Clear, accurate, and would save any new developer substantial ramp-up time. The reconnection flow diagram matches the actual code. Minor: the diagram shows "Session (max 5)" but the constructor-configurable nature is not noted (per Skeptic's finding).

### Section 6: Proposed Protocol (1/5)

Every proposal should be deferred or discarded:
- Differential sync: <1s savings on reconnect
- IPC channel: technically flawed (Tauri IPC is always JSON, no shared memory)
- Message priority: no contention with 1-2 clients
- Multi-session subscription: no UI for split-pane viewing exists
- Protocol v2: version negotiation for monorepo clients that ship together

The "backward compatibility" section is particularly telling: it proposes maintaining two protocol versions (v1 and v2) for clients in the same repository. This is pure complexity.

### Summary

| Section | Rating | Rationale |
|---------|--------|-----------|
| Message Sync | 2/5 | Good description, 3/4 bad recommendations |
| Repo/Session | 3/5 | Accurate inventory, mixed recommendations |
| Tunnel | 4/5 | Accurate and actionable |
| WebSocket | 1/5 | Reference value only, all recommendations over-engineered |
| Data Flow | 4/5 | Excellent diagrams and sequences |
| Proposed Protocol | 1/5 | Should be entirely discarded |

---

## Top 5 Findings

### 1. The desktop app already works -- the audit treats it as greenfield

The audit's framing ("Recommendations for New Desktop App") implies a new application needs to be built. In reality, `packages/desktop/` is 1,197 lines of working Rust + a 395-line loading page + the full 1,793-line dashboard. It manages the server process, handles tunnel mode, persists settings, auto-starts on login, and loads the feature-complete dashboard in a WebView. The "new desktop app" is 3-4 incremental improvements to existing code.

### 2. 6 of 10 medium-term items should be deferred (probably never)

The v2 master's Medium-term list had 6 items. Four should move to Deferred: Vite build pipeline, Tauri command bridge, Socket.IO recovery, and per-device tokens. One (dashboard React rewrite) should be deferred. One (faster startup) should be reframed as "make auto-start the default" (which it already is -- `auto_start_server` defaults to `true` in `settings.rs:10`).

### 3. The React rewrite proposal costs 12-18 days to reproduce what already works

The dashboard has markdown rendering, syntax highlighting, terminal emulation, session management, permission prompts, and persistence. A React rewrite produces the same features with cleaner internals. The user sees no difference. The session-switch flash (the main UX complaint) is fixable in <1 day without a rewrite.

### 4. Tunnel URL visibility is the actual highest-value desktop feature

Users cannot see the tunnel URL without opening the dashboard or checking terminal output. Adding "Tunnel URL: xxx.trycloudflare.com [Copy]" to the tray menu is ~2 days of work and provides more user value than every proposed protocol enhancement combined.

### 5. The `win.eval()` replacement is unnecessary churn

The v2 master recommends replacing `win.eval()` with `app.emit()` events (Short-term, 1 day). There is exactly one `eval` call in the codebase (`window.rs:85-88`). It calls a known function on a local HTML page that the Rust code controls. Replacing it requires enabling `withGlobalTauri`, adding Tauri JS dependencies to the fallback page, and changing the communication pattern. Same behavior, more code, new coupling.

---

## Overall Rating: 2.5/5

Up from 2.0 in v2, solely because the v2 master assessment correctly identified and deferred the worst proposals. The underlying audit document remains a strong codebase inventory but a poor implementation guide. Its best sections (data flow diagram, tunnel analysis) are reference material. Its worst sections (proposed protocol, message sync recommendations) propose weeks of engineering for microsecond-level improvements on a tool with 1-3 simultaneous clients.

The right path forward is not in this document. It is: fix the security issues (config permissions, token-in-HTML), add tunnel URL to tray menu, fix orphan process detection, add hidden-window permission notifications, and ship. Everything else is premature optimization for a personal dev tool.
