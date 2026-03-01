# Builder's Audit: Desktop Architecture Audit

**Agent**: Builder -- Pragmatic full-stack dev who will implement this on Monday morning
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

### Section 1: Message Synchronization -- Rating: 4/5

Thorough and accurate. Every claim verified against the codebase. Missing: the `_send` method also queues messages during key exchange via `client.postAuthQueue` (ws-server.js:1193-1196) -- any replacement IPC channel needs to handle this race. The "shared-memory terminal state" recommendation is aspirational -- Tauri's WebView doesn't support shared memory with the frontend.

### Section 2: Repository and Session Management -- Rating: 3/5

Accurate on what exists but underestimates implementation effort. The document says session limit is "hardcoded" -- it's actually configurable at construction time (session-manager.js:75), just not exposed to the user. Missing: `CliSession` has fundamentally different capabilities (no resume, no model switching), which is a UI complexity multiplier.

### Section 3: Tunnel Implementation -- Rating: 4/5

Solid coverage. Missing: surfacing tunnel status requires adding tunnel state to the health endpoint or a new endpoint -- neither is mentioned as effort.

### Section 4: WebSocket / Real-Time Communication -- Rating: 4/5

Excellent protocol catalog. Missing: skipping validation for localhost has security implications the document doesn't address -- dashboard JS is served by the Node server, not bundled into Tauri.

### Section 5: Data Flow Diagram -- Rating: 5/5

Strongest section. Accurate, detailed, ready to hand to a developer as reference.

### Proposed Protocol -- Rating: 2/5

Dangerously underspecified for implementation. The IPC channel, differential sync, and multi-session subscription proposals all need significant additional design work.

---

## Top 5 Findings

### Finding 1: The IPC Channel Proposal Is Not Viable As Described

The codebase has ZERO `#[tauri::command]` handlers. The Node server has no stdin/stdout protocol -- stdout is consumed by log-capture threads (server.rs:150-177). The Tauri command bridge infrastructure must be built from scratch. Building this is a 2-3 week project, not an optimization.

**Recommendation:** For v1, keep WebView pointing at `http://localhost:{port}/dashboard`. Replace vanilla JS dashboard with React served by the same Node HTTP server. Add Tauri commands only for desktop-specific features. Effort: 1-2 days for scaffolding vs 2-3 weeks for full IPC.

### Finding 2: The Vanilla JS Dashboard Cannot Be Incrementally Migrated

`dashboard-app.js` is 1,793 lines in a single IIFE with 30+ mutable module-level globals, direct DOM manipulation on 40+ elements, and inline event handling. No component boundaries, no state management, no rendering abstraction. The syntax highlighter is a custom 200+ line tokenizer embedded in the same file.

**Recommendation:** Full rewrite. Budget 2-3 weeks for React dashboard matching current functionality. The WebSocket protocol is cleanly defined, so React app just implements a WS client against the same protocol. Server doesn't change.

### Finding 3: Repository Discovery Is More Complex Than Described

Scanning `~/Projects`, `~/Developer`, `~/Code` recursively hits `node_modules`, `.git/objects`, `venv`, and other deep trees. On a developer machine with 50+ repos, naive recursion takes 5-10 seconds. You need exclusion patterns, depth limits, caching, and progressive UI.

**Recommendation:** Phase 1 (1 day): Enhance conversation scanner to return unique `cwd` paths. Phase 2 (3-5 days): Add opt-in directory scanning with configurable roots and exclusion patterns.

### Finding 4: Missing Build Pipeline Decision

The document never addresses how the React app will be bundled and served. Three options:
- **Option A:** Bundle into Tauri frontend -- requires IPC that doesn't exist
- **Option B:** Serve from Node HTTP server (replace current dashboard) -- simplest, compatible with existing architecture
- **Option C:** Both

**Recommendation:** Go with Option B. Use Vite, output to `packages/server/src/dashboard/dist/`, serve via same HTTP server. Setup effort: 0.5-1 day.

### Finding 5: The Document Underestimates Existing Code While Overcomplicating New Features

The existing 1,197 lines of Rust across 6 files is solid and well-architected. The proposed protocol section would roughly triple codebase complexity while delivering improvements no user would notice.

**Recommendation:** Budget 80% on React UI rewrite, 20% on Tauri enhancements (tunnel status, window management, notifications). Skip IPC channel entirely for v1.

---

## Builder's Effort Estimates

| Feature | Effort | ROI |
|---------|--------|-----|
| React dashboard (full rewrite) | 2-3 weeks | High |
| Vite build pipeline setup | 0.5-1 day | High |
| Tray menu tunnel status | 1-2 days | Medium |
| Conversation scanner repo list | 1 day | Medium |
| Filesystem repo scanning | 3-5 days | Low |
| Tauri command bridge scaffold | 1-2 days | Low |
| Full IPC channel (stdin/stdout) | 2-3 weeks | Very Low |
| Differential sync protocol | 3-5 days | Low |
| Multi-session subscription | 1-2 weeks | Low |

---

## Verdict

An excellent reference document for understanding the existing codebase -- Sections 1-5 are accurate enough to onboard a new developer. However, it falls short as an implementation guide. The proposed protocol section overengineers solutions to problems that don't exist yet while underspecifying the solutions it does propose. If I started coding Monday, I'd use Sections 1-5 as reference, ignore Section 6's IPC proposal entirely, and build a React dashboard served by the existing Node HTTP server over WebSocket. The Tauri shell stays thin. That's a 3-4 week project. The Section 6 additions would add 4-6 weeks with questionable ROI.
