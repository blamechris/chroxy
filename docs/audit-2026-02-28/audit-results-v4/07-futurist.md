# Futurist Audit: Chroxy Desktop as a CLI Agent IDE

**Auditor Role:** Product Strategist + Architect (6-18 month horizon)
**Rating: 3.5 / 5** — The plan builds a solid session orchestrator but leaves critical expandability decisions unspecified. Phases 1-3 will deliver a usable product; Phase 4 is a bullet-point wishlist that needs architecture now to avoid costly rework later.

---

## 1. Where This Product Sits in the Landscape

### Competitive Map (March 2026)

| Product | Core Strength | Weakness Chroxy Exploits |
|---------|---------------|--------------------------|
| **Cursor** | Code editor with inline AI, tab completion, chat | Tightly coupled to file editing; no multi-repo orchestration; no headless/remote agent management |
| **Windsurf (Codeium)** | AI-native editor, "Cascade" agentic flows | Same as Cursor — editor-first, single-repo, no remote/mobile access |
| **Warp** | AI-powered terminal, blocks, workflows | Terminal-centric, no session orchestration across repos; no mobile companion |
| **iTerm2 + Claude Code** | Raw CLI power | Manual everything — no session management, no multi-repo UI, no remote access |
| **Claude Code Web** | Zero-install cloud sandbox | No local code access, no persistent dev environment, can't use local MCP servers |
| **Chroxy** | Multi-repo agent orchestrator with mobile companion | No code editing, no file tree inline editing, no tab completion |

### Chroxy's Unique Position

Chroxy is the **air traffic controller** for AI coding agents. It does not compete with editors — it orchestrates the agents that work within them. This is a fundamentally different product category.

**The thesis**: As AI coding agents become more autonomous (longer runs, multi-step tasks, subagent trees), the bottleneck shifts from "writing code" to "managing agents." Chroxy is built for this future.

**Key differentiators no competitor has:**
1. **Multi-repo session orchestration** — Switch between agents working on different repos from one UI
2. **Mobile companion** — Approve permissions, send instructions, monitor agents from your phone
3. **E2E encryption over tunnel** — Secure remote access; no competitor offers this for CLI agents
4. **Cloud task delegation** — Fire-and-forget tasks to Claude Code Web, teleport results back locally
5. **Checkpoint/rewind** — Branch conversation history with git state snapshots

---

## 2. Phase 4 Feature Specifications

The vision document lists Phase 4 features as bullet points. Here they are specified concretely enough to estimate and architect.

### 2.1 File Browser Panel

**What it is:** A side panel showing the file tree of the active session's `cwd`, with read-only file viewing and syntax highlighting.

**Specification:**
- Tree view component rooted at `session.cwd`
- Lazy-loaded: only fetch children when a directory is expanded
- File icons by extension (using a lightweight icon set, not a full icon theme)
- Click file to open in a read-only viewer with syntax highlighting
- Show git status decorations (modified, untracked, staged) on files
- "Open in editor" button that shells out to `$EDITOR` or VS Code via `code` CLI
- Real-time updates: when agent creates/modifies/deletes files, the tree should reflect changes

**Protocol needs:**
- `browse_files` and `read_file` already exist
- NEW: `watch_files { sessionId, path }` / `file_changed { sessionId, path, event: 'create'|'modify'|'delete' }` for real-time updates
- Alternative: poll on `result` events (agent just finished, files likely changed)

**Effort estimate:** 5-8 days (3-4 for tree component, 2-3 for file viewer, 1 for git decorations)

**Architecture dependency:** Requires the React component system from Phase 1 and the panel layout system discussed in Section 4.

### 2.2 Diff Viewer Panel

**What it is:** An inline diff viewer showing uncommitted changes in the active session's repo, updated after each agent turn.

**Specification:**
- Split pane or unified diff view (user toggle)
- File-level navigation: list of changed files in a sidebar, click to see diff
- Line-level syntax highlighting in both old/new panes
- Auto-refresh after each `result` event (agent finished a turn)
- "Stage" / "Discard" buttons per file or per hunk (stretch goal)
- "Create checkpoint" button at the top

