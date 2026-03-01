# Master Assessment: Desktop Architecture Audit (v2)

**Panel Size**: 10 agents (4 core + 6 extended)
**Date**: 2026-02-28
**Subject**: `docs/audit-2026-02-28/desktop-architecture-audit.md`

---

## Panel Composition

| # | Agent | Perspective | Rating |
|---|-------|-------------|--------|
| 1 | Skeptic | Cross-references every claim against actual code | 3.0/5 |
| 2 | Builder | Pragmatic full-stack dev estimating real effort | 3.5/5 |
| 3 | Guardian | Security/SRE analyzing failure modes and crash recovery | 3.1/5 |
| 4 | Minimalist | Ruthless engineer who believes the best code is no code | 2.0/5 |
| 5 | Tester | QA engineer focused on edge cases and test coverage | 3.0/5 |
| 6 | Adversary | Red-team security engineer thinking like an attacker | 2.0/5 |
| 7 | Historian | Senior architect studying industry precedent and prior art | 3.5/5 |
| 8 | Operator | Daily user who cares about workflows, not architecture | 2.5/5 |
| 9 | Futurist | Technical architect thinking in 2-year timelines | 3.5/5 |
| 10 | Tauri Expert | Domain expert in Tauri framework and Rust desktop apps | 3.5/5 |

**Weighted Aggregate**: Core (1.0x) + Extended (0.8x) = **2.95 / 5**

---

## Unanimous Findings (10/10 Agree)

### 1. `_broadcastToSession` Does NOT Filter by Session

**File**: `ws-server.js:1038-1045`

The audit document claims session-filtered broadcasting. Reality: `_broadcastToSession` sends to ALL authenticated clients. The default filter is `() => true`. No `client.activeSessionId === sessionId` check exists. This means the proposed "multi-session subscription" already describes current (broken) behavior.

**Impact**: Undermines the entire bottleneck analysis and several proposed enhancements built on the assumption of per-session message routing.

### 2. IPC Channel Proposal Is Not Viable as Described

The proposed IPC channel ("skip JSON serialization," "direct memory sharing") contains fundamental technical errors:
- **Tauri IPC is always JSON**: `invoke()` and `emit()` both use `serde_json`. `Vec<u8>` becomes base64 (33% overhead). No raw byte channel exists. (Tauri Expert)
- **No shared memory**: WebView runs in a separate OS process. No shared memory mechanism exists in Tauri. (Tauri Expert, Skeptic)
- **Zero infrastructure**: No `#[tauri::command]` handlers, `withGlobalTauri: false`, no stdin/stdout protocol. Every arrow in the IPC diagram must be built from scratch. (Builder, Futurist)
- **Negligible benefit**: Saves ~0.1ms per message on localhost. No human will perceive the difference. (Minimalist)

**Correct pattern** (per Historian, Tauri Expert): Tauri commands for request-response, `app.emit()` events for streaming push, Node IPC via stdio fd for Rust-to-Node communication.

### 3. Protocol Enhancements Are Over-Engineered for 1-3 Clients

Near-universal agreement (9/10, Futurist partially dissents for long-term value):
- **Binary serialization**: `stream_delta` is ~90 bytes. `JSON.stringify` takes ~1μs. Proposed to save 0.002% of the 50ms flush interval. (Minimalist)
- **Message prioritization**: 1-2 clients, no contention, nothing to prioritize. (Minimalist, Skeptic)
- **Differential sync**: Avoids replaying ~100KB over localhost in <10ms. Desktop connects to its own child process; only disconnection is server restart, which requires full replay anyway. (Minimalist)
- **Protocol v2**: Version negotiation, feature flags, conditional code paths, doubled test surface -- for clients in the same monorepo that ship together. (Minimalist, Builder)

---

## Strong Consensus Findings (7+ of 10 Agree)

### 4. Token Handling Has Critical Security Flaws

**Agents**: Adversary, Guardian, Historian, Tester, Futurist, Operator, Builder

