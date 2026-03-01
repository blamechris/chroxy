# Master Assessment: CLI Agent IDE Vision Audit (v4)

**Panel Size**: 10 agents (Skeptic, Builder, Guardian, UX Architect, Tester, Tauri Expert, Futurist, Adversary, Operator, Historian)
**Date**: 2026-03-01
**Subject**: `docs/architecture/desktop-vision.md`
**Purpose**: Validate and enhance the implementation plan for the CLI Agent IDE

---

## Panel Results

| # | Agent | Rating | Focus |
|---|-------|--------|-------|
| 1 | Skeptic | 4.0/5 | Plan verification against actual code |
| 2 | Builder | 4.2/5 | Effort estimates, build order, component architecture |
| 3 | Guardian | 3.2/5 | Reliability and failure modes for multi-tab IDE |
| 4 | UX Architect | 2.5/5 | Interaction design (rated the UX spec, not the vision) |
| 5 | Tester | 3.5/5 | Testing strategy per phase |
| 6 | Tauri Expert | 3.0/5 | Tauri v2 patterns for IDE shell |
| 7 | Futurist | 3.5/5 | Phase 4+, plugin system, competitive positioning |
| 8 | Adversary | 3.2/5 | Security for multi-session IDE |
| 9 | Operator | 3.2/5 | Daily driver experience, first-run, performance |
| 10 | Historian | 4.0/5 | Precedent analysis, timeline validation |

**Aggregate**: 3.43/5

The vision is validated. Every agent confirms the product is buildable on the existing foundation. The ratings reflect gaps in the *plan*, not doubts about the *vision*. The Skeptic and Builder rate highest because the plan is well-grounded in actual code. The UX Architect rates lowest because the vision document is a product spec, not a UX spec — that agent's 842-line report fills the gap.

---

## Critical Architecture Decision: How the React App Is Served

The single most important finding across all 10 reports is an unresolved architectural conflict:

| The Vision Says | The Tauri Expert Says |
|----------------|----------------------|
| React app served by Node.js at `http://localhost:{port}/dashboard` | React app must ship in Tauri's `frontendDist` for `window.__TAURI__` IPC to work |

**Why this matters**: If the WebView loads an external URL (`http://localhost:...`), Tauri's IPC bridge (`invoke()`, events, plugins) is unavailable. This means no native file dialogs, no clipboard, no global shortcuts, no notifications, no auto-updater — none of the desktop-native features in Phases 2-3.

**Resolution — Hybrid Model**:

The React app ships in Tauri's `frontendDist` AND connects to the Node.js server via WebSocket for all application data. This gives us both:
1. **Tauri IPC** for native features (file dialogs, clipboard, notifications, global shortcuts, updater)
2. **WebSocket** for application data (sessions, messages, terminal, sync with mobile)

The same React codebase also runs as a standalone web dashboard (served by Node at `/dashboard`) for browser access and mobile sync. The app detects its environment:
- `window.__TAURI__` exists → use Tauri IPC for native features
- `window.__TAURI__` doesn't exist → web fallback (no native features, still fully functional)

**Impact on Phase 1**: The Vite build must produce output for both Tauri (`frontendDist`) and the server (`/dashboard` route). This is one build with two deploy targets. The Builder's estimate should add 1-2 days for this dual-target setup.

---

## Revised Timeline (Panel Consensus)

| Phase | Vision Doc | Builder | Skeptic | Historian | **Consensus** |
|-------|-----------|---------|---------|-----------|---------------|
| Phase 0 | 1-2 days | 2-3 days | 2-3 days | -- | **3 days** |
| Phase 1 | ~2 weeks | ~3 weeks | +30-50% | 2 weeks | **3 weeks** |
| Phase 2 | ~2 weeks | ~3 weeks | +2-3 days server work | 2.5-3 weeks | **3 weeks** |
| Phase 3 | ~2 weeks | ~2 weeks | -- | split pane is stretch | **2 weeks** |
| **Total** | **~7 weeks** | **~9 weeks** | **10-12 weeks** | **9-10 weeks** | **~10 weeks** |

**Budget 3 months** with real-world friction (Builder). The Historian validates this against precedents (Spacedrive, Clash Verge, similar Tauri+React projects).

---

## What Every Agent Agrees On

### 1. The Foundation Is Solid

All 10 agents confirm: SessionManager, ConversationScanner, WebSocket protocol, E2E encryption, tunnel system, provider registry, EventNormalizer — these are production-grade and serve the IDE vision directly.