**Protocol needs:**
- `get_diff` already exists and returns raw unified diff
- `diff_result` already returns parsed diff output
- NEW: `get_diff_structured { sessionId }` returning `{ files: [{ path, hunks: [{ oldStart, newStart, lines }] }] }` — or parse the existing unified diff client-side (simpler, fewer protocol changes)

**Effort estimate:** 8-12 days (3-4 for diff rendering engine, 2-3 for file navigation, 2-3 for syntax highlighting, 1-2 for auto-refresh and checkpoint integration)

**Architecture dependency:** Diff parsing already exists server-side in `diff-parser.js`. The client needs a diff rendering component. Consider using a library like `react-diff-view`.

### 2.3 Checkpoint Timeline

**What it is:** A visual timeline showing all checkpoints for a session, with the ability to branch from any point.

**Specification:**
- Horizontal or vertical timeline showing checkpoints chronologically
- Each checkpoint node shows: name, timestamp, message count, has-git-snapshot indicator
- Click a checkpoint to see its details (description, what changed)
- "Branch from here" action: restores git state and creates a new session with `resumeSessionId` from that checkpoint
- "Compare" action: diff between two checkpoints
- Auto-checkpoint option: create checkpoint after every N agent turns or on explicit user request

**Protocol needs:**
- `list_checkpoints`, `create_checkpoint`, `restore_checkpoint`, `delete_checkpoint` all exist
- NEW: `compare_checkpoints { sessionId, checkpointA, checkpointB }` returning a diff between two checkpoint git states
- ENHANCEMENT: `checkpoint_created` event should broadcast to all clients viewing the session

**Effort estimate:** 5-7 days (2-3 for timeline component, 1-2 for branch-from-here flow, 1-2 for auto-checkpoint logic)

**Architecture dependency:** The `CheckpointManager` is well-designed and sufficient. The git tag approach is durable. The main risk is the stash-based snapshot for dirty working trees — it can fail with merge conflicts on restore. Consider documenting this limitation and offering a "force restore" that does `git checkout` instead.

### 2.4 Agent Monitoring Dashboard

**What it is:** A visualization of the subagent tree for the active session, showing which subagents are running, their cost, and their status.

**Specification:**
- Tree visualization: root agent at top, subagents as children
- Each node shows: tool use ID, description, status (running/completed), duration, cost
- Running agents pulse or animate
- Click a subagent to filter the chat/terminal view to its output
- Aggregate cost display at the top
- Historical view: show completed subagent trees from past turns

**Protocol needs:**
- `agent_spawned` and `agent_completed` events already exist
- These events include `toolUseId` and `description`
- MISSING: parent-child relationship between agents. Currently, subagent spawning is flat — there is no `parentToolUseId` field. The server would need to track which agent spawned which subagent.
- MISSING: per-agent cost attribution. The `result` event has aggregate cost but not per-subagent.

**Effort estimate:** 8-12 days (3-4 for tree visualization, 2-3 for real-time updates, 2-3 for cost attribution, 1-2 for filtering)

**Architecture dependency:** This is the feature most likely to require SDK-level changes. The Agent SDK may not expose parent-child agent relationships. If it does not, Chroxy can infer the tree by tracking `tool_start` → `agent_spawned` sequences (the `toolUseId` from `tool_start` that precedes `agent_spawned` is the parent call), but this is fragile. File a feature request with the SDK team.

### 2.5 Multi-Machine Support

**What it is:** Connect the desktop app to multiple Chroxy servers running on different machines (work laptop, home desktop, cloud VM).

**Specification:**
- "Add Server" in the sidebar: enter tunnel URL + token, or scan QR
- Each server appears as a top-level group in the sidebar (above repos)
- Sessions from all servers are visible simultaneously
- Tab system works across servers: one tab can show a session from server A, another from server B
- Server health status in the sidebar (connected/disconnected/reconnecting)
- E2E encryption per server connection

**Protocol needs:**
- No server-side changes needed — the protocol already supports remote clients
- Client-side: manage multiple WebSocket connections, one per server
- Route messages to the correct connection based on server ID
- Session IDs must be namespaced: `{serverId}:{sessionId}` to avoid collisions

