# Minimalist's Audit: Desktop Architecture Audit

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code
**Overall Rating**: 2.0 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

### Section 1: Message Synchronization -- Rating: 2/5

Every "Recommendation" is a solution looking for a problem. The localhost WebSocket "overhead" is one `JSON.stringify` call and one WebSocket frame -- microseconds. The IPC recommendation proposes four layers of indirection (React -> Tauri Command Bridge -> Rust -> Node stdin/stdout) to avoid one WebSocket hop. This would double the Rust surface area for a 0.1ms saving no human will perceive.

### Section 2: Repository and Session Management -- Rating: 3/5

Reasonable documentation. YAGNI violations: filesystem repo discovery (for repos never used with Chroxy), session templates (CRUD system to avoid picking two fields), desktop "owning" session lifecycle (introduces primary/secondary hierarchy the architecture doesn't need), configurable session limit (already configurable via constructor, session-manager.js:75).

### Section 3: Tunnel Implementation -- Rating: 4/5

Best section. Most recommendations are small, actionable, proportional: wire tunnel events to tray, show LAN URL, restart button. One YAGNI violation: "tunnel provider selection UI" for providers that don't exist.

### Section 4: WebSocket / Real-Time Communication -- Rating: 1/5

Astronaut architecture. Every recommendation is premature optimization for a system serving 1-3 clients.

- **Binary serialization:** `stream_delta` is ~90 bytes. `JSON.stringify` takes ~1 microsecond. Proposed to save 0.002% of the 50ms flush interval.
- **Message prioritization:** 1-2 clients, no contention, nothing to prioritize. Priority field would be written, transmitted, and ignored.
- **Schema validator caching:** Zod compiles once at import. Validation cost is microseconds per message. Skipping it for localhost removes a safety net for zero gain.
- **Shared encryption for broadcast:** N is typically 1-2. Localhost already skips encryption. Saves nothing.

### Section 5: Data Flow Diagram -- Rating: 4/5

Actually useful reference material. Accurate, earns its length.

### Proposed Protocol -- Rating: 1/5

Protocol v2 with backward compatibility creates version negotiation, feature flags, conditional code paths, and doubled test surface. You control all clients from one monorepo -- ship them together. One protocol version.

`subscribe_sessions` requires subscription tracking, per-client session filters, and client-side message routing. The current `switch_session` works. For split-pane, open two WebSocket connections.

`sync_request`/`sync_response`/`ack` -- three new message types to avoid replaying 500 JSON messages (~100KB) over localhost in <10ms.

---

## Top 5 Findings

### 1. The IPC Channel Is Pure Complexity for Zero User Benefit

**Effort:** ~500-800 lines of new Rust code + Node IPC server + fallback logic + testing two communication paths.
**Benefit:** Saves ~0.1ms per message on localhost WebSocket that no human will perceive.
**Recommendation:** Delete. `ws://localhost` with encryption bypass (ws-server.js:717-722) is the right architecture.

### 2. Differential Sync Solves a Non-Problem

**Effort:** New message types, per-client sequence tracking with persistence, gap detection, partial replay alongside full-replay.
**Benefit:** Avoids replaying ~100KB over localhost. Time saved: <10ms.
**Evidence:** Desktop connects to its own child process (server.rs:146). Only disconnection is server restart, which requires full replay anyway.
**Recommendation:** Delete.

### 3. Binary Serialization Is Premature Optimization

**Effort:** MessagePack/CBOR dependency, binary framing, format negotiation, dual serialization paths.
**Benefit:** Saves ~1 microsecond per JSON.stringify on 90-byte messages batched at 50ms.
**Recommendation:** Delete. JSON is debuggable, universal, and fast enough.

### 4. Protocol Version 2 Creates Unnecessary Maintenance Burden

**Effort:** Version negotiation, feature flags, conditional code paths, doubled test surface.
**Benefit:** Different protocol dialects for clients in the same monorepo.
**Recommendation:** Delete. Update all clients together. One version.

### 5. Session Templates and Repo Discovery Are Features Nobody Asked For

**Effort:** Template CRUD, filesystem scanning (permission issues, performance, false positives).
**Benefit:** Saves typing a directory path and picking a model -- a 5-second interaction.
**Recommendation:** Defer indefinitely.

---

## What to Keep

From the entire audit document, these recommendations are worth implementing:

1. **Surface tunnel status in desktop tray** -- Wire existing events to OS notifications. ~20 lines of Rust.
2. **Show LAN URL alongside tunnel URL** -- Server already has the info. ~10 lines of dashboard JS.
3. **Add "Restart Tunnel" to tray menu** -- Simple, useful, ~30 lines of Rust.

Everything else should be deleted or filed under "maybe someday, probably never."

---

## Verdict

The audit document is thorough in describing the existing architecture -- the data flow diagrams and message catalogs are genuinely useful reference material. But it catastrophically fails as a guide for what to build next. It identifies "bottlenecks" that are not bottlenecks (JSON serialization at microsecond scale, WebSocket framing over localhost), proposes solutions orders of magnitude more complex than the problems they solve (IPC channel, differential sync, protocol versioning), and recommends features for use cases that don't exist (multi-session subscription, session templates). The existing desktop app is 1,197 lines of Rust and works. The proposed enhancements would roughly triple codebase complexity while delivering improvements no user would notice. Keep the diagrams, burn the recommendations, and ship the three small tray improvements that actually matter.