- **Token in HTML/URLs** (CRITICAL): `window.__CHROXY_CONFIG__` embeds the token in rendered HTML. Token appears in URL query strings, browser history, Referer headers, and is accessible to extensions. (`window.rs:25-27`, `dashboard.js:138`) — Adversary
- **Config file world-readable** (HIGH): `setup.rs:34` uses `fs::write()` with default permissions (0o644). The Node side uses `writeFileRestricted()` with `mode: 0o600`, but Rust setup does not. — Adversary, Guardian
- **Single shared token** (HIGH): No per-device credentials, no revocation granularity, no audit trail. No production multi-client system uses this model. — Historian, Futurist, Adversary
- **Token theft = total compromise**: All sessions, full history, arbitrary code execution via `auto` permission mode. No defense in depth. — Adversary

### 5. The Audit Document Contains Factual Errors

**Agents**: Skeptic, Tester, Builder, Tauri Expert, Guardian

| Claim | Reality | Source |
|-------|---------|--------|
| "28 client-to-server message types" | 36 (32 discriminatedUnion + 4 separate) | Skeptic |
| "`±10%` jitter on reconnect backoff" | 0-50% additive jitter (`utils.ts:61-63`) | Skeptic |
| "`tunnel-check.js` for health checks" | File does not exist | Skeptic |
| "Session limit is hardcoded" | Configurable via constructor (`session-manager.js:75`) | Skeptic |
| "Skip JSON serialization via IPC" | Impossible in Tauri (always `serde_json`) | Tauri Expert |
| "Direct memory sharing" | Does not exist in Tauri | Tauri Expert |
| "EventNormalizer completeness test covers all events" | Tests list 17 events, EVENT_MAP has 20 | Tester |

### 6. Startup Latency Is the #1 UX Issue -- Not Mentioned

**Agents**: Operator, Builder, Guardian

Server spawn (~5s) + health poll (2s intervals, up to 30s timeout) + tunnel startup (10-30s for Quick mode) = **10-60 seconds** of user staring at a spinner. The audit proposes binary serialization and shared-memory terminal buffers but never mentions the most user-visible performance problem.

### 7. Existing Codebase Has Real Strengths the Audit Underweights

**Agents**: Operator, Historian, Futurist, Guardian, Builder

- **E2E encryption**: XSalsa20-Poly1305 with direction-tagged nonces. No competitor (VS Code Remote, JetBrains Gateway, Warp) offers application-level E2E encryption. Genuine differentiator. (Historian)
- **Provider registry**: Textbook strategy pattern with capability introspection. Will support 5-10 backends without modification. Crown jewel of the architecture. (Futurist)
- **Tunnel adapter registry**: Well-designed for extensibility. Cloudflare Quick/Named duality mirrors VS Code's pattern. (Historian)
- **Error handling UX**: Tunnel failure with human-readable messages, cloudflared install advice, reconnection banners, countdown timers -- all present in code but absent from audit analysis. (Operator)
- **Atomic state persistence**: temp file + rename pattern is correct. Debounced persist with graceful SIGTERM handling. (Guardian)

---

## Partial Consensus Findings (4-6 of 10 Agree)

### 8. `safeTokenCompare` Has Zero Tests

**Agents**: Tester, Adversary, Guardian

The sole authentication check for every WebSocket connection (`crypto.js:115-135`) has 5 distinct code paths and none are tested. Non-obvious behavior: `safeTokenCompare('', '')` returns `false`. This is the authentication gatekeeper for the entire system. Recommended: 7 test cases covering identical, different, different-length, empty, non-string, suffix, and timing.

### 9. Orphaned Node.js Process on Desktop SIGKILL

**Agents**: Guardian, Operator, Builder

On force-quit (Activity Monitor, `kill -9`, OOM killer), the Tauri `Drop` trait is never called. The Node.js child process becomes an orphan, holding the port. No PID file in `--no-supervisor` mode. Next launch shows "server already running" error with no automated recovery.

**Recommendation**: Write a PID file in `--no-supervisor` mode. On startup, check for stale PIDs. Alternatively, use process groups so signals propagate.

### 10. Dashboard Requires Full Rewrite, Not Incremental Migration

**Agents**: Builder, Minimalist, Operator