**Effort estimate:** 10-15 days (3-4 for multi-connection management, 3-4 for sidebar restructuring, 2-3 for tab routing, 2-4 for error handling and reconnection per server)

**Architecture dependency:** This is the most architecturally impactful Phase 4 feature. The WebSocket hook from Phase 1 (`useWebSocket`) must be designed from the start to support multiple connections. If it is hardcoded to a single connection, multi-machine will require a rewrite. See Section 3.

### 2.6 Integrated Code Review

**What it is:** Review agent-generated changes with inline comments before committing or continuing.

**Specification:**
- After an agent turn, user can enter "review mode"
- Shows all file changes (diff viewer) with the ability to add inline comments
- Comments are fed back to the agent as context: "The user reviewed your changes and commented: ..."
- "Approve" / "Request Changes" / "Approve with Comments" actions
- Approve commits the changes (or lets the agent continue)
- Request Changes sends the comments back to the agent for revision
- Integration with checkpoint: auto-checkpoint before review, so the user can always go back

**Protocol needs:**
- NEW: `review_request { sessionId, files, comments }` — sent to agent as a structured user message
- Builds on diff viewer protocol
- Builds on checkpoint protocol

**Effort estimate:** 12-18 days (5-7 for review UI with inline commenting, 3-4 for agent feedback loop, 2-3 for checkpoint integration, 2-4 for edge cases)

**Architecture dependency:** Requires diff viewer (2.2) and checkpoint system (2.3) to be working first.

---

## 3. Architecture Decisions in Phases 1-3 That Affect Expandability

These are the decisions that will make or break Phase 4. Get them wrong and you are looking at significant rework.

### 3.1 CRITICAL: Panel Layout System (Phase 2)

**The Decision:** How are panels composed in the UI?

**Wrong approach:** Hardcode the layout as `<Sidebar /> <MainPane />` with fixed components.

**Right approach:** Build a panel registry and layout manager from the start.

```
// Panel registry pattern
const panelRegistry = new Map()

registerPanel('sidebar', {
  component: SidebarPanel,
  defaultPosition: 'left',
  defaultWidth: 280,
  resizable: true,
  collapsible: true,
})

registerPanel('terminal', {
  component: TerminalPanel,
  defaultPosition: 'center',
  accepts: 'tabs',
})

registerPanel('file-browser', {
  component: FileBrowserPanel,
  defaultPosition: 'left',  // below sidebar
  defaultWidth: 280,
  resizable: true,
  collapsible: true,
})

registerPanel('diff-viewer', {
  component: DiffViewerPanel,
  defaultPosition: 'bottom',
  defaultHeight: 300,
  resizable: true,
  collapsible: true,
})
```

**Why this matters:** Every Phase 4 feature is a new panel. If the layout is not panel-aware, each new feature requires layout surgery. VS Code's panel system is the gold standard — study its `viewContainers` and `views` contribution points.

**Recommendation for Phase 2:** Implement a basic 3-zone layout (left sidebar, center main, optional bottom panel) with resizable borders. The "optional bottom panel" slot is cheap to add now and unlocks diff viewer, terminal-as-panel, and agent monitoring later.

### 3.2 CRITICAL: WebSocket Hook Design (Phase 1)

**The Decision:** How does the React app manage its WebSocket connection(s)?

**Wrong approach:**
```typescript
// Single-connection singleton
const useWebSocket = create((set) => ({
  socket: null,
  connected: false,
  connect: (url, token) => { ... }
}))
```

**Right approach:**
```typescript
// Connection-aware store that supports multiple servers
interface ServerConnection {
  id: string
  url: string
  token: string
  socket: WebSocket | null
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  sessions: Map<string, Session>
}

const useConnections = create((set) => ({
  connections: new Map<string, ServerConnection>(),
  activeConnectionId: string | null,

  addConnection: (url, token) => { ... },
  removeConnection: (id) => { ... },

  // Unified session access across all connections
  getAllSessions: () => { ... },
  getSession: (serverId, sessionId) => { ... },
}))
```

