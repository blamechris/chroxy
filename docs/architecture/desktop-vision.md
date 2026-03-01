# Chroxy Desktop: CLI Agent IDE

The vision, architecture, and implementation roadmap for Chroxy Desktop — a multi-repo session orchestrator for Claude Code.

---

## Product Vision

Chroxy Desktop is a **CLI Agent IDE**: a desktop application that replaces the manual workflow of launching terminals, navigating to repos, starting Claude Code sessions, and juggling tabs. It is the command center for managing AI agent sessions across all your projects.

**The analogy**: What Cursor is for code editing with AI, Chroxy is for CLI agent orchestration. A left sidebar shows your projects and sessions. The main pane shows terminal tabs. You click to switch between agents working across different repos. Your phone stays in sync.

### What It Replaces

| Today (manual workflow) | Chroxy Desktop |
|------------------------|----------------|
| Open iTerm2 | Open Chroxy |
| `cd ~/Projects/chroxy` | Repos already listed in sidebar |
| `tmux new -s chroxy` | Managed by server (no tmux needed) |
| `claude --dangerously-skip-permissions` | One-click session creation |
| Repeat for each repo | All repos visible, all sessions managed |
| Start chroxy server + tunnel separately | Built into the app lifecycle |
| Cmd+Tab between terminal windows | Click tabs in the main pane |
| Mental tracking of which agent is where | Sidebar shows status at a glance |

### User Journey

**First launch:**
1. Open Chroxy Desktop
2. Welcome screen with quick-start actions: **+ Add a Repository**, **+ Start New Session**
3. User adds `~/Projects/chroxy` — it appears in the sidebar
4. App also discovers past Claude Code conversations from `~/.claude/projects/` and groups them under their repos

**Daily use:**
1. Open Chroxy Desktop (server starts automatically)
2. Left sidebar shows:
   ```
   REPOSITORIES
   ▼ chroxy                          ● 2 active
     ✦ Implement sidebar component     ● running
     ✦ Fix tunnel recovery             ● idle
     ○ "Add E2E encryption tests"      (resumable)
     ○ "Refactor provider registry"    (resumable)
   ▼ exodus-loop                     ● 1 active
     ✦ Combat system redesign          ● running
     ○ "Fix inventory bug"             (resumable)
   ▶ game-engine                       (no active sessions)
   ```
3. Click "Implement sidebar component" → main pane opens a terminal tab showing the live Claude Code session
4. Send a message, see Claude working, approve permissions — all in the terminal tab
5. Click "Combat system redesign" → second tab opens, switch freely between them
6. Pick up phone, open Chroxy mobile → same sessions visible, send a message from your phone → appears in desktop tab

**Session creation:**
1. Click **+** next to a repo name, or **+ New Session** from welcome screen
2. Pick a repo (if not already selected), optionally name the session
3. Choose model and permission mode
4. Session starts — terminal tab opens with Claude Code ready for input

**Session resume:**
1. Resumable sessions (○) are past conversations from `~/.claude/projects/`
2. Click one → creates a new session with `--resume`, opens terminal tab
3. Conversation continues where it left off

---

## Architecture

### What Exists Today (and Serves the Vision)

The foundation is solid. Most of the server infrastructure needed for this vision already exists:

| Component | Status | Role in Vision |
|-----------|--------|----------------|
| **SessionManager** | Working | Multi-session lifecycle (create/switch/destroy/persist) — already supports 5 concurrent sessions |
| **ConversationScanner** | Working | Discovers past conversations by repo from `~/.claude/projects/` — powers the "resumable" list |
| **Provider Registry** | Working | SDK + CLI providers with capability introspection — session creation uses this |
| **WebSocket Protocol** | Working | 58+ message types, schema-validated — all session interaction flows through this |
| **E2E Encryption** | Working | XSalsa20-Poly1305 over Curve25519 ECDH — differentiator, carry forward |
| **Tunnel System** | Working | Cloudflare quick/named + adapter registry — enables mobile sync |
| **Tauri Tray App** | Working | Process management, health polling, settings, autostart — desktop shell exists |
| **xterm.js Terminal** | Working | Full terminal emulation in WebView — both dashboard and mobile app use it |
| **Dashboard** | Working | 2000-line vanilla JS app with chat, terminal, sessions, permissions — functional but not the IDE UI |
| **EventNormalizer** | Working | Declarative event mapping with delta buffering — message pipeline is clean |
| **Checkpoint System** | Working | Git-tagged snapshots with restore-to-new-session — powers "branch from here" |