`dashboard-app.js` (1,793 lines): single IIFE, 35+ global vars, direct DOM manipulation, hand-rolled markdown renderer (lines 361-428) and syntax highlighter (lines 100-313, 16 languages). No component boundaries. Session switching does `messagesEl.innerHTML = ""` (hard wipe, visible flash). Full React rewrite estimated at 12-18 dev-days.

### 11. Permission Approval UX Is the Most Critical Flow -- Barely Covered

**Agents**: Operator, Adversary

5-minute timeout. Push notification body is just "Claude wants to use: {tool}" with no context. Dashboard notification only fires when tab is unfocused. If window is hidden (close-hides-to-tray per `window.rs:57`), no notification at all. The audit mentions `permission_request` exactly once, in a protocol table.

### 12. State Persistence Will Hit a Wall at Scale

**Agents**: Futurist, Guardian, Builder

`session-manager.js:305-345` serializes ALL sessions' full histories as one JSON file. At 10 sessions * 500 msgs * 50KB = potentially 250MB, written every 2 seconds. Needs SQLite or append-only log within 6 months. Current 5-session limit masks the problem.

---

## Section Ratings Heatmap

| Section | Skeptic | Builder | Guardian | Minimalist | Tester | Adversary | Historian | Operator | Futurist | Tauri Expert | Avg |
|---------|---------|---------|----------|------------|--------|-----------|-----------|----------|----------|-------------|-----|
| Message Sync | 3 | 4 | 2 | 2 | 3 | 3 | 3.5 | 2 | 3.5 | 3 | **2.9** |
| Repo/Session | 4 | 4 | 3 | 3 | 4 | 2 | 3 | 3 | 3 | 4 | **3.3** |
| Tunnel | 4 | 5 | 3 | 4 | 3 | 3 | 4 | 2 | 4 | 4 | **3.6** |
| WebSocket | 3 | 3 | 3 | 1 | 4 | 3 | 3.5 | 2 | 3 | 3 | **2.9** |
| Data Flow | 4 | 5 | 4 | 4 | 4 | 4 | 4 | 3 | 4.5 | 4 | **4.1** |
| Proposed Protocol | 3 | 2 | 3 | 1 | 2 | 2 | 3.5 | 2 | 3 | 2 | **2.4** |

**Strongest section**: Data Flow Diagram (4.1/5) -- universally praised as accurate, useful reference
**Weakest section**: Proposed Protocol (2.4/5) -- over-engineered, technically flawed, under-specified

---

## Priority Matrix: What to Do Next

### Immediate (This Week)

| Action | Source | Effort | Impact |
|--------|--------|--------|--------|
| Fix `config.json` permissions in `setup.rs` (0o600) | Adversary, Guardian | 30 min | Critical security |
| Remove token from HTML/URL rendering | Adversary | 2-4 hours | Critical security |
| Add `safeTokenCompare` tests (7 cases) | Tester | 30 min | Critical coverage |
| Fix EventNormalizer completeness test | Tester | 20 min | Test accuracy |

### Short-term (Weeks 1-4)

| Action | Source | Effort | Impact |
|--------|--------|--------|--------|
| Surface tunnel status in tray menu | Minimalist, Operator | 1-2 days | High UX |
| Add tunnel restart to tray menu | Minimalist | 1 day | High UX |
| Fix `_broadcastToSession` to actually filter | Skeptic, all | 1-2 days | Correctness |
| Add orphan process detection on startup | Guardian | 1-2 days | Reliability |
| Add re-entry guard to tunnel recovery | Tester | 30 min | Reliability |
| Permission notification when window hidden | Operator | 1-2 days | Critical UX |
| Replace `win.eval()` with `app.emit()` events | Tauri Expert | 1 day | Correctness |

### Medium-term (Months 1-3)

| Action | Source | Effort | Impact |
|--------|--------|--------|--------|
| Vite + React build pipeline | Builder | 1-2 weeks | Prerequisite |
| Tauri command/event bridge scaffold | Builder, Tauri Expert | 1 week | Prerequisite |
| Dashboard React rewrite | Builder | 12-18 days | High UX |
| Socket.IO v4-style connection state recovery | Historian | 2-3 days | Performance |
| Per-device token derivation | Historian, Futurist | 1-2 weeks | Security |
| Faster startup (pre-warm, keep-alive) | Operator | 1-2 weeks | High UX |