**Why this matters:** If Phase 1 builds a single-connection store, multi-machine (Phase 4, feature 2.5) requires a complete state management rewrite. The cost of abstracting to support multiple connections in Phase 1 is approximately 1-2 extra days. The cost of retrofitting it later is 5-10 days plus regressions.

**Recommendation:** Even if Phase 1 only uses one connection, design the store to hold a `Map<string, ServerConnection>` with a `defaultConnectionId` that the app uses everywhere. This is the single most important architectural decision for Phase 4.

### 3.3 IMPORTANT: Message Routing Architecture (Phase 2)

**The Decision:** How do components subscribe to WebSocket messages?

**Wrong approach:** Global event listener, every component gets every message, filters manually.

**Right approach:** Topic-based subscriptions that components declare.

```typescript
// Each panel declares what it subscribes to
function TerminalPanel({ sessionId }) {
  const messages = useSessionMessages(sessionId, [
    'stream_start', 'stream_delta', 'stream_end',
    'tool_start', 'tool_result',
    'permission_request',
  ])
  // ...
}

function DiffViewerPanel({ sessionId }) {
  const diff = useSessionMessages(sessionId, ['diff_result'])
  // Auto-request diff on 'result' event
  useOnSessionEvent(sessionId, 'result', () => {
    sendMessage({ type: 'get_diff', sessionId })
  })
  // ...
}
```

**Why this matters:** Without structured message routing, adding new panels means adding new switch cases to a growing message handler. With subscriptions, each panel is self-contained and can be added or removed without touching other code. This is how VS Code extensions work — each extension declares its data sources.

**Recommendation:** Build a `useSessionMessages(sessionId, messageTypes[])` hook in Phase 1 that filters the message stream per component. This creates the foundation for the plugin system.

### 3.4 IMPORTANT: Panel Data Independence (Phase 2)

**The Decision:** Do panels share state, or does each panel own its data?

**Right approach:** Each panel owns its data and fetches what it needs. The only shared state is the session identity (which session is active in which tab).

```
Sidebar:     owns repo list, session list, health status
Terminal:    owns message buffer, terminal state
FileViewer:  owns file tree, open file content
DiffViewer:  owns diff data
Checkpoint:  owns checkpoint list
Agent Tree:  owns agent hierarchy
```

**Why this matters:** Shared state creates coupling. If the terminal panel and the file browser share a "current file" state, changes to one break the other. Independent data ownership means panels can be developed, tested, and shipped independently — the foundation of a plugin system.

### 3.5 MODERATE: Server-Side Panel API Pattern (Phase 3)

**The Decision:** How does the server expose data for new panel types?

The current protocol is a flat namespace of message types. This works for 30 types. It will become unwieldy at 60+.

**Recommendation:** Group new Phase 4 messages under a namespace convention:

```
// Current (flat)
browse_files, read_file, get_diff

// Phase 4 (namespaced)
panel.files.browse
panel.files.read
panel.files.watch
panel.diff.get
panel.diff.structured
panel.checkpoint.list
panel.checkpoint.compare
panel.agents.tree
panel.agents.filter
```

This is NOT a protocol version change — it is a naming convention for new messages that signals "this message is for a panel." Existing messages keep their names.

---

## 4. Plugin / Extension System Design Sketch

This is the Phase 4 "platform" capability that turns Chroxy from a product into an ecosystem.

### 4.1 What a Plugin Is

A Chroxy plugin is:
1. A React component that renders in a panel slot
2. A set of WebSocket message types it subscribes to and sends
3. Optional server-side handler functions for new message types
4. A manifest declaring metadata, dependencies, and activation rules

```json
{
  "name": "chroxy-plugin-diff-viewer",
  "version": "1.0.0",
  "displayName": "Diff Viewer",
  "panels": [
    {
      "id": "diff-viewer",
      "component": "./DiffViewerPanel",
      "defaultPosition": "bottom",
      "activateOn": "session.active",
      "icon": "git-compare"
    }
  ],
  "subscribes": ["result", "diff_result"],
  "sends": ["get_diff"],
  "serverHandlers": null
}
```

### 4.2 Plugin Architecture