### What Needs Building

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CHROXY DESKTOP (Tauri + React)                    │
│                                                                     │
│  ┌──────────────┐  ┌──────────────────────────────────────────────┐ │
│  │   SIDEBAR     │  │              MAIN PANE                       │ │
│  │              │  │                                              │ │
│  │  Repo Tree   │  │  ┌─Tab: chroxy/sidebar──┬─Tab: exodus/───┐  │ │
│  │  ├ chroxy    │  │  │                      │  combat        │  │ │
│  │  │ ├ ✦ active│  │  ├──────────────────────┴────────────────┤  │ │
│  │  │ └ ○ past  │  │  │                                       │  │ │
│  │  ├ exodus    │  │  │         Terminal View (xterm.js)       │  │ │
│  │  │ └ ✦ active│  │  │                                       │  │ │
│  │  └ + Add Repo│  │  │   Claude Code session output           │  │ │
│  │              │  │  │   Streaming responses                  │  │ │
│  │  ─────────── │  │  │   Tool use / file edits                │  │ │
│  │  Status:     │  │  │   Permission prompts                   │  │ │
│  │  ● Server OK │  │  │                                       │  │ │
│  │  ● Tunnel OK │  │  ├───────────────────────────────────────┤  │ │
│  │  2 clients   │  │  │  Input Bar: [Type a message...]  Send │  │ │
│  │              │  │  └───────────────────────────────────────┘  │ │
│  └──────────────┘  └──────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─Status Bar──────────────────────────────────────────────────────┐│
│  │ Model: sonnet 4.6 │ Cost: $0.42 │ Tunnel: *.trycloudflare.com ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
          │                              │
          │ Tauri process management     │ ws://localhost:{port}
          ▼                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    NODE.JS SERVER (existing)                         │
│                                                                     │
│  SessionManager ←→ SdkSession/CliSession ←→ Claude Code            │
│  ConversationScanner ←→ ~/.claude/projects/                         │
│  WsServer ←→ Tunnel ←→ Mobile App                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### New Components Needed

| Component | Purpose | Builds On |
|-----------|---------|-----------|
| **React UI Framework** | Vite + React build pipeline for the dashboard | Replaces vanilla JS IIFE |
| **Sidebar Component** | Repo tree with active/resumable sessions | ConversationScanner + SessionManager |
| **Tab System** | Multi-tab main pane, one terminal per session | Existing xterm.js + session switching |
| **Welcome Screen** | Quick-start when no session selected | New component |
| **Repo Manager** | Add/remove/pin repos, filesystem scanning | New (ConversationScanner discovers past repos) |
| **Session Creator** | Modal/panel for new session config | Existing create_session protocol + UI |
| **Status Panel** | Server/tunnel/client status in sidebar footer | Existing health endpoint + tunnel events |
| **Multi-Session Subscription** | View multiple sessions simultaneously | New WS message: `subscribe_sessions` |

### Communication Architecture

The desktop app communicates with the server the same way the mobile app does — over WebSocket. This is intentional:

1. **Same protocol, same server, same code path.** No special desktop-only APIs to maintain.
2. **Cross-device sync comes free.** Desktop and mobile see the same sessions through the same WebSocket.
3. **The dashboard is served by the Node server.** The Tauri WebView loads `http://localhost:{port}/dashboard`. The React app replaces the vanilla JS dashboard at this URL.
4. **Tauri IPC is for desktop-native features only.** Clipboard, native notifications, file dialogs, window management — things that require OS access. Not for application data.

```
React UI ──WebSocket──→ Node.js Server ──WebSocket──→ Mobile App
    │                        │
    │ Tauri IPC              │ Tunnel
    ▼                        ▼
  Native OS             Cloudflare CDN
  (clipboard,           (remote access)
   notifications,
   file dialogs)
```

---

## Implementation Roadmap

### Phase 0: Foundation (Week 1) — Security + Critical Bugs

Before building new features, fix the issues every auditor flagged:

| Action | Effort | Why Now |
|--------|--------|---------|
| Fix `config.json` permissions (0o600) | 15 min | Security: world-readable credentials |
| Fix `settings.json` permissions (0o600) | 15 min | Security: same issue |
| Remove token from HTML/URL rendering | 2-4 hours | Security: token exposed in page source |
| Add `safeTokenCompare` tests | 20 min | Untested security-critical code |
| Fix `_broadcastToSession` session filtering | 4-8 hours | Messages going to wrong sessions |
| Add `tauri-plugin-single-instance` | 1-2 hours | Prevents dual-launch data races |

**Total: ~3 days.** Clears the decks for feature work.

### Phase 1: React Migration (Weeks 2-3) — The UI Foundation

Replace the vanilla JS dashboard with a React app. This is the prerequisite for every IDE feature.

