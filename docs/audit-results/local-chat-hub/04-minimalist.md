# Minimalist's Audit: Local Desktop Chat Hub for Chroxy

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code. Identifies what to cut and proposes minimal alternatives.
**Overall Rating**: 2.0 / 5
**Date**: 2026-02-24

---

## Section Ratings

| Section | Rating | Justification |
|---------|--------|---------------|
| Complexity vs Value | 2/5 | Building a desktop chat app duplicates both the mobile app AND Claude Code Desktop |
| Existing Assets Utilization | 2/5 | The Tauri shell and dashboard exist but the proposal doesn't acknowledge them |
| Scope Appropriateness | 1/5 | A React rewrite of the dashboard is a multi-week project that solves problems the user hasn't complained about yet |
| Simplest Path | 3/5 | Polishing the existing dashboard is the 80/20 play |
| Feature Necessity | 2/5 | Many proposed features (sidebar, split panes, file browser) overlap with Claude Code Desktop |

---

## Top 5 Findings

### 1. The Tauri App Adds Minimal Value Over `open http://localhost:8765/dashboard`

The entire Tauri app (`packages/desktop/`) is ~700 lines of Rust that does three things:
1. Starts the Node.js server
2. Shows a tray icon
3. Opens the dashboard in a WebView

All three can be replaced by:
1. `npx chroxy start` (already works, already has `--background` flag)
2. A shell alias or LaunchAgent
3. Opening the dashboard URL in any browser

The WebView doesn't add capabilities that a browser tab doesn't have. The tray icon is nice but not essential.

**Counter-argument:** The Tauri app provides a better first-run experience (auto-start, auto-config) and is more discoverable than a CLI command. This is valid for less technical users.

### 2. Kill the React Rewrite Idea -- Polish Dashboard Instead

The dashboard (`dashboard.js`) is 1756 lines of working code. It handles:
- Session management (create, switch, rename, destroy)
- Chat with streaming, markdown, code blocks
- Permission prompts with allow/deny
- Plan mode with approve/feedback
- Model switching, status bar, cost tracking
- Keyboard shortcuts (Ctrl+1-9, Ctrl+N, Escape)

A React rewrite would take 2-3 weeks and produce functionally identical output. Instead, spend 1 week adding:
1. `localStorage` persistence for messages (20 lines)
2. Syntax highlighting via `<link>` to highlight.js CDN (5 lines)
3. Vertical sidebar layout (CSS change, 50 lines)
4. xterm.js terminal view (100 lines + library)
5. Desktop notifications for permissions (30 lines via Notification API or Tauri plugin)

Total: ~200 lines of additions to the existing dashboard vs. ~5000+ lines for a React rewrite.

### 3. Don't Build What Claude Code Desktop Already Ships

The Claude Code Desktop app (Anthropic official) already has:
- Sidebar session management
- Chat view with markdown rendering
- Visual diff review
- File browser
- Terminal integration
- Permission modes
- Plan mode

Building a second version of these features is wasted effort. Chroxy's value is **remote access from mobile**, not **desktop chat UI**.

### 4. The Shared Package (`packages/shared/`) Is Premature

Extracting shared types into a separate package creates:
- Build complexity (3 packages instead of 2)
- Version coordination overhead
- Import path changes across the entire codebase

The mobile app's `store/types.ts` is 496 lines. The dashboard's implicit types are maybe 50 lines. The overlap is real but small. Copy the types when needed; extract when there are 3+ consumers.

### 5. Simplest Valuable Improvement: Session Persistence

The single most impactful improvement to the desktop experience is adding client-side message persistence to the dashboard. Currently, closing and reopening the dashboard loses all visual chat history. Adding `localStorage.setItem('session_' + id, JSON.stringify(messages))` on each new message and loading on session switch would be the highest-value, lowest-effort change.

---

## Recommendations

1. **Don't build a new desktop app.** Polish the existing dashboard + Tauri shell.
2. **Add localStorage persistence to dashboard.** Highest value, lowest effort. ~20 lines.
3. **Add xterm.js to dashboard.** Second highest value. ~100 lines + library import.
4. **Defer sidebar layout.** The horizontal tab bar works fine for 3-8 sessions. A sidebar is a nice-to-have, not essential.
5. **Focus development energy on mobile app.** That's the differentiator. The desktop story is "good enough" with a polished dashboard.

---

## Verdict

The "local desktop chat hub" proposal suffers from scope inflation. The actual pain point is "the dashboard loses state when I close it" and "I can't see terminal output in the dashboard." These are ~200 lines of fixes to the existing dashboard, not a multi-week React rewrite or a new desktop application architecture. The Tauri shell is fine as invisible infrastructure. The dashboard is fine as a monitoring/interaction tool. The mobile app is the product. Build where the differentiation is.