```
chroxy-desktop/
  plugins/
    built-in/
      sidebar/
      terminal/
      file-browser/
      diff-viewer/
    community/
      custom-theme/
      jira-integration/
```

**Key principles:**
- Built-in features (sidebar, terminal) are plugins themselves — they use the same API
- Plugins are sandboxed: they can only access the WebSocket messages they declare
- Plugins cannot modify other plugins' state
- Plugin UI runs in the same React tree (not iframes) for performance
- Server-side plugin handlers are optional and loaded dynamically

### 4.3 Extension Points

| Extension Point | What It Allows | Example |
|-----------------|----------------|---------|
| Panel | New UI panel in any layout slot | File browser, diff viewer, agent tree |
| Status Bar Item | New item in the bottom status bar | Custom cost tracker, CI status |
| Sidebar Section | New section in the left sidebar | Jira tickets, GitHub issues |
| Context Menu | Add items to right-click menus | "Open in VS Code", "Copy file path" |
| Message Handler | Process new server message types | Custom analytics, logging |
| Command | Register a keyboard shortcut action | "Toggle diff viewer", "Create checkpoint" |

### 4.4 When to Build This

Not in Phase 4. The plugin system is a Phase 5 concern. But the architecture decisions above (panel registry, message routing, data independence) are the preconditions. If Phases 1-3 are built with these patterns, extracting them into a plugin API later is a refactoring exercise, not a rewrite.

**Recommendation:** Build Phases 1-3 as if every panel were a plugin, but do not build the plugin loading/manifest system until there is community demand.

---

## 5. MCP Integration: The Underexplored Superpower

### Current State

`mcp-tools.js` is a 47-line utility that parses MCP tool names (`mcp__server__tool`) into display-friendly labels. The server forwards `mcp_servers` events showing connected MCP server names and statuses. That is the extent of MCP integration.

### The Opportunity

MCP (Model Context Protocol) is the **extension mechanism for agent capabilities**. Chroxy's MCP story should go far beyond tool name parsing:

**5.1 MCP Server Management Panel**
- Show all MCP servers configured for each session's project (from `.mcp.json`)
- Status indicators: connected, disconnected, error
- One-click restart of failed MCP servers
- "Add MCP Server" UI for configuring new servers

**5.2 MCP Tool Visualization**
- When an agent uses an MCP tool, show richer context than just the tool name
- Render MCP tool inputs and outputs with type-aware formatting
- Group MCP tool calls by server in the agent monitoring panel
- Show MCP server cost/latency metrics

**5.3 Chroxy as an MCP Server**
- Expose Chroxy's own capabilities as MCP tools
- Other agents could use `mcp__chroxy__create_session` to spawn Chroxy sessions
- This enables meta-orchestration: an outer agent managing inner Chroxy agents

**5.4 MCP Server Discovery**
- Scan project directories for `.mcp.json` files
- Suggest MCP servers based on project type (e.g., "This is a Node.js project — would you like to add the npm MCP server?")
- Share MCP configurations across repos via a global Chroxy MCP config

### Architecture Impact

MCP integration does not require architectural changes to Phases 1-3. The server already forwards MCP events. The main work is:
1. Server: parse `.mcp.json` files and expose server details via a new `get_mcp_config` message
2. Server: add MCP server restart capability
3. Client: build an MCP management panel (follows the panel pattern from Section 3.1)

---

## 6. Cloud Tasks: The Hybrid Execution Model

### Current State

`WebTaskManager` is well-structured with proper feature detection, task lifecycle management, and child process safety. It detects `--remote` and `--teleport` CLI flags and manages fire-and-forget cloud tasks.

### The Strategic Opportunity

Cloud tasks represent a unique hybrid execution model that no competitor offers:

```
Local Session (Chroxy)          Cloud Task (Claude Code Web)
  - Full local code access        - No local access
  - Uses local MCP servers        - Uses cloud sandbox
  - Costs user's API credits      - Costs user's API credits
  - Real-time streaming           - Poll-based status
  - Permission prompts            - Autonomous
  - Can modify local files        - Isolated sandbox
```