| Action | Effort | Notes |
|--------|--------|-------|
| Set up Vite + React build pipeline | 2-3 days | Output to `packages/server/src/dashboard/dist/`, served by existing HTTP handler |
| Port core components to React | 5-7 days | Terminal view, chat messages, input bar, status bar |
| WebSocket hook (`useWebSocket`) | 1 day | Zustand store, mirrors mobile app's `connection.ts` pattern |
| Verify existing functionality preserved | 1-2 days | All current dashboard features work in React |

**Key decisions:**
- The React app is served by the Node.js server at `/dashboard`, same as today
- Tauri WebView loads this URL, same as today
- The build output ships with the server package (no separate build step for users)
- Share component patterns with mobile app where possible (markdown renderer, terminal view)

### Phase 2: Sidebar + Session Tabs (Weeks 4-5) — The IDE Layout

This is where Chroxy becomes a CLI Agent IDE.

| Action | Effort | Notes |
|--------|--------|-------|
| Sidebar component with repo tree | 3-4 days | Repo headers, active sessions, resumable sessions |
| Tab system for main pane | 2-3 days | Open/close tabs, terminal per tab, tab switching |
| Welcome/quick-start screen | 1 day | Shown when no tabs open |
| Repo discovery (past conversations) | 1-2 days | ConversationScanner already groups by repo path |
| Add Repo manually (+ button) | 1 day | User adds a directory, validated as git repo |
| Session creation from sidebar | 1 day | Click + next to repo → create session modal |
| Session resume from sidebar | 1 day | Click resumable session → `resume_conversation` |

**Server-side support needed:**
- `list_conversations` already returns past conversations grouped by project path
- `resume_conversation` already creates a session from a past conversation
- `subscribe_sessions` (new): client subscribes to multiple session event streams simultaneously, enabling multi-tab without re-subscribing on every tab switch

### Phase 3: Polish + Power Features (Weeks 6-8) — Desktop-Native Experience

| Action | Effort | Notes |
|--------|--------|-------|
| Native notifications for permission requests | 2-3 days | Tauri notification API when window not focused |
| Tunnel status in sidebar footer | 1-2 days | Structured health endpoint → sidebar display |
| Session naming / auto-labels | 1 day | Truncated first message or custom name |
| Repo pinning / favorites | 1 day | Pin repos to top of sidebar |
| Keyboard shortcuts | 1-2 days | Cmd+1-9 for tabs, Cmd+N new session, Cmd+W close tab |
| Split pane (optional) | 3-5 days | View two sessions side by side |
| Session search / filter | 1 day | Filter sidebar by repo or session name |

### Phase 4: Expandability Platform (Months 3-6) — IDE Features

Once the core orchestrator is solid, expand toward IDE capabilities:

| Feature | Description | Builds On |
|---------|-------------|-----------|
| **File browser panel** | Browse project files from the session's CWD | Existing `browse_files` / `read_file` protocol |
| **Diff viewer panel** | View uncommitted changes per session | Existing `get_diff` protocol |
| **Checkpoint timeline** | Visual timeline of checkpoints, branch from any point | Existing checkpoint system |
| **Rich settings UI** | Model selection, permission modes, cost budgets per session | Existing protocol messages |
| **Agent monitoring dashboard** | Visualize subagent trees, cost per agent | Existing `agent_spawned/completed` events |
| **Multi-machine support** | Connect to Chroxy servers on multiple dev machines | Tunnel URLs as connection targets |
| **Plugin system** | Custom panels, tools, integrations | Architecture TBD |
| **Integrated code review** | Review agent changes with inline comments before approving | Builds on diff viewer |

### What's Deferred (Probably Never)

These were proposed in the original audit but don't serve the vision:

| Item | Why Deferred |
|------|-------------|
| Binary serialization (MessagePack/CBOR) | JSON is fine for this scale. Premature optimization. |
| IPC channel replacing WebSocket for desktop | WebSocket keeps desktop/mobile in sync on the same protocol. The overhead is negligible on localhost. |
| Shared-memory terminal buffers | Doesn't exist in Tauri's architecture. |
| Protocol v2 with backward compatibility | Monorepo clients ship together. Additive protocol changes don't need versioning. |
| Message priority system | 1-2 concurrent clients. No contention. |

---

## Design Principles

### 1. The Server Is the Brain, the Desktop Is the Face

All application logic lives in the Node.js server. The React UI is a view layer that sends WebSocket messages and renders responses. This means:
- Mobile and desktop are peers, not primary/secondary
- Server can run headless (existing CLI mode still works)
- New UI features are mostly client-side work

### 2. Build for Expandability

Every panel (sidebar, terminal, file browser, diff viewer) should be a self-contained component that connects to the WebSocket. Adding a new panel = adding a new component that subscribes to the right message types. This is how Cursor and VS Code extensions work — each panel owns its own data flow.

