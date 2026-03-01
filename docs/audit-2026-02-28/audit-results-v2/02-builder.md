# Builder's Audit: Desktop Architecture Audit

**Agent**: Builder -- Pragmatic full-stack dev who will implement this Monday morning
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

| Section | Rating | Key Issue |
|---------|--------|-----------|
| Message Synchronization | 4/5 | Accurate; IPC proposal needs 15-20 dev-days of infrastructure not acknowledged |
| Repository & Session Mgmt | 4/5 | Accurate; filesystem repo discovery is 5-7 days not trivial |
| Tunnel Implementation | 5/5 | Strongest section; recommendations are practical and scoped |
| WebSocket Layer | 3/5 | Protocol catalog is thorough; binary serialization and shared encryption are premature |
| Data Flow Diagram | 5/5 | Excellent reference documentation |
| Proposed Protocol | 2/5 | IPC channel not buildable as described; zero Tauri command infrastructure exists |

## Top 5 Findings

### 1. The IPC Channel Does Not Exist and Costs 15-20 Dev-Days
Zero `#[tauri::command]` handlers in the Rust codebase. Node stdout consumed by log capture. No stdin protocol. The IPC channel diagram requires building every arrow from scratch. The simpler path: React dashboard over `ws://localhost` (0 IPC work).

### 2. Dashboard Rewrite Is 12-18 Dev-Days, Not Incremental
`dashboard-app.js` (1,793 lines): single IIFE, 35+ global vars, direct DOM manipulation, hand-rolled markdown renderer (361-428) and syntax highlighter (100-313, 16 languages). No component boundaries. Full rewrite required.

### 3. Build Pipeline Gap Is Real
`packages/desktop/package.json` has only `cargo tauri dev/build`. No Vite, React, TypeScript. `dist/index.html` is a hand-written fallback page. Adding React requires Vite setup (1-2 days) before any frontend work.

### 4. Protocol Enhancements Are Premature
Binary serialization, shared encryption, shared-memory terminal -- all solve problems that don't exist for 1-3 clients over localhost.

### 5. Filesystem Repo Discovery Needs Exclusion Strategy
Naive scan of `~/Projects` will traverse `node_modules` directories and take minutes. Need exclusion patterns, depth limits, caching, progressive UI. 5-7 dev-days.

## Effort Estimates

| Feature | Effort | ROI |
|---------|--------|-----|
| React dashboard (full rewrite) | 12-18 days | High |
| Vite build pipeline | 1-2 days | High (prerequisite) |
| Tunnel status in tray/UI | 2-3 days | High |
| Tauri command bridge scaffold | 1 week | Medium (prerequisite) |
| Full IPC channel | 15-20 days | Low |
| Differential sync protocol | 10-15 days | Low |
| Filesystem repo discovery | 5-7 days | Low |

## Verdict
Excellent inventory of the codebase. The message flow, protocol catalog, and diagrams would save any developer days of spelunking. Over-indexes on theoretical protocol optimizations for a product with 1-3 clients. The highest-value path: Vite + React dashboard served by Node HTTP server over WebSocket, Tauri stays thin.