### 2. Single-Window Architecture

Tauri Expert, UX Architect, Builder, and Operator all converge: one window, one WebView, React handles all states (loading, IDE, error). Kill the two-window pattern (fallback + dashboard). The React app owns the full lifecycle.

### 3. `subscribe_sessions` Is the Key Server Addition

Skeptic, Builder, Guardian, and Adversary all flag: multi-tab requires session-level subscription filtering. The current `_broadcastToSession` sends everything to every client. The new `subscribe_sessions` message lets clients declare which sessions they want events for.

### 4. Server-Side Tests Are a Prerequisite

Tester (emphatically), Skeptic, and Guardian: the existing automated tests in `packages/server/` (44 test files using Node's built-in test runner) do not yet cover the multi-tab server behavior or React migration paths. The React migration is a high-risk rewrite. Extend the current test suite with regression tests for Phase 0 fixes *before* Phase 1 begins.

### 5. First-Run Wizard, Not Silent Failure

Operator and Tauri Expert: the current first-run experience has two hard cliffs (Node 22 missing, server package not found). The fallback window should be a guided setup wizard, not a blank page. Run `doctor`-equivalent checks before starting the server.

### 6. Auto-Update Mechanism Needed

Operator, Tauri Expert, and Historian: an IDE-class daily-driver app must have auto-update. `tauri-plugin-updater` should be in Phase 3 at latest, not deferred.

---

## Key Additions from the Panel

### From UX Architect (Filling the Interaction Design Gap)

The UX Architect produced the most detailed single report (842 lines). Key specs that should be incorporated into the vision doc:

- **Sidebar**: 240px default, resizable 180-400px, icon-only collapse mode, search/filter, context menus, drag-and-drop repo reordering
- **Tab management**: 10-tab soft limit, horizontal scroll overflow, close ≠ destroy session, 8 tab states (LOADING through DISCONNECTED)
- **Keyboard shortcuts**: 30+ shortcuts mapped. **Command palette (Cmd+Shift+P)** identified as the single most important power-user feature missing from the plan
- **Onboarding**: 3-step first-launch sequence with progressive feature discovery hints
- **Visual system**: CSS custom properties from mobile `colors.ts`, 10-element typography scale, 4px grid, dark-only for Phases 1-3
- **16 missing UX decisions** categorized as Critical (6), Important (5), Nice-to-Have (5)

### From Futurist (Competitive Positioning + Phase 4)

- **Product position**: "Air traffic controller for AI coding agents" — not an editor competitor, an agent orchestrator. No competitor has multi-repo orchestration + mobile companion + E2E encryption + cloud task delegation.
- **Phase 4 features estimated**: File Browser (5-8 days), Diff Viewer (8-12 days), Checkpoint Timeline (5-7 days), Agent Monitoring (8-12 days), Multi-Machine (10-15 days), Code Review (12-18 days)
- **Plugin system sketch**: Panel = React component + message subscriptions + manifest. Build Phases 1-3 as if every panel were a plugin (registry pattern) without building the plugin loader until Phase 5.
- **Critical Phase 1-3 decisions for expandability**: Panel layout system with registry (not hardcoded), topic-based message subscription hooks, data-independent panels
- **18-month roadmap** from foundation through ecosystem
- **Top risk**: Claude Code gets a built-in GUI. Mitigation: Chroxy is multi-agent, multi-repo, multi-device — a different product category.

### From Guardian (15 Failure Modes)

Most critical for implementation:
- **FM-01**: Broadcast storm under multi-tab — 5 streaming sessions = ~100 encrypted messages/sec per client. `subscribe_sessions` filtering is not optional.
- **FM-06**: Server crash recovery has no auto-restart from the Tauri side. The health poll detects crashes but requires manual restart click.
- **FM-02**: Memory growth from multiple xterm.js instances — each is ~5-15MB. Lazy init + active-tab-only rendering.
- **FM-05**: Cross-device input collision — desktop and mobile both sending to same session. Need "primary client" indicator, not blocking.

### From Builder (32-Step Build Order)

The Builder produced the most actionable report. Key structural recommendations:
- **TypeScript** for the React app (not JS)
- **Zustand** for state management, fork-and-adapt from mobile (don't try to share a package)
- **Direct xterm.js DOM integration** (not WebView wrapper like mobile)
- **CSS Modules** (not CSS-in-JS)
- **Two-URL migration strategy**: `/dashboard` (legacy) + `/dashboard-next` (React) during Phase 1 to avoid breaking the working dashboard
- **Phase 1 complete when `dashboard-app.js` is deleted** (Historian agrees — don't leave both running)

### From Adversary (Security Architecture)

- **Session-level isolation** is the key security gap for multi-repo IDE. Fix `_broadcastToSession` + add `subscribe_sessions` before Phase 2.
- **File operations need rate limiting** — `browse_files` and `read_file` have no throttle
- **Tauri CSP needs hardening** — `unsafe-inline` must go when React ships (React doesn't need it)
- **`list_directory` scoped to home, not session CWD** — a design issue for the IDE where repos should be isolated

### From Operator (Daily Driver Quality)

- **First-run wizard** in the fallback window (not separate)
- **Server bundled with desktop app** via Tauri resources (eliminate the "can't find cli.js" cliff)
- **Performance budget**: ~90-150MB per session (Node + Claude SDK), 5 sessions ≈ 450-750MB
- **"View Logs" in tray menu** — the 100-line in-memory log buffer exists but isn't exposed
- **Offline mode**: local-only sessions work fine, tunnel features degrade gracefully
- **10 quality-of-life features** prioritized by daily-driver impact

### From Historian (Precedent Validation)

- **VS Code lesson**: The provider registry and EventNormalizer mirror VS Code's extension host and event bus. This is the right pattern for expandability.
- **Cursor lesson**: Ship the product before the platform. Defer plugin system to Phase 4+.
- **Warp lesson**: Chroxy correctly avoids Warp's three mistakes: augments terminal (doesn't replace), no account required, cross-platform via Tauri.
- **React migration**: Recommends parallel build (new React app alongside old dashboard) over incremental strangler fig. The WebSocket protocol is the clean API boundary.
- **Top risk**: Migration stall — React rewrite gets 70% done and Phase 2 starts on shaky foundation. Mitigation: Phase 1 is done only when `dashboard-app.js` is deleted.

---

## Revised Phase Plan (Incorporating Panel Findings)

### Phase 0: Foundation (Week 1) — 3 days

Same as vision doc, plus:
- [ ] Set up Vitest for `packages/server/` (Tester: 2-3 days, but can parallel with security fixes)
- [ ] Write regression tests for Phase 0 fixes before moving on
- [ ] Run `doctor`-equivalent checks from Tauri before server start (Operator)

### Phase 1: React Migration (Weeks 2-4) — 3 weeks

Same as vision doc, plus:
- [ ] **Dual-target Vite build**: output to both Tauri `frontendDist` and server `/dashboard` route
- [ ] **Two-URL migration**: `/dashboard` (legacy) + `/dashboard-next` (React) side by side
- [ ] **Environment detection**: `window.__TAURI__` check for native vs web mode
- [ ] **Zustand store**: fork from mobile `connection.ts`, adapt for web APIs
- [ ] **xterm.js**: direct DOM integration, not WebView wrapper
- [ ] **Phase 1 is DONE when `dashboard-app.js` is deleted** (Historian gate)
- [ ] Add 1-2 days for Tauri build pipeline integration

### Phase 2: Sidebar + Tabs (Weeks 5-7) — 3 weeks

Same as vision doc, plus:
- [ ] **Server: `subscribe_sessions`** message type (Builder: 2 days)
- [ ] **Server: `list_repos` / `add_repo` / `remove_repo`** (Builder: 1.5 days)
- [ ] **Server: `session_activity`** lightweight updates for sidebar (Futurist)
- [ ] **Tauri: `#[tauri::command]` functions** for server control (start/stop/status) and file dialogs
- [ ] **Tauri: `tauri-plugin-dialog`** for "Add Repo" native directory picker
- [ ] **Tauri: `tauri-plugin-clipboard-manager`** for copy tunnel URL
- [ ] **Single-window architecture**: remove fallback/dashboard window split
- [ ] **UX: command palette (Cmd+Shift+P)** — UX Architect's top recommendation
- [ ] **UX: sidebar spec** — use the 842-line UX Architect report as implementation reference
- [ ] **Guardian: lazy xterm.js init** — only create Terminal instance when tab is first focused
- [ ] **Guardian: server auto-restart on crash** — don't wait for manual click

### Phase 3: Polish (Weeks 8-10) — 2 weeks

Same as vision doc, plus:
- [ ] **Tauri: `tauri-plugin-updater`** — auto-update mechanism (Operator, Tauri Expert)
- [ ] **Tauri: `tauri-plugin-global-shortcut`** — system-wide shortcuts
- [ ] **First-run wizard** in the main window (Operator)
- [ ] **View Logs** accessible from tray menu or status bar (Operator)
- [ ] **Performance monitoring**: memory per session, warning when approaching limits
- [ ] **Harden CSP**: remove `unsafe-inline`, add proper nonce/hash for React
- [ ] **Split pane**: stretch goal, defer to Phase 3b if needed (Historian)

### Phase 4: Expandability (Months 3-6)

Futurist's estimates, with panel layout registry from Phase 1-3:
- File Browser Panel: 5-8 days
- Diff Viewer Panel: 8-12 days
- Checkpoint Timeline: 5-7 days
- Agent Monitoring Dashboard: 8-12 days
- Multi-Machine Support: 10-15 days
- Integrated Code Review: 12-18 days

---

## Architecture Decisions Locked In (v4)

These decisions have consensus across 10 agents:

1. **Single window, React handles all states.** Loading, IDE, error, first-run wizard — all rendered by React in one WebView. No fallback/dashboard window split.

2. **Hybrid serving model.** React app ships in Tauri `frontendDist` (enables IPC) AND is served by Node at `/dashboard` (enables browser/mobile access). Same codebase, two deploy targets.

3. **WebSocket for data, Tauri IPC for native features.** All session/message/protocol communication over WebSocket (shared with mobile). Tauri `invoke()` only for: file dialogs, clipboard, notifications, global shortcuts, updater, server process control.

4. **`subscribe_sessions` is the multi-tab enabler.** Client declares which sessions it wants events for. Server filters broadcasts accordingly. This fixes both the reliability problem (broadcast storm) and security problem (cross-session data leakage).

5. **Panel layout system with registry.** Build the layout as a registry of panels from day one. Sidebar, terminal, welcome — each is a registered panel. This enables Phase 4 panels (file browser, diff viewer, agent monitor) to slot in without layout refactoring.

6. **Phase 1 gate: `dashboard-app.js` deleted.** The React migration is not done until the vanilla JS dashboard is removed. No two-dashboard long-term state.

7. **TypeScript + Zustand + CSS Modules.** Technology choices for the React app.

8. **Server tests are a Phase 0 prerequisite.** Vitest for `packages/server/` before any feature work.

---

## Risk Register

| Risk | Severity | Mitigation | Source |
|------|----------|------------|--------|
| Claude Code gets a built-in GUI | HIGH | Chroxy is multi-agent, multi-repo, multi-device — different product category | Futurist |
| React migration stalls at 70% | HIGH | Phase 1 gate: old dashboard deleted. Parallel build avoids breaking existing. | Historian |
| Single developer bandwidth | HIGH | Strict phase gating. Each phase is usable standalone. | Futurist |
| Multi-tab broadcast storm | MEDIUM | `subscribe_sessions` filtering before Phase 2 | Guardian |
| xterm.js memory per tab | MEDIUM | Lazy init, active-tab-only rendering, cap at 10 tabs | Guardian, UX Architect |
| Agent SDK breaking changes | MEDIUM | Provider abstraction already isolates SDK coupling | Futurist |
| Cross-platform compilation | MEDIUM | Conditional compilation for Windows/Linux early | Tauri Expert |
| Scope creep into editor territory | MEDIUM | Stay in lane: agent orchestration, not code editing | Futurist |

---

## What This Audit Achieved

The v4 swarm was framed differently from v1-v3. Instead of "rate the audit document," agents were asked "make the implementation plan better." Results:

| Agent | Primary Contribution |
|-------|---------------------|
| Skeptic | Verified every claim against code, found 30-50% underestimate in Phase 1 |
| Builder | 32-step build order with day-by-day sequencing and component architecture |
| Guardian | 15 failure modes with mitigations — implementation checklist |
| UX Architect | 842 lines of interaction specs — the UX reference for implementation |
| Tester | Per-phase test plan, identified zero server tests as critical gap |
| Tauri Expert | Resolved the serving architecture conflict, mapped 10 plugins across phases |
| Futurist | Competitive positioning, Phase 4 estimates, plugin system design |
| Adversary | Security gates per phase, session isolation architecture |
| Operator | First-run wizard, daily driver quality features, performance budget |
| Historian | Precedent validation, React migration playbook, risk identification |

The vision document (`desktop-vision.md`) should now be updated to incorporate these findings. The 10 individual reports serve as detailed implementation references for each phase.

---

*This is the final audit round. The vision is validated. The plan is enhanced. Time to build.*