**6.1 Intelligent Task Routing**
- Some tasks are better suited for cloud execution (research, documentation generation, independent utilities)
- Some tasks require local execution (anything touching local files, MCP servers, or secrets)
- Chroxy could suggest routing: "This task doesn't need local files — run it in the cloud for parallel execution?"

**6.2 Cloud Task Results Integration**
- When a cloud task completes, show its output alongside local sessions in the sidebar
- "Teleport" (pull cloud work locally) should be a first-class action with visual feedback
- Show cloud vs. local execution cost comparison

**6.3 Parallel Execution Dashboard**
- Local session limit is 5; cloud tasks have no such limit
- Chroxy becomes a task dispatcher: "Run these 10 independent tasks in the cloud, monitor them from the sidebar, pull results back when done"
- This is the most compelling "why Chroxy" argument for power users

### Architecture Impact

The `WebTaskManager` is well-isolated and event-driven. No changes needed to Phases 1-3. The main work is UI:
1. Cloud tasks panel in the sidebar (shows alongside local sessions)
2. Task routing suggestions (client-side heuristic)
3. Teleport flow with progress indicator

---

## 7. 18-Month Roadmap

### Month 1-2: Foundation (Phases 0-1)
- Security fixes (Phase 0)
- React migration with Vite build pipeline
- WebSocket hook designed for multi-connection (Section 3.2)
- Component library established

### Month 3-4: IDE Layout (Phases 2-3)
- Sidebar with repo tree and session management
- Tab system with multi-session viewing
- Panel layout system with resizable zones (Section 3.1)
- Keyboard shortcuts, native notifications
- **Milestone: "Replace my terminal" daily-driver moment**

### Month 5-6: First IDE Panels (Phase 4a)
- File browser panel
- Diff viewer panel
- Checkpoint timeline
- Cloud task integration in sidebar

### Month 7-9: Agent Intelligence (Phase 4b)
- Agent monitoring dashboard with subagent tree
- MCP server management panel
- Integrated code review flow
- Per-session cost tracking and budget visualization

### Month 10-12: Multi-Machine + Polish (Phase 4c)
- Multi-machine support (connect to multiple Chroxy servers)
- Session templates and workspace presets
- Advanced settings UI (per-repo model/permission defaults)
- Performance optimization (virtual scrolling, lazy panel loading)

### Month 13-15: Platform (Phase 5)
- Plugin manifest system
- Plugin loading and sandboxing
- Developer documentation for plugin authors
- First community plugins (themes, integrations)

### Month 16-18: Ecosystem
- Plugin marketplace or registry
- Chroxy as MCP server (meta-orchestration)
- Team features (shared servers, session handoff)
- Enterprise features (audit logging, SSO, centralized config)

---

## 8. Risk Analysis: What Kills This Product?

### Risk 1: Claude Code Gets a Built-In GUI (HIGH)
**Threat:** Anthropic ships a first-party desktop app for Claude Code with session management and a sidebar.
**Mitigation:** Chroxy's value is orchestration across repos and remote access. A first-party GUI would likely be single-repo. But if Anthropic builds multi-repo orchestration natively, Chroxy's market shrinks to remote/mobile access and the plugin ecosystem. **Action:** Ship fast. Get to Phase 2 ("wow" moment) before Anthropic can iterate on a GUI. Build features Anthropic is unlikely to build (mobile companion, multi-machine, E2E encryption over tunnel).

### Risk 2: Agent SDK Breaking Changes (MEDIUM)
**Threat:** The Claude Agent SDK changes its event format, capability model, or conversation resume mechanism.
**Mitigation:** The `SdkSession` wrapper and `EventNormalizer` already abstract SDK specifics. The provider registry pattern means a new SDK version can be a new provider without breaking the old one. **Action:** Keep the abstraction layers clean. Never leak SDK-specific types into the WebSocket protocol.

### Risk 3: Scope Creep Into Code Editor Territory (MEDIUM)
**Threat:** Phase 4 features like diff viewer, file browser, and code review gradually pull Chroxy toward being a code editor, competing directly with Cursor/VS Code where Chroxy cannot win.
**Mitigation:** Draw a hard line: Chroxy shows code, it does not edit code. The file browser is read-only. The diff viewer shows changes, it does not author them. The code review sends comments back to the agent, it does not let the user edit files inline. **Action:** Every feature proposal should pass the test: "Does this make Chroxy a better orchestrator, or a worse editor?"

