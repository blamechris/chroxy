# Builder's Audit: Local Desktop Chat Hub for Chroxy

**Agent**: Builder -- Pragmatic full-stack dev who will implement this. Revises effort estimates, identifies file-by-file changes.
**Overall Rating**: 3.8 / 5
**Date**: 2026-02-24

---

## Section Ratings

| Section | Rating | Justification |
|---------|--------|---------------|
| Existing Foundation | 4/5 | Tauri v2 app + dashboard + mature WS protocol = 80% of the infrastructure exists |
| Implementation Effort | 4/5 | Phase 1 MVP (polished dashboard) achievable in ~5 days; React rewrite is a separate effort |
| Architecture Soundness | 4/5 | Client-server via WebSocket, Tauri shell, local-first -- all proven patterns |
| Code Reuse Potential | 3/5 | Mobile app has excellent components but React Native != React DOM -- ports needed, not copies |
| Missing Pieces | 3/5 | Terminal view, client persistence, sidebar layout, syntax highlighting all need building |

---

## Top 5 Findings

### 1. Tauri App Is 80% Complete for MVP

The existing `packages/desktop/` has everything needed for the "shell" of a desktop hub:
- Server lifecycle management (start/stop/restart with health polling)
- Tray icon with menu (Start Server, Stop Server, Restart, Open Dashboard, Settings, Quit)
- Autostart at login
- Config auto-generation on first run
- WebView window management with toggle/navigate/focus
- Settings persistence (theme, autostart, server options)

What's missing is entirely on the frontend side (the dashboard UI inside the WebView).

**Evidence:** `packages/desktop/src-tauri/tauri.conf.json` already points `frontendDist` at `../dist`, and `window.rs` loads `http://localhost:{port}/dashboard?token={token}` into the WebView.

### 2. Phase 1 MVP: Polish Dashboard (~5 days)

Without any framework migration, the dashboard can be significantly improved:

| Feature | Effort | Approach |
|---------|--------|----------|
| Vertical sidebar for sessions | 1 day | Replace horizontal tab bar with collapsible sidebar |
| localStorage persistence | 0.5 day | Save messages/scroll per session to localStorage |
| Syntax highlighting for code blocks | 1 day | Add highlight.js or Prism.js (already bundled patterns in mobile app's `utils/syntax/`) |
| xterm.js terminal view | 1 day | Import xterm.js + FitAddon, add view switcher tab |
| Permission countdown timer | 0.5 day | Port `PermissionCountdown` logic from mobile app |
| Desktop notifications for permissions | 0.5 day | Wire Tauri notification plugin for permission prompts |
| Keyboard shortcuts expansion | 0.5 day | Add Ctrl+Tab (cycle sessions), `/` (focus input), Ctrl+` (toggle terminal) |

### 3. Phase 2: React Frontend (2-3 weeks, deferred)

For a production-grade desktop hub, the dashboard should be rewritten in React + TypeScript:

- Create `packages/desktop/src/` with Vite + React + TypeScript
- Extract `packages/shared/` for WS protocol types (from `packages/app/src/store/types.ts`)
- Port connection store pattern from mobile app's Zustand store
- Build desktop-specific components: sidebar, split panes, file browser, diff viewer
- Tauri v2's `frontendDist` already supports pointing at a built web app

This is a larger effort but would bring the desktop UI to parity with the mobile app.

### 4. Component Port Strategy

Components that can be ported from mobile to desktop web:

| Mobile Component | Portability | Notes |
|-----------------|-------------|-------|
| `MarkdownRenderer.tsx` | High | Replace `react-native` Text/View with HTML elements |
| `PermissionDetail.tsx` | High | Mostly logic + styling, easy to port |
| `DiffViewer.tsx` | High | Already uses web-standard patterns |
| `FileBrowser.tsx` | High | FlatList → virtualized list |
| `ChatView.tsx` | Medium | Core logic portable, UI needs rethinking for desktop |
| `TerminalView.tsx` | Low | Uses WebView wrapper; desktop can use xterm.js directly |
| `InputBar.tsx` | Medium | Voice input is mobile-specific; keyboard UX differs |

### 5. Server Changes: None Required

The server already supports everything the desktop hub needs:
- Multi-session management (`session-manager.js`)
- Full WS protocol for all features (chat, terminal, files, diffs, checkpoints, plan mode)
- Dashboard served at `/dashboard`
- Multi-client awareness (`_primaryClients` in `ws-server.js`)
- Session state persistence and restoration

The Tauri app manages the server lifecycle. No server modifications needed for Phase 1.

---

## Recommendations

1. **Ship Phase 1 MVP first** -- Polish the existing dashboard within the Tauri shell. This gets a usable desktop experience out quickly without a framework migration.
2. **Defer React rewrite to Phase 2** -- Only start the React rewrite after Phase 1 proves the desktop hub has user demand.
3. **Extract `packages/shared/` early** -- Even for Phase 1, extract WS protocol types so the dashboard and mobile app stay in sync.
4. **Add xterm.js to dashboard as priority #1** -- The terminal view is the single biggest feature gap. Desktop users expect to see terminal output.
5. **Keep Tauri shell thin** -- The Rust code is already well-structured. Resist adding features to the Rust layer that belong in the web frontend.

---

## Verdict

The Chroxy desktop chat hub is more "finish what's started" than "build from scratch." The Tauri v2 shell is solid, the server infrastructure is mature, and the WS protocol is comprehensive. A 5-day sprint on the dashboard could produce a usable MVP. The React rewrite is the right long-term play but should be deferred until the MVP validates demand. The biggest risk is over-engineering Phase 1 when a polished vanilla JS dashboard inside the existing Tauri shell would serve 80% of the use case.