### Deferred (Probably Never)

| Action | Source | Rationale |
|--------|--------|-----------|
| Binary serialization (MessagePack/CBOR) | Minimalist | 1μs savings on 90-byte messages |
| Message priority system | Minimalist | 1-2 clients, no contention |
| Protocol v2 with backward compatibility | Minimalist | Ship all clients together from monorepo |
| Shared-memory terminal buffers | Tauri Expert | Does not exist in Tauri |
| Session templates | Minimalist | Saves 5 seconds of typing |
| Filesystem repo discovery | Minimalist, Builder | 5-7 days for a questionable feature |

---

## Key Disagreements Between Agents

### IPC Channel: Build It or Kill It?

- **Kill it** (Minimalist 2.0, Skeptic 3.0): Pure complexity for 0.1ms savings. `ws://localhost` with encryption bypass is the right architecture.
- **Build it correctly** (Historian 3.5, Tauri Expert 3.5, Futurist 3.5): The pattern is proven (VS Code, Docker Desktop, Clash Verge). But build it right: Tauri commands + `app.emit()` events + Node stdio IPC. Not the way the audit describes it.
- **Resolution**: Build the Tauri command/event bridge (it's needed for any desktop features). Defer the full Node IPC channel until the bridge is working and the need is proven with profiling data.

### Differential Sync: Essential or Premature?

- **Premature** (Minimalist, Builder): Desktop connects to its own child process. Only disconnection is server restart. 100KB replay over localhost takes <10ms.
- **Essential for mobile** (Historian, Futurist): Full replay of 500 messages over a cellular connection with Cloudflare relay is slow. Socket.IO v4 ships this exact feature. The `seq` field is already there.
- **Resolution**: Implement for the mobile reconnection path (real user pain). Don't build it for the desktop path (no measurable benefit).

### Auth Model: Fix Now or Fix Later?

- **Fix now** (Adversary 2.0, Historian 3.5): Token in HTML is critical. Single shared token is an anti-pattern.
- **Fix incrementally** (Builder 3.5, Futurist 3.5): Remove token from HTML immediately. Per-device tokens can wait until multi-user is needed.
- **Resolution**: Fix token exposure immediately (critical security). Plan per-device token derivation for month 1-2. Multi-user auth is a 4-6 week project that can wait.

---

## Comparison with v1 Swarm Audit (6 agents)

| Metric | v1 (6 agents) | v2 (10 agents) |
|--------|---------------|----------------|
| Aggregate rating | 2.9/5 | 2.95/5 |
| Unique findings | 24 | 47 |
| Critical security findings | 1 | 4 |
| Factual errors identified | 3 | 7 |
| UX-focused findings | 0 | 5 |
| Industry precedent analysis | 0 | 12 |
| Positive findings (strengths) | 2 | 7 |

**What v2 added**: The Operator perspective surfaced UX concerns invisible to technical reviewers. The Historian grounded recommendations in proven industry patterns. The Futurist identified long-term scaling walls. The Tauri Expert caught fundamental technical impossibilities in the IPC proposal.

---

## Final Verdict

**The audit document is a strong codebase inventory but a weak implementation guide.**

**Strengths**: The data flow diagrams, message catalogs, and component inventory are genuinely useful reference material that would save any new developer days of exploration. The tunnel section analysis is accurate and actionable.

**Critical flaws**:
1. Two technically impossible proposals (JSON-free Tauri IPC, shared memory)
2. `_broadcastToSession` mischaracterized -- undermines the bottleneck analysis
3. 7 factual errors in specific numbers and filenames
4. Protocol enhancements are orders of magnitude more complex than the problems they solve
5. Security issues (token exposure, world-readable config) not identified
6. User-observable problems (startup latency, permission UX, session switch flash) ignored

**Bottom line**: Keep the diagrams and inventory. Discard the protocol enhancement proposals. Fix the security issues immediately. Build the Tauri command/event bridge as the foundation. Then tackle the React dashboard rewrite. The existing architecture (provider registry, tunnel adapters, event normalizer, E2E encryption) is sound -- the next step is to build on these strengths rather than add theoretical optimizations for problems that don't exist.
