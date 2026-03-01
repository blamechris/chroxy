# UX Architect Audit: Chroxy Desktop CLI Agent IDE

**Auditor Role**: UX Architect
**Date**: 2026-03-01
**Scope**: Interaction design, layout system, keyboard navigation, state transitions, onboarding, visual hierarchy
**Rating**: 2.5 / 5

---

## Executive Summary

The vision document (`desktop-vision.md`) establishes a strong *product* direction -- a CLI Agent IDE with sidebar, tabs, and terminal views -- but it reads as a product spec, not a UX spec. The *what* is clear; the *how* is almost entirely unspecified. There are no interaction details for the sidebar, no tab management rules, no keyboard shortcut map, no state transition definitions, no responsive layout breakpoints, no onboarding wireframes, and no visual design system beyond what the mobile app's `colors.ts` provides.

The existing dashboard (`dashboard-app.js`) is a 2000+ line vanilla JS IIFE that was never designed for IDE-class interaction patterns. It has a flat session tab bar, a single terminal/chat pane, and modal-based session creation. The mobile app (`SessionScreen.tsx`, `ChatView.tsx`, `SessionPicker.tsx`) is significantly more mature -- it has a well-structured component architecture with Zustand state management, notification banners, multi-select, search, activity grouping, and permission handling. The desktop IDE should adopt its architectural patterns wholesale while introducing desktop-specific UX layers.

**Key finding**: The plan jumps from "vanilla JS dashboard" to "React IDE" without specifying the interaction contracts that every component needs. This audit fills that gap.

---

## 1. Sidebar Design

### 1.1 Current State

No sidebar exists. The dashboard has a flat horizontal tab bar for sessions (`#session-tabs`). The mobile app has `SessionPicker` -- a horizontal scrollable pill strip. Neither is suitable for the tree-structured repo-session hierarchy described in the vision.

### 1.2 Specification

#### Structure

```
Sidebar (240px default, resizable 180-400px)
+--------------------------------------------------+
| [Search field]                    [+] New Session  |
+--------------------------------------------------+
| REPOSITORIES                        [Filter icon] |
|                                                    |
| > chroxy                             * 2 active   |
|   | * Implement sidebar component      * running  |
|   | * Fix tunnel recovery              * idle     |
|   | o "Add E2E encryption tests"      (resumable) |
|   | o "Refactor provider registry"    (resumable)  |
|                                                    |
| > exodus-loop                        * 1 active   |
|   | * Combat system redesign           * running   |
|   | o "Fix inventory bug"             (resumable)  |
|                                                    |
| > game-engine                    (no sessions)     |
|                                                    |
+--------------------------------------------------+
| PINNED REPOS                                       |
|   chroxy                                           |
+--------------------------------------------------+
|                                                    |
| INFRASTRUCTURE STATUS                              |
| * Server     Running  (port 8765)                  |
| * Tunnel     Connected (*.trycloudflare.com)       |
| * Clients    2 connected                           |
+--------------------------------------------------+
```

#### Interaction Rules

| Action | Trigger | Behavior |
|--------|---------|----------|
| Expand/collapse repo | Click repo header or chevron | Toggle children visibility. Persist state in localStorage. |
| Open active session | Click session name | Opens tab in main pane (or focuses existing tab). |
| Resume past session | Click resumable session (circle icon) | Sends `resume_conversation`, opens new tab. Changes icon from circle to filled star. |
| Create session for repo | Click `+` icon on repo header hover | Opens session creation panel (inline, not modal) with repo pre-selected. |
| Rename session | Double-click session name | Inline text edit, Enter to confirm, Escape to cancel. |
| Delete session | Right-click > Delete, or Cmd+Backspace when selected | Confirmation required only if session is actively running. |
| Reorder repos | Drag-and-drop repo headers | Saves custom order. Pinned repos always appear in their own section above. |
| Pin repo | Right-click > Pin, or drag to PINNED section | Pinned repos remain at top, alphabetically sorted. |
| Filter sidebar | Type in search field at top | Filters repos and sessions by name. Shows matching sessions even if repo is collapsed. |

#### Context Menu (Right-Click)

**On repo header:**
- New Session
- Open in Terminal (opens system terminal at repo path)
- Pin / Unpin
- Remove Repository
- Copy Path

**On active session:**
- Rename
- Duplicate (creates new session in same repo, same model)
- Switch Model
- View Session Info (cost, duration, message count)
- Delete Session

**On resumable session:**
- Resume
- Delete from History
- Copy Conversation ID

#### Status Indicators