### 3. Progressive Enhancement

Each phase is usable on its own:
- Phase 0: Existing dashboard, but secure
- Phase 1: React dashboard, same features, better foundation
- Phase 2: IDE layout — this is the "wow" moment
- Phase 3: Polish — this is the "daily driver" moment
- Phase 4: Platform — this is the "why would I use anything else" moment

### 4. Convention over Configuration

The app should work with zero setup for common cases:
- Repos discovered automatically from Claude Code history
- Server starts with the app (autostart)
- Tunnel starts if configured (or LAN mode by default)
- Sensible defaults for model, permissions, session limits

---

## Technical Reference

### Existing Protocol Messages (Relevant to Desktop IDE)

**Session Management:**
- `create_session` / `session_created` — new session with repo CWD
- `list_sessions` / `session_list` — all active sessions
- `switch_session` / `session_switched` — change active session (triggers history replay)
- `destroy_session` / `session_destroyed` — cleanup
- `rename_session` — custom session labels

**Conversation Resume:**
- `list_conversations` / `conversations_list` — past conversations grouped by project
- `resume_conversation` — create session from past conversation

**Session Interaction:**
- `input` — send message to active session
- `interrupt` — stop active generation
- `stream_start/delta/end` — streaming response
- `tool_start/result` — tool execution
- `permission_request/response` — permission approval flow
- `plan_started/ready` — plan mode
- `user_question/response` — interactive questions

**File Operations:**
- `browse_files` / `file_listing` — directory listing within project
- `read_file` / `file_content` — file content with syntax metadata
- `get_diff` / `diff_result` — git diff

**Agent Monitoring:**
- `agent_busy/idle` — session activity state
- `agent_spawned/completed` — subagent lifecycle

### New Protocol Messages Needed

| Message | Direction | Purpose |
|---------|-----------|---------|
| `subscribe_sessions` | Client → Server | Subscribe to events for multiple sessions (multi-tab) |
| `session_activity` | Server → Client | Lightweight activity update for sidebar (busy/idle/cost) without full message replay |
| `list_repos` | Client → Server | Request discovered + manually-added repos |
| `repo_list` | Server → Client | Repos with session counts and metadata |
| `add_repo` / `remove_repo` | Client → Server | Manage repo list |

### Data Flow: Session Tab Lifecycle

```
User clicks session in sidebar
  → Client: subscribe_sessions([...openTabs, newSessionId])
  → Client: switch_session(newSessionId)  // for "active" tab indicator
  → Server: session_switched + history_replay_start + messages + history_replay_end
  → Client: open new tab, render terminal with replayed history
  → Subsequent events for this session arrive via existing broadcast
  → User sends message in tab → input(text, sessionId) → streamed response
```

### Data Flow: Resume Past Conversation

```
User clicks resumable session in sidebar (○)
  → Client: resume_conversation({ conversationId, cwd, name })
  → Server: creates new SdkSession with resumeSessionId
  → Server: session_created + session_switched
  → Client: open new tab, session is live
  → Sidebar: moves from ○ resumable to ✦ active
```

---

## What the Audit Got Right

The original codebase audit produced valuable analysis. Here's what carries forward:

1. **Data flow diagrams** (Section 5) — accurate, comprehensive, useful as reference
2. **Component inventory** — every file:line reference validated across 3 audit rounds
3. **Security findings** — token-in-HTML, config permissions, untested crypto — all confirmed and in Phase 0
4. **`_broadcastToSession` bug** — confirmed by all 10 auditors, in Phase 0
5. **Tunnel adapter pattern** — praised by all auditors as extensible and clean
6. **E2E encryption** — identified as a differentiator with no competitor equivalent
7. **EventNormalizer pattern** — declarative event mapping praised as correct architecture
8. **Provider registry** — strategy pattern with capability introspection praised as extensible

## What the Audit Missed

The audit was scoped as "inform the development of an enhanced desktop application layer" but spent most of its analysis on protocol optimization and over-engineering concerns. It correctly identified the pieces but didn't assemble them into the product vision:

- The sidebar + repo tree concept wasn't explored
- Multi-tab terminal views weren't designed
- The welcome screen / onboarding flow wasn't considered
- The "replace my terminal workflow" user journey wasn't articulated
- ConversationScanner was described but not connected to "resumable sessions in sidebar"
- Phase 4 expandability (file browser, diff viewer, agent monitoring as panels) wasn't imagined

The swarm audit (v2, v3) further drifted toward minimalism — correctly killing over-engineering but also deferring the features that make this an IDE rather than a tray wrapper.

---

*This document is the north star for Chroxy Desktop development. The audit findings inform the implementation. The vision drives the roadmap.*

*Last Updated: 2026-03-01*