### Risk 4: React Migration Stalls (MEDIUM)
**Threat:** The React migration (Phase 1) takes longer than expected. The 2000-line vanilla JS dashboard works. Motivation to complete the migration fades.
**Mitigation:** Phase 1 must be all-or-nothing. Do not maintain two dashboard implementations. The vanilla JS dashboard should be deleted when the React dashboard reaches feature parity. **Action:** Set a hard deadline for Phase 1 completion. If it slips beyond 3 weeks, re-evaluate scope.

### Risk 5: Single Developer Bandwidth (HIGH)
**Threat:** One developer cannot ship Phase 4 features fast enough to stay ahead of competitors.
**Mitigation:** The plugin system (Phase 5) is the escape valve — community contributors build features the sole developer cannot. But Phase 5 requires Phases 1-4 first. **Action:** Prioritize ruthlessly. Ship the features that no competitor can replicate (multi-repo orchestration, mobile companion, E2E encryption, cloud task hybrid). Defer features that are "nice to have" (themes, advanced settings, plugin marketplace).

### Risk 6: WebSocket-Only Architecture Limits Scale (LOW)
**Threat:** The decision to use WebSocket for everything (including local desktop) adds latency or complexity that an IPC channel would avoid.
**Mitigation:** The vision document correctly defers IPC optimization. WebSocket on localhost adds negligible overhead for this use case (low-frequency JSON messages, not video streaming). **Action:** Do not build IPC. The complexity cost is not worth the performance gain. If profiling later shows WebSocket is a bottleneck, address it then.

---

## 9. Summary of Recommendations

### Must-Do in Phases 1-3 (for Phase 4 viability)

| # | Recommendation | Phase | Effort | Impact if Skipped |
|---|---------------|-------|--------|-------------------|
| 1 | Design WebSocket store for multi-connection from day one | Phase 1 | +1-2 days | Multi-machine requires full rewrite |
| 2 | Build panel layout with resizable zones and a registry | Phase 2 | +2-3 days | Every Phase 4 panel requires layout surgery |
| 3 | Implement topic-based message subscription hooks | Phase 1 | +1 day | Plugin system impossible without rewrite |
| 4 | Keep panels data-independent (no shared mutable state) | Phase 2 | Design discipline | Coupling makes adding panels increasingly painful |
| 5 | Use namespaced message types for new panel protocols | Phase 3 | Naming convention | Protocol becomes an unmaintainable flat namespace |

### Should-Do in Phase 4 (prioritized)

| Priority | Feature | Effort | Strategic Value |
|----------|---------|--------|-----------------|
| 1 | File browser panel | 5-8 days | Table stakes for "IDE" positioning |
| 2 | Diff viewer panel | 8-12 days | Core review workflow |
| 3 | Multi-machine support | 10-15 days | Unique differentiator |
| 4 | Checkpoint timeline | 5-7 days | Enables branching workflow |
| 5 | Agent monitoring | 8-12 days | Showcase for "orchestrator" positioning |
| 6 | Integrated code review | 12-18 days | Highest value but highest complexity |

### Should NOT Do

| Item | Reason |
|------|--------|
| Inline code editing | Becomes a worse VS Code. Stay read-only. |
| IPC channel for local desktop | Premature optimization. WebSocket is fine. |
| Binary protocol (MessagePack) | JSON is readable and debuggable. Not a bottleneck. |
| Plugin marketplace before Phase 5 | Build the platform first, then the ecosystem. |
| Team/enterprise features before Month 15 | Focus on single-developer power user first. |

---

*This audit evaluates architectural readiness for the 6-18 month product vision. The foundation is strong — the provider registry, tunnel adapter, event normalizer, and checkpoint system are all well-designed for extension. The main risk is not architecture but velocity: can a single developer ship the "wow" moment (Phase 2) fast enough to establish the product category before competitors notice?*
