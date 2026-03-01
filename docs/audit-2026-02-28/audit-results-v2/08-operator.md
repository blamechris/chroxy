# Operator's Audit: Desktop Architecture Audit

**Agent**: Operator -- Daily user who cares about workflows, not architecture
**Overall Rating**: 2.5 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

| Section | Rating | Key Issue |
|---------|--------|-----------|
| Message Synchronization | 2/5 | Discusses delta timers but never mentions user-observable latency |
| Repository & Session Mgmt | 3/5 | Session discoverability at-a-glance not addressed |
| Tunnel Implementation | 2/5 | XSalsa20-Poly1305 deep-dive irrelevant to users; startup latency ignored |
| WebSocket Layer | 2/5 | Protocol catalog for engineers, not users |
| Data Flow Diagram | 3/5 | Useful but missing error flow diagrams |
| Proposed Protocol | 2/5 | Message priority could help permissions, but framed as generic framework |

## Top 5 Findings

### 1. Startup Takes 10-60 Seconds -- Never Mentioned
Server spawn (~5s) + health poll (2s intervals, 30s timeout) + tunnel (10-30s for Quick mode). Loading page shows 3-stage progress but user stares at spinner for potentially a full minute. The audit proposes binary serialization but never mentions startup time.

### 2. Permission Approval is the Most Critical UX Flow -- Barely Mentioned
5-minute timeout. Push notification body is just "Claude wants to use: {tool}" -- no context. Dashboard notification only fires when tab is unfocused. If window is hidden (close hides, per `window.rs:57`), no notification at all. The audit mentions `permission_request` exactly once, in a protocol table.

### 3. Session Switching: Dashboard Wipes, Mobile Caches
Dashboard (`dashboard-app.js:1364`): `messagesEl.innerHTML = ""` -- hard wipe, visible flash. Mobile (`connection.ts:996-1008`): loads from cache instantly, syncs in background. Desktop UX is worse than mobile UX.

### 4. Error States Are Well-Handled in Code but Invisible in Audit
- Tunnel failure: broadcasts error with human-readable message, fallback shows "Install cloudflared" advice
- Server crash: Rust detects via health poll, sends OS notification
- Auth failure: dashboard shows re-auth input; mobile shows "Forget Server" option
- cloudflared missing: notification with install instructions

The audit should highlight these as strengths instead of discussing JSON serialization overhead.

### 5. No Auto-Restart on Crash
Desktop uses `--no-supervisor` (`server.rs:141`). Server crash requires manual "Restart Server" click. The supervisor does auto-restart, but the desktop app bypasses it.

## What the Desktop App Should Actually Prioritize

1. **Faster startup** -- pre-warm tunnel, keep Node server alive between restarts
2. **Permission notification reliability** -- OS notifications even when window hidden
3. **Session switching without flash** -- port mobile's optimistic cache-first approach
4. **Auto-restart on crash** -- match supervisor's auto-restart with backoff
5. **Tunnel status visibility** -- surface state in tray menu tooltip

## Verdict
Technically thorough, experientially blind. Written by an architect for architects. The codebase is more user-aware than the audit -- loading page progress, reconnection banners, countdown timers, OS notifications are all present in code but absent from analysis. The audit proposes MessagePack and shared-memory terminal buffers while ignoring that startup takes a minute.