| Icon | Meaning | Color |
|------|---------|-------|
| Filled star (*) | Active session | -- |
| Pulsing dot | Session is busy (Claude is generating) | `accentOrange` (#f59e0b) |
| Steady dot | Session is idle (waiting for input) | `accentGreen` (#22c55e) |
| Open circle (o) | Resumable past session | `textMuted` (#888) |
| Red dot | Crashed session | `accentRed` (#ff4a4a) |
| Orange badge | Permission request pending | `accentOrange` (#f59e0b) |

#### Sidebar Resize

- Drag the right edge to resize. Cursor changes to `col-resize`.
- Double-click the edge to reset to default width (240px).
- Minimum width: 180px. Below that, sidebar collapses to icon-only mode (32px wide).
- Icon-only mode shows: repo icons with badge counts, session dots.
- Toggle collapse via Cmd+B (matches VS Code).

### 1.3 Missing Decisions the Plan Needs

1. **Session sort order within a repo**: By creation time? By last activity? Alphabetical? Recommendation: active sessions sorted by last activity (most recent first), resumable sessions sorted by last interaction date.
2. **Maximum resumable sessions shown**: `~/.claude/projects/` can accumulate hundreds. Show latest 10 per repo with a "Show N more..." expander.
3. **Repo discovery vs. manual add**: Vision says repos are auto-discovered from `~/.claude/projects/`. What happens when a user adds a repo that has no past conversations? It appears empty. That is fine, but the empty state needs a "Start your first session" call-to-action.
4. **Multi-machine repos**: Vision Phase 4 mentions multi-machine. The sidebar needs to eventually show a machine indicator per repo. Design for this now even if not implemented: add a subtle hostname annotation field in the data model.

---

## 2. Tab Management

### 2.1 Current State

The dashboard has a flat `#session-tabs` container with simple tab buttons. Switching tabs calls `switchSession()` which triggers a full history replay. The mobile app's `SessionPicker` is a horizontal pill strip with notification dots and busy indicators -- a good foundation but designed for 3-5 sessions on a phone screen, not 10+ tabs on a desktop.

### 2.2 Specification

#### Layout

```
+------+------------+-------------+-------------+------+
| [Pin]| chroxy/    | exodus/     | game-engine | [+]  |
|      | sidebar    | combat  [x] | setup  [x]  |      |
+------+------------+-------------+-------------+------+
```

#### Rules

| Rule | Value | Rationale |
|------|-------|-----------|
| Maximum open tabs | 10 (soft limit, warn at 8) | Memory: each tab holds an xterm.js instance. Match server's 5-session limit with headroom for cached tabs. |
| Tab overflow | Horizontal scroll with left/right chevrons | Matches VS Code, Chrome. Never wrap to second line. |
| Close button | Shown on hover (X icon, right side of tab) | Hidden by default to reduce clutter. Always visible on active tab. |
| Close confirmation | Only if session is actively running (busy state) | "Close tab for running session 'sidebar'? The session will continue in the background." |
| Tab pinning | Cmd+click or right-click > Pin Tab | Pinned tabs move to the left, show only icon (no close button), cannot be closed without unpinning. |
| Tab reordering | Drag-and-drop | Pinned tabs can only reorder among pinned tabs. Unpinned tabs can only reorder among unpinned tabs. |
| New tab button | `+` at right end of tab strip | Opens the same session creation flow as sidebar's `+`. |
| Tab labels | Repo/session format: `chroxy/sidebar` | Truncate session name at 20 chars. Show full name in tooltip. |
| Tab indicators | Dot left of label | Same color scheme as sidebar status indicators. |
| Middle-click | Close tab (browser convention) | No confirmation even for active sessions (muscle memory expectation). |
| Cmd+W | Close active tab | With confirmation if session is busy. |
| Cmd+T | New session (in currently selected repo) | If no repo selected, opens repo picker first. |
| Cmd+1 through Cmd+9 | Switch to tab N | Cmd+9 always goes to last tab (Chrome behavior). |
| Cmd+Shift+[ and ] | Previous/next tab | Standard macOS tab cycling. |

#### Tab States

```
  LOADING -----> CONNECTED -----> IDLE
     |               |              |
     |               v              v
     |           BUSY (pulsing)  PERMISSION_PENDING
     |               |              |
     v               v              v
  ERROR         DISCONNECTED     CRASHED
```

- **LOADING**: Tab just opened, history replaying. Show skeleton shimmer in terminal area.
- **CONNECTED/IDLE**: Normal state. Terminal shows cursor.
- **BUSY**: Agent is generating. Tab label pulses. Input bar shows interrupt button.
- **PERMISSION_PENDING**: Needs user action. Tab shows orange badge. If window not focused, fire native notification.
- **ERROR/CRASHED**: Tab shows red indicator. Terminal shows error message. Offer "Restart Session" button.
- **DISCONNECTED**: Server connection lost. Show reconnection banner (same as current dashboard behavior).

#### Tab Close vs. Session Destroy

Closing a tab does NOT destroy the session. The session continues running on the server. The tab is simply removed from the UI. The session remains in the sidebar as an active session and can be re-opened by clicking it.

Destroying a session (right-click > Delete in sidebar, or explicit action) kills the Claude process and removes it from both tabs and sidebar.

This distinction is critical and must be communicated clearly to users.

---

## 3. Welcome Screen

### 3.1 Current State

The dashboard has no welcome screen -- it opens directly to a chat/terminal view. The Tauri fallback (`index.html`) shows a startup spinner with health polling stages, then a QR code for mobile pairing. This is a "loading" screen, not a "welcome" screen.

### 3.2 Specification

The Welcome Screen appears when no tabs are open (all tabs closed, or first launch).

```
+------------------------------------------------------------------+
|                                                                    |
|                          CHROXY                                    |
|                    CLI Agent IDE                                   |
|                                                                    |
|    +---------------------------+  +-----------------------------+  |
|    |  [icon]                   |  |  [icon]                     |  |
|    |  + New Session            |  |  + Add Repository           |  |
|    |                           |  |                             |  |
|    |  Start a Claude Code      |  |  Add a project directory    |  |
|    |  session in any of your   |  |  to your workspace.         |  |
|    |  repositories.            |  |                             |  |
|    +---------------------------+  +-----------------------------+  |
|                                                                    |
|    RECENT SESSIONS                                                 |
|    +----------------------------------------------------------+   |
|    | chroxy / Implement sidebar     2 min ago      [Resume]    |   |
|    | exodus / Combat redesign       1 hour ago     [Resume]    |   |
|    | chroxy / Fix tunnel recovery   3 hours ago    [Resume]    |   |
|    +----------------------------------------------------------+   |
|                                                                    |
|    QUICK ACTIONS                                                   |
|    [Pair Mobile Device]  [Settings]  [Keyboard Shortcuts]          |
|                                                                    |
|    Cmd+N  New Session    Cmd+Shift+P  Command Palette              |
|                                                                    |
+------------------------------------------------------------------+
```

#### First Launch Variant

On absolute first launch (no repos, no sessions, no history):

```
+------------------------------------------------------------------+
|                                                                    |
|                          CHROXY                                    |
|                    CLI Agent IDE                                   |
|                                                                    |
|              Welcome! Let's get you set up.                        |
|                                                                    |
|    Step 1: Add a repository                                        |
|    +----------------------------------------------------------+   |
|    | [icon folder]                                             |   |
|    |                                                           |   |
|    |  Drag a project folder here, or click to browse.          |   |
|    |                                                           |   |
|    |  Chroxy will manage Claude Code sessions for this repo.   |   |
|    |                                                           |   |
|    |  [ Browse... ]                                            |   |
|    +----------------------------------------------------------+   |
|                                                                    |
|    Or, if you've used Claude Code before, we'll auto-discover      |
|    your repos from ~/.claude/projects/                             |
|                                                                    |
|    [ Scan for Existing Repos ]                                     |
|                                                                    |
|    Step 2: Pair your phone (optional)                              |
|    Scan this QR code with the Chroxy mobile app.                   |
|    [ Show QR Code ]                                                |
|                                                                    |
+------------------------------------------------------------------+
```

After adding the first repo, this transitions smoothly (animated) to the normal welcome screen with the repo now visible in the sidebar and a "Start your first session" prompt.

---

## 4. Keyboard Shortcut Map

### 4.1 Current State

The dashboard has zero keyboard shortcuts. The mobile app has none (expected for touch). The vision document mentions "Cmd+1-9 for tabs, Cmd+N new session, Cmd+W close tab" in Phase 3 but provides no comprehensive map.

### 4.2 Complete Shortcut Map

#### Global Shortcuts (Always Active)

| Shortcut | Action | Category |
|----------|--------|----------|
| `Cmd+Shift+P` | Open command palette | Navigation |
| `Cmd+N` | New session | Sessions |
| `Cmd+W` | Close current tab | Tabs |
| `Cmd+Shift+W` | Close all tabs | Tabs |
| `Cmd+1` - `Cmd+9` | Switch to tab N (9 = last) | Tabs |
| `Cmd+Shift+[` | Previous tab | Tabs |
| `Cmd+Shift+]` | Next tab | Tabs |
| `Cmd+B` | Toggle sidebar | Layout |
| `Cmd+J` | Toggle status bar | Layout |
| `Cmd+\` | Toggle split pane (Phase 3) | Layout |
| `Cmd+,` | Open settings | Navigation |
| `Cmd+K Cmd+S` | Show keyboard shortcuts | Help |
| `Cmd+Shift+N` | New window (future) | Window |
| `Cmd+F` | Search within active chat | Search |
| `Escape` | Close palette / cancel search / deselect | General |

#### Session Shortcuts (Active Tab)

| Shortcut | Action | Category |
|----------|--------|----------|
| `Cmd+Enter` | Send message (when input focused) | Input |
| `Cmd+Shift+Enter` | Send with newline (multiline input) | Input |
| `Ctrl+C` | Interrupt running agent | Session |
| `Cmd+Shift+R` | Restart session | Session |
| `Cmd+Shift+D` | Toggle chat/terminal view | View |
| `Cmd+Shift+F` | Toggle file browser panel (Phase 4) | View |
| `Cmd+Shift+G` | Show diff viewer (Phase 4) | View |
| `Cmd+Y` | Accept permission request (when pending) | Permissions |
| `Cmd+Shift+Y` | Accept all permissions for this tool | Permissions |
| `Escape` | Reject permission request (when pending) | Permissions |

#### Sidebar Shortcuts (Sidebar Focused)

| Shortcut | Action | Category |
|----------|--------|----------|
| `Up/Down` | Navigate items | Navigation |
| `Enter` | Open selected session / expand repo | Action |
| `Space` | Toggle expand/collapse repo | Action |
| `Delete` / `Backspace` | Delete selected session (with confirmation) | Action |
| `Cmd+Shift+E` | Focus sidebar | Focus |

#### Command Palette

The command palette (`Cmd+Shift+P`) is the single most important UX element for power users. It provides fuzzy-matched access to every action:

```
+---------------------------------------------------+
| > _                                                |
+---------------------------------------------------+
| Session: New Session                    Cmd+N      |
| Session: Switch Model                              |
| Session: Rename Current Session                    |
| Session: Restart Current Session       Cmd+Shift+R |
| View: Toggle Sidebar                  Cmd+B        |
| View: Toggle Chat/Terminal            Cmd+Shift+D  |
| Repo: Add Repository                              |
| Repo: Remove Repository                           |
| Settings: Open Settings               Cmd+,        |
| Help: Keyboard Shortcuts              Cmd+K Cmd+S  |
+---------------------------------------------------+
```

Filtering is fuzzy: typing "mod" matches "Switch Model", "Permission Mode", etc. Each item shows its keyboard shortcut on the right. Items are grouped by category. Most-recently-used items appear first.

---

## 5. State Transitions

### 5.1 Application Lifecycle

```
COLD_START
    |
    v
STARTING_SERVER ----[timeout 30s]----> SERVER_ERROR
    |                                      |
    [health OK]                      [user retries]
    |                                      |
    v                                      v
ESTABLISHING_TUNNEL --[timeout 45s]--> TUNNEL_ERROR
    |                                      |
    [tunnel ready]                  [continue without]
    |                                      |
    v                                      v
READY ----------------------------------------+
    |                                          |
    [server crash]                             |
    |                                          |
    v                                          |
SERVER_RESTARTING ----[auto-restart]----> READY
    |
    [restart fails]
    |
    v
SERVER_ERROR
```

#### What the User Sees at Each State

| State | Sidebar | Main Pane | Status Bar |
|-------|---------|-----------|------------|
| COLD_START | Hidden | Startup spinner (current fallback page) | Hidden |
| STARTING_SERVER | Hidden | Stage indicators (1: Starting, 2: Health check, 3: Ready) | Hidden |
| SERVER_ERROR | Hidden | Error message with retry button and manual start instructions | Hidden |
| ESTABLISHING_TUNNEL | Skeleton (repos loading) | "Establishing tunnel..." with progress | "Tunnel: connecting..." |
| TUNNEL_ERROR | Full (loaded) | Welcome screen (functional, tunnel warning banner) | "Tunnel: failed -- LAN only" |
| READY | Full | Welcome screen or active tab | Full status display |
| SERVER_RESTARTING | Grayed out (disabled) | Overlay: "Server restarting... ETA: 5s" with countdown | "Server: restarting..." |

### 5.2 Session Lifecycle

```
SESSION_CREATING
    |
    [session_created]
    |
    v
SESSION_LOADING (history replay)
    |
    [history_replay_end]
    |
    v
SESSION_IDLE <----------+
    |                    |
    [user sends input]   |
    |                    |
    v                    |
SESSION_BUSY             |
    |                    |
    +---[stream_end]-----+
    |
    +---[permission_request]---> PERMISSION_PENDING
    |                                  |
    |                       [user responds]
    |                                  |
    +----------------------------------+
    |
    +---[error]--> SESSION_ERROR
    |                  |
    |           [restart / close]
    |                  |
    +------------------+
    |
    +---[crash]--> SESSION_CRASHED
                       |
                [user closes tab / restarts]
```

#### What the User Sees During Session Creation

1. User clicks `+ New Session` on a repo.
2. **Inline creation panel** slides down from the sidebar (not a modal -- modals block interaction with other sessions):
   ```
   +------------------------------------+
   | New Session: chroxy                 |
   |                                     |
   | Name: [auto-generated or custom]    |
   | Model: [Sonnet 4.6 v]              |
   | Mode:  [Auto-approve v]            |
   |                                     |
   |        [Cancel]  [Create Session]   |
   +------------------------------------+
   ```
3. On "Create Session": panel closes, new tab opens with loading skeleton, sidebar shows new active session with pulsing dot.
4. Loading skeleton displays: gray rectangles mimicking chat message layout, subtle shimmer animation.
5. On `session_created` + `history_replay_end`: skeleton fades out, terminal/chat becomes interactive, cursor appears in input bar.

#### What the User Sees During Resume

1. User clicks a resumable session (circle icon) in sidebar.
2. Resumable session icon changes to a spinner.
3. New tab opens with loading skeleton.
4. On `session_created`: spinner becomes filled star, tab transitions from skeleton to live view.
5. Previous conversation messages appear via history replay.
6. Input bar shows "Continue the conversation..." placeholder.

### 5.3 Reconnection State Machine

The mobile app's `ConnectionPhase` state machine is well-designed. The desktop should reuse the same states with desktop-appropriate UI:

```
CONNECTED
    |
    [ws close / error]
    |
    v
RECONNECTING (attempt 1..8)
    |
    [success]-----> CONNECTED (with "Reconnected" toast, 3s)
    |
    [all retries exhausted]
    |
    v
DISCONNECTED
    |
    [user clicks "Reconnect"]
    |
    v
RECONNECTING
```

Desktop-specific reconnection UI:
- **Banner**: Yellow warning bar below tab strip: "Connection lost. Reconnecting... (attempt 3/8)"
- **Sessions**: All session tabs show "Disconnected" overlay with last-known content still visible (not cleared).
- **Sidebar**: Status section shows red dot for server.
- **Input bar**: Disabled with tooltip "Reconnecting..."

---

## 6. Responsive Layout

### 6.1 Current State

The dashboard has no responsive behavior. The Tauri window is set to 900x700 initially (`window.rs` line 51). The mobile app has a `useLayout` hook that handles split views, but it is designed for phone/tablet breakpoints, not desktop window sizes.

### 6.2 Specification

#### Layout Zones

```
+---+----------------------------------------------+
| S |                    TABS                       |
| I |----------------------------------------------+
| D |                                              |
| E |               MAIN PANE                      |
| B |          (terminal / chat / split)           |
| A |                                              |
| R |----------------------------------------------+
|   |              INPUT BAR                       |
+---+----------------------------------------------+
|               STATUS BAR                         |
+--------------------------------------------------+
```

#### Breakpoints

| Window Width | Sidebar | Main Pane | Behavior |
|-------------|---------|-----------|----------|
| >= 1200px | Full (240px) | Chat + Terminal split available | Default layout |
| 900-1199px | Full (200px) | Single pane only | Split pane disabled |
| 600-899px | Collapsed (icon-only, 44px) | Full width | Sidebar expands as overlay on hover/Cmd+B |
| < 600px | Hidden | Full width | Sidebar accessible via hamburger menu |

#### Minimum Window Size

- **Minimum**: 480 x 400 px (enforced by Tauri window config)
- **Recommended**: 900 x 700 px (current default)
- Below minimum, clipping is acceptable -- do not attempt to be fully responsive below 480px.

#### Split Pane (Phase 3)

- **Horizontal split**: Chat on left, terminal on right (or vice versa). Default ratio: 50/50.
- **Vertical split**: Chat on top, terminal on bottom. Default ratio: 60/40.
- Drag the divider to resize. Double-click divider to reset to default ratio.
- Split direction toggles via Cmd+\ (cycles: no split -> horizontal -> vertical -> no split).
- Each pane can independently show chat or terminal view for the same session.
- Split state persists per session tab.

---

## 7. Visual Design System

### 7.1 Current State

The mobile app has a well-defined dark theme via `colors.ts` with 60+ named color constants. The dashboard uses inline hex colors that loosely match. There is no light theme. The Tauri fallback page uses the same color palette.

### 7.2 Recommendations

#### Theme Strategy

**Ship dark-only for Phase 1-3.** The target audience (developers using Claude Code) overwhelmingly uses dark themes. Adding a light theme doubles the design surface area. Defer to Phase 4 or later.

The existing `colors.ts` palette is solid. Port it directly to CSS custom properties for the React dashboard:

```css
:root {
  --bg-primary: #0f0f1a;
  --bg-secondary: #1a1a2e;
  --bg-tertiary: #16162a;
  --bg-card: #2a2a4e;
  --bg-input: #0f0f1a;
  --bg-terminal: #000;

  --text-primary: #fff;
  --text-secondary: #ccc;
  --text-muted: #888;
  --text-dim: #666;

  --accent-blue: #4a9eff;
  --accent-green: #22c55e;
  --accent-purple: #a78bfa;
  --accent-orange: #f59e0b;
  --accent-red: #ff4a4a;

  --border-primary: #2a2a4e;
  --border-secondary: #3a3a5e;
  --border-subtle: #4a4a6e;

  --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
```

#### Typography

| Element | Font | Size | Weight | Color |
|---------|------|------|--------|-------|
| Sidebar repo header | UI | 12px | 600 | `text-secondary` |
| Sidebar session name | UI | 13px | 400 | `text-primary` (active), `text-muted` (inactive) |
| Sidebar section label | UI | 10px | 700, uppercase, letter-spacing 0.5px | `text-dim` |
| Tab label | UI | 12px | 500 | `text-primary` (active), `text-muted` (inactive) |
| Chat message (Claude) | UI | 14px | 400 | `text-chat-message` (#e0e0e0) |
| Chat message (User) | UI | 14px | 400 | `text-primary` |
| Code blocks | Mono | 13px | 400 | `text-code-block` (#a0d0ff) |
| Terminal | Mono | 13px | 400 | Terminal's own ANSI colors |
| Status bar | UI | 11px | 400 | `text-muted` |
| Input bar placeholder | UI | 14px | 400 | `text-dim` |
| Command palette input | UI | 16px | 400 | `text-primary` |

#### Iconography

Use a consistent icon system. Recommendations:

1. **Lucide Icons** (preferred): MIT-licensed, designed for developer tools, available as React components. VS Code and many IDE tools use similar line-icon styles.
2. Icon size: 16px for sidebar items, 14px for tab indicators, 20px for toolbar actions.
3. Icon color: inherits from text color of parent element. Never use multi-color icons.

#### Spacing System

Use a 4px base grid:
- **4px**: Minimal gap (between icon and label)
- **8px**: Tight spacing (between list items, padding inside pills)
- **12px**: Standard spacing (section gaps in sidebar)
- **16px**: Comfortable spacing (padding inside panels)
- **24px**: Large spacing (between major sections)
- **32px**: Extra large (welcome screen card gaps)

#### Elevation / Layering

| Layer | z-index | Use |
|-------|---------|-----|
| Base content | 0 | Sidebar, main pane |
| Tab strip | 10 | Tab bar (sticky top) |
| Status bar | 10 | Status bar (sticky bottom) |
| Floating panels | 20 | Collapsed sidebar overlay, inline creation panel |
| Dropdown menus | 30 | Context menus, select dropdowns |
| Command palette | 40 | Cmd+Shift+P overlay |
| Modals | 50 | Confirmation dialogs |
| Notifications | 60 | Toast notifications |

---

## 8. Notification Design

### 8.1 Categories

| Category | Urgency | Desktop Behavior | In-App Behavior |
|----------|---------|-----------------|-----------------|
| Permission request | High | Native OS notification (if window not focused) + sound | Orange badge on tab + banner in main pane |
| Agent completed | Medium | Native OS notification (if window not focused) | Green flash on tab, then steady green dot |
| Agent error/crash | High | Native OS notification always | Red badge on tab + error banner |
| Session created | Low | None | Toast: "Session created" (3s) |
| Tunnel connected | Low | None | Status bar update + toast (3s) |
| Tunnel lost | Medium | Native OS notification | Yellow warning banner |
| Server restarting | Medium | Tray icon animation | Overlay on main pane with countdown |
| Mobile client connected | Low | None | Toast: "Mobile device connected" (3s) |

### 8.2 Toast System

```
+--------------------------------------------------+
|                                                    |
|            [Main pane content]                     |
|                                                    |
|                                                    |
|                 +-----------------------------+    |
|                 | [icon] Session created       |    |
|                 |         3s auto-dismiss       |    |
|                 +-----------------------------+    |
+--------------------------------------------------+
```

- Toasts stack from bottom-right, max 3 visible at once.
- Auto-dismiss after 3-5s depending on urgency.
- Hovering pauses auto-dismiss.
- Click to dismiss immediately.
- Error toasts persist until dismissed (no auto-dismiss).

### 8.3 Permission Request UX

This is the highest-priority notification because it blocks agent progress.

**When window is focused:**
1. Tab badge turns orange with pulse animation.
2. Permission banner slides down from top of main pane:
   ```
   +----------------------------------------------------------+
   | [!] Claude wants to run: `rm -rf node_modules`            |
   |                                                            |
   |     Tool: Bash                                             |
   |     Description: Remove node_modules directory             |
   |                                                            |
   |     [Deny]  [Allow Once]  [Allow All (Bash)]    15s        |
   +----------------------------------------------------------+
   ```
3. Countdown timer (if configured). Permission auto-denies on expiry.
4. Keyboard: `Cmd+Y` to allow, `Escape` to deny.

**When window is NOT focused:**
1. Native OS notification via Tauri: "Chroxy: Permission requested -- Claude wants to run `rm -rf node_modules`"
2. Clicking the notification brings Chroxy to foreground with the permission tab focused.
3. If user does not respond within the timeout, permission is auto-denied and a toast appears: "Permission auto-denied (timeout)."

---

## 9. Onboarding Flow

### 9.1 First Launch Sequence

```
+------------------+     +------------------+     +------------------+
|                  |     |                  |     |                  |
|  1. WELCOME      |---->|  2. ADD REPO     |---->|  3. FIRST        |
|                  |     |                  |     |     SESSION      |
|  - Logo          |     |  - Drag folder   |     |  - Session       |
|  - Tagline       |     |  - Browse button |     |    created       |
|  - Get Started   |     |  - Auto-discover |     |  - Input focused |
|                  |     |    button        |     |  - Hint tooltip  |
+------------------+     +------------------+     +------------------+
```

#### Step 1: Welcome

Full-screen centered. Logo, "CLI Agent IDE" tagline, "Get Started" button. If repos are auto-discovered from `~/.claude/projects/`, show: "We found N repositories from your Claude Code history. [Import All] [Choose...]"

#### Step 2: Add Repository

If auto-discovered repos exist and user chose "Import All": skip this step. Otherwise, show the file picker. After selecting a directory:
- Validate it is a git repository (`.git/` exists). If not: "This doesn't appear to be a git repository. Add anyway? [Yes] [Choose Another]"
- Add to sidebar. Animate sidebar sliding in from left.

#### Step 3: First Session

- Auto-create a session in the first added repo (or prompt user to choose if multiple).
- Session creation panel appears pre-filled. User clicks "Create Session."
- Tab opens, terminal initializes.
- **Hint tooltip** appears pointing at the input bar: "Type a message to start working with Claude." Dismisses on first keystroke or after 10s.

### 9.2 Subsequent Launches

No onboarding UI. Go directly to:
- If previous session state is saved: restore open tabs (same tabs as when app was closed, connected to their sessions if still running).
- If no state to restore: show welcome screen.

### 9.3 Feature Discovery

Use subtle, non-intrusive hints for power features:
- **First time Cmd+Shift+P is available**: Small badge on status bar: "Tip: Cmd+Shift+P opens the command palette"
- **First permission request**: Tooltip on the permission banner: "Tip: Cmd+Y to approve, Escape to deny"
- **Third session created**: Toast: "Tip: Cmd+1-9 to switch between tabs quickly"
- These hints appear once and are tracked in localStorage. Never repeat.

---

## 10. Status Bar

### 10.1 Specification

```
+-------------------------------------------------------------------+
| Model: Sonnet 4.6  |  Cost: $0.42  |  Context: 45%  |  Tunnel: *.trycloudflare.com  |  2 clients  |
+-------------------------------------------------------------------+
```

#### Sections (Left to Right)

| Section | Content | Click Behavior |
|---------|---------|----------------|
| Model | Active session's model name | Opens model switcher dropdown |
| Cost | Session cost (cumulative) | Shows cost breakdown tooltip |
| Context | Context window usage (percentage + bar) | Shows token count tooltip |
| Tunnel | Tunnel URL or "LAN only" | Copies URL to clipboard |
| Clients | Connected client count | Shows client list tooltip (desktop, mobile, etc.) |

#### Behavior

- Status bar updates reflect the **active tab's session**, not a global state.
- When no tab is open, status bar shows server-level info only (tunnel, clients).
- Toggle visibility with `Cmd+J`.
- Height: 24px. Background: `bg-tertiary`. Text: `text-muted`, 11px.

---

## 11. Missing UX Decisions

The following items are NOT addressed in the vision document and need specification before implementation:

### Critical (Must Define Before Phase 2)

1. **Session-to-tab relationship**: Is it 1:1? Can the same session be open in two tabs? (Recommendation: 1:1. Opening an already-tabbed session focuses that tab.)
2. **Tab persistence across app restarts**: Which tabs reopen? All of them? Only pinned tabs? (Recommendation: Restore all tabs that had active sessions. Resumable sessions are not restored as tabs.)
3. **Sidebar scroll position persistence**: Preserved across app restarts? (Recommendation: Yes, via localStorage.)
4. **Input bar behavior**: Does it support multiline? How? Shift+Enter for newline or Cmd+Enter to send? (Recommendation: Single-line by default. Shift+Enter for newline. Cmd+Enter to send. Auto-expand up to 5 lines.)
5. **Focus management**: Where does focus go after closing a tab? After creating a session? After switching tabs? (Recommendation: Focus moves to input bar of the newly active tab in all cases.)
6. **Error recovery for failed session creation**: If `create_session` fails, what does the user see? (Recommendation: Tab shows error state with retry button and error message. Tab can be closed normally.)

### Important (Must Define Before Phase 3)

7. **Drag-and-drop file attachment**: Can users drag files into the input bar? (Recommendation: Yes, with drop zone visual feedback. Match mobile app's attachment system.)
8. **Window state persistence**: Remember window position, size, sidebar width, split pane ratio across restarts? (Recommendation: Yes, all of it, via Tauri's window state plugin or localStorage.)
9. **Multiple windows**: Will Chroxy ever support multiple windows? (Recommendation: Not for Phase 1-3. Single-instance enforced via `tauri-plugin-single-instance`. Phase 4 could support detaching tabs into windows.)
10. **Accessibility**: Keyboard navigation for all interactive elements? ARIA labels? Screen reader support? (Recommendation: Yes. Every interactive element needs a keyboard path. Follow WAI-ARIA authoring practices for tree views (sidebar), tab lists, and dialogs.)
11. **Undo for destructive actions**: Session deletion, repo removal -- is there an undo? (Recommendation: 5-second undo toast for session deletion. Repo removal is immediate but does not delete data.)

### Nice to Have (Can Define During Implementation)

12. **Animation standards**: What easing curve? What durations? (Recommendation: `ease-out` for entrances, `ease-in` for exits. 150ms for small elements, 250ms for panels, 350ms for full-screen transitions.)
13. **Empty states**: What does an empty sidebar look like? An empty terminal? (Recommendation: Centered gray text with call-to-action. "No sessions yet. Click + to create one.")
14. **Loading states**: Skeleton shimmer vs. spinner vs. progress bar? (Recommendation: Skeleton shimmer for content loading, spinner for actions, progress bar only for downloads/uploads.)
15. **Copy behavior**: What happens when user copies text from chat vs. terminal? (Recommendation: Chat copies as plain text with markdown formatting stripped. Terminal copies as plain text with ANSI stripped.)
16. **Zoom level**: Cmd+/- to zoom the UI? (Recommendation: Yes, via Tauri webview zoom. Range: 75%-150%. Persist preference.)

---

## 12. Summary of Ratings by Category

| Category | Completeness in Vision Doc | Notes |
|----------|---------------------------|-------|
| Sidebar design | 2/5 | Tree structure described, no interaction rules |
| Tab management | 1/5 | Mentioned, zero rules defined |
| Keyboard shortcuts | 1/5 | Three shortcuts listed in a bullet point |
| State transitions | 2/5 | Data flows described, no user-facing states |
| Responsive layout | 0/5 | Not mentioned at all |
| Onboarding | 2/5 | User journey described narratively, no wireframes |
| Visual design | 2/5 | Color system exists in mobile app, not ported |
| Notifications | 1/5 | "Native notifications for permission requests" listed as Phase 3 item |
| Welcome screen | 2/5 | Quick-start actions mentioned, no layout |
| Status bar | 3/5 | Content defined in ASCII diagram |
| Command palette | 0/5 | Not mentioned |
| Accessibility | 0/5 | Not mentioned |

**Overall: 2.5 / 5** -- The product vision is clear but the interaction design is skeletal. This audit provides the specifications needed to build with confidence.

---

## 13. Recommendations for Implementation Order

Within the existing Phase 2 (Sidebar + Session Tabs), prioritize in this order:

1. **CSS custom property system** -- Port `colors.ts` to CSS variables. Every component depends on this.
2. **Layout shell** -- Sidebar + main pane + status bar + tab strip as empty containers with resize handles.
3. **Keyboard shortcut system** -- Register Cmd+B, Cmd+W, Cmd+1-9, Cmd+Shift+P early. These are zero-UI features that make everything feel professional.
4. **Sidebar tree** -- Repos and sessions with expand/collapse, status indicators, context menus.
5. **Tab system** -- Open/close/switch with proper focus management and state preservation.
6. **Welcome screen** -- What users see when no tabs are open.
7. **Command palette** -- Fuzzy search over all actions. This becomes the power-user's primary navigation.
8. **Session creation (inline)** -- Replace modal with sidebar-inline panel.
9. **Notification system** -- Toasts + permission banners + native OS notifications.
10. **Onboarding flow** -- First-launch experience. Save for last because it requires all other pieces to exist.

---

*This audit provides the interaction design foundation that the vision document needs. Every specification above should be validated against the actual implementation as Phase 2 begins.*
