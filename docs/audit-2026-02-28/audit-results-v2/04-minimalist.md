# Minimalist's Audit: Desktop Architecture Audit

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code
**Overall Rating**: 2.0 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

| Section | Rating | Key Issue |
|---------|--------|-----------|
| Message Synchronization | 2/5 | Every recommendation solves a non-problem; IPC saves 0.1ms nobody perceives |
| Repository & Session Mgmt | 3/5 | Session templates for a 2-field form is absurd |
| Tunnel Implementation | 3/5 | Best recommendations; "tunnel provider UI" for 1 provider is a dropdown with 1 item |
| WebSocket Layer | 1/5 | Peak astronaut architecture: binary serialization for 62-byte messages |
| Data Flow Diagram | 4/5 | Accurate and useful -- earns its existence |
| Proposed Protocol | 1/5 | Protocol v2 with backward compat for 3 client codebases in one monorepo |

## Recommendation Verdicts (21 total)

| Verdict | Count |
|---------|-------|
| **KEEP** | 4 |
| **CUT** | 13 |
| **DEFER** | 4 |

### Items to KEEP
1. Configurable session limit (one-line change)
2. Surface tunnel status in desktop UI (wire existing events)
3. Carry forward encryption pattern (don't break things)
4. Tunnel auto-recovery with longer persistence (trivial constant change)

### Items to CUT (with evidence)
- **IPC channel**: Localhost WS latency <0.1ms. Encryption bypassed. Two comm paths = double maintenance.
- **Differential sync**: 500 msgs * ~500 bytes = 250KB replays in <100ms over localhost.
- **Binary serialization**: `{type:'stream_delta',messageId:'abc',delta:'hello'}` = 62 bytes. MessagePack: ~55 bytes. Savings: 7 bytes/delta.
- **Message priority**: 1-2 clients over localhost. Zero contention. WebSocket is ordered.
- **Schema caching**: Zod schemas compile once at module load (`ws-schemas.js:1-483`). No re-parsing per message.
- **Shared encryption**: N=1 remote client typically. Saves 0 operations.
- **Protocol v2**: 3 codebases, 1 developer, 1 monorepo. No external consumers.
- **Session templates**: `CreateSessionSchema` accepts 2 fields (name, cwd). Templates for 2 fields is overhead.
- **Filesystem repo discovery**: conversation-scanner.js already returns cwd for all Claude-used repos.
- **Desktop owns lifecycle**: Creates hierarchy that doesn't exist. Both clients work fine as peers.
- **Shared-memory terminal**: Tauri WebView has no shared memory with JS frontend.
- **Multi-session subscription**: `_broadcastToSession` already sends to ALL clients. The "feature" already exists.
- **Message ACK**: Permission responses already retried via offline queue (TTL 300s).

## Verdict
Well-researched analysis in service of bad recommendations. Of 21 recommendations, 13 should be cut entirely. The existing system -- Tauri tray app + Node server + WebSocket dashboard -- is already the right level of complexity. The audit proposes tripling the code surface for no measurable user benefit. Keep the diagrams, ship the 4 easy wins, and delete this document.
