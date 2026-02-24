# Skeptic's Audit: Local Desktop Chat Hub for Chroxy

**Agent**: Skeptic -- Cynical systems engineer who has seen too many designs fail. Cross-references every claim against actual code.
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-24

---

## Section Ratings

| Section | Rating | Justification |
|---------|--------|---------------|
| Feasibility of Vision | 3/5 | The vision is sound but ignores that a Tauri desktop app already exists at `packages/desktop/` |
| Dashboard as Foundation | 2/5 | `dashboard.js` is a 1756-line template literal returning raw HTML. Not suitable as foundation for a rich desktop app |
| Session Persistence | 2/5 | Server-side persistence works (24h TTL), but dashboard has zero client-side persistence. Close the window, lose visual history |
| Protocol Completeness | 4/5 | The WS protocol is comprehensive and well-documented. Dashboard handles maybe 60% of message types |
| Existing Tauri App | 4/5 | `packages/desktop/src-tauri/` has working server lifecycle, tray icon, autostart, health polling. Solid foundation |

---

## Top 5 Findings

### 1. A Tauri v2 Desktop App Already Exists

The proposal to "build a local desktop chat hub" ignores that `packages/desktop/` already has:
- `lib.rs`: Tauri plugin registration (autostart, notification, shell, updater)
- `server.rs`: Full `ServerManager` with start/stop/restart/health-poll
- `node.rs`: Node 22 resolution across Homebrew, nvm, fnm, volta, raw paths
- `window.rs`: Dashboard WebView management with toggle/navigate/focus
- `config.rs`: Config file management (`~/.chroxy/config.json`)
- `settings.rs`: User settings persistence (autostart, theme, server options)
- `setup.rs`: First-run config generation with random UUID token

**Evidence:** `packages/desktop/src-tauri/src/server.rs` -- ~250 lines of Rust managing the full server lifecycle with health polling at 1s intervals, up to 60 retries.

### 2. Dashboard Is a Debugging Tool Promoted to Production

`packages/server/src/dashboard.js` is a single function that returns an HTML string via template literal. It contains:
- Inline CSS (~200 lines)
- Inline JavaScript (~1000 lines)
- HTML structure (~500 lines)
- No module system, no bundler, no component model
- No TypeScript, no type safety
- No client-side state management (DOM manipulation only)
- No client-side persistence (localStorage not used)

This is fine for a debugging/monitoring tool but is not a foundation for a "chat hub" that competes with Chell.sh.

**Evidence:** `dashboard.js:809-1756` -- a single IIFE containing 40+ functions with zero modularity.

### 3. Session Persistence Gap

The server serializes session state to `~/.chroxy/session-state.json` with a 24h TTL (`session-manager.js:491-532`). But the dashboard has no client-side persistence at all. When you close and reopen the dashboard:
- Chat messages are gone (DOM was destroyed)
- History replay sends only the last turn (`ws-server.js:751-774`)
- Scroll position is lost
- Expanded/collapsed state of tool bubbles is lost

The mobile app solved this with `persistence.ts` and `expo-secure-store`. The dashboard has nothing equivalent.

### 4. Terminal View Is Completely Missing from Dashboard

The dashboard ignores `raw` WebSocket events entirely. The mobile app has a full xterm.js terminal emulation (`TerminalView.tsx`, `xterm-html.ts`, `xterm-bundle.generated.ts`). For a "chat hub," the absence of terminal view means developers can't see what Claude Code is actually doing in the terminal -- only the parsed chat output.

### 5. Feature Parity Gap Between Mobile and Dashboard

The mobile app has 18+ components, Zustand store with 50+ actions, and features the dashboard doesn't expose:
- File browser (`FileBrowser.tsx`)
- Diff viewer (`DiffViewer.tsx`)
- Checkpoints/rewind
- Voice input
- Permission countdown timer
- Background agent monitoring
- Context window visualization
- Dev server previews
- Web task delegation

The dashboard surfaces maybe 30-40% of what the server supports.

---

## Recommendations

1. **Don't build a new desktop app -- polish what exists.** The Tauri shell + dashboard architecture is correct. Replace the dashboard's vanilla JS with a proper React frontend.
2. **Add client-side persistence to the dashboard.** Use `localStorage` or IndexedDB for chat history, scroll position, and UI state.
3. **Port xterm.js terminal view from mobile app.** On desktop, xterm.js can run natively (no WebView wrapper needed).
4. **Extract shared types/protocol from mobile app.** Create `packages/shared/` with WS protocol types that both mobile and desktop frontends can consume.
5. **Don't compete with Claude Code Desktop app.** Focus on what it can't do: mobile remote access, tunnel-based connectivity, multi-device session sharing.

---

## Verdict

The "local desktop chat hub" already partially exists. The Tauri shell is solid, the server infrastructure is excellent, and the WS protocol is comprehensive. The gap is entirely in the dashboard UI, which is a quick-and-dirty debugging tool that was never designed to be a primary user interface. The path forward is evolution (improve the dashboard, add terminal view, add persistence), not revolution (build a whole new desktop app from scratch). The biggest risk is building something that duplicates what the Claude Code Desktop app already does better.
