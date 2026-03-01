# Master Assessment: Desktop Architecture Audit (v3)

**Panel Size**: 10 agents (4 core + 6 extended)
**Date**: 2026-02-28
**Subject**: `docs/audit-2026-02-28/desktop-architecture-audit.md`
**Pass**: v3 (re-review of original audit + v2 master assessment)

---

## Panel Composition

| # | Agent | v2 Rating | v3 Rating | Change |
|---|-------|-----------|-----------|--------|
| 1 | Skeptic | 3.0 | 3.0 | -- |
| 2 | Builder | 3.5 | 3.5 | -- |
| 3 | Guardian | 3.1 | 3.3 | +0.2 |
| 4 | Minimalist | 2.0 | 2.5 | +0.5 |
| 5 | Tester | 3.0 | 3.0 | -- |
| 6 | Adversary | 2.0 | 2.0 | -- |
| 7 | Historian | 3.5 | 3.5 | -- |
| 8 | Operator | 2.5 | 2.5 | -- |
| 9 | Futurist | 3.5 | 3.5 | -- |
| 10 | Tauri Expert | 3.5 | 3.5 | -- |

**Weighted Aggregate**: Core (1.0x) + Extended (0.8x) = **3.03 / 5** (up from 2.95 in v2)

---

## What Changed Between v2 and v3

### Ratings
- **Guardian** up 0.2: deeper investigation showed the architecture is more resilient than individual findings suggest. Atomic rename works, key exchange handles tunnel crashes, graceful shutdown path is sound.
- **Minimalist** up 0.5: v2 master correctly deferred the worst proposals. Desktop app already works.
- All other agents unchanged. No v2 findings were remediated in code between rounds.

### New Findings (v3 only)
| Finding | Agent | Severity |
|---------|-------|----------|
| No single-instance protection (dual launch race) | Guardian | CRITICAL |
| `_pendingStreams` not flushed on shutdown (partial responses lost) | Guardian | HIGH |
| Nonce desync on `ws.send()` failure (connection unrecoverable) | Guardian | MEDIUM |
| `.passthrough()` on 12 Zod schemas enables `sessionId` injection | Adversary | HIGH |
| `models_updated` bypasses EventNormalizer entirely | Skeptic | MEDIUM |
| Named tunnel command argument order wrong in audit | Skeptic | LOW |
| `tunnel-check.js` exists (v2 Skeptic correction overturned) | Skeptic | CORRECTION |
| `win.eval()` code injection surface (architecturally fragile) | Adversary | HIGH |
| Tauri CSP weaker than server CSP (`unsafe-inline`) | Adversary | MEDIUM |
| Permission response not scoped to active session | Adversary | LOW |

### Overturned v2 Findings
| v2 Claim | v3 Correction | Agent |
|----------|---------------|-------|
| `tunnel-check.js` does not exist | It does exist | Skeptic |

---

## Convergence: Where All 10 Agents Agree

After 3 rounds of review, the panel has converged on these consensus positions:

### 1. The Desktop App Already Works -- Invest Incrementally

The Minimalist's v3 position -- that the desktop needs 3-4 targeted fixes, not a greenfield build -- gained broad support. The Tauri Expert agrees: keep the Node-served dashboard, don't bundle in Tauri. The Operator partially agrees but wants 5-6 fixes instead of 4. The Builder confirms the existing 1,197 lines of Rust + 1,793-line dashboard is functional.

**Consensus**: Ship incremental improvements now. Defer the React rewrite until the next feature wave demands it (Futurist estimates 6-9 months).

### 2. Security Fixes Are Non-Negotiable and Unfixed

Three rounds, zero remediation. Every agent who examined security (Adversary, Guardian, Tester) confirmed:
- Token in HTML/URLs (CRITICAL) -- still present
- Config file world-readable (HIGH) -- still present
- `safeTokenCompare` untested (MEDIUM) -- still zero tests

**Consensus**: These must be fixed before any new features. Total effort: 3-5 hours.

### 3. The Protocol Enhancement Section Should Be Removed

| Section | v3 Avg Rating |
|---------|---------------|
| Proposed Protocol | **1.6/5** |

Lowest-rated section across all three rounds. Contains two technical impossibilities (JSON-free Tauri IPC, shared memory), proposes solutions to non-problems (binary serialization, message priority), and the one valid idea (differential sync) is better scoped to mobile-only.

**Consensus**: Remove from the architecture document. Replace with a short "Future Considerations" note linking to the Historian's Socket.IO v4 analysis for when mobile reconnection becomes painful.

### 4. The Data Flow Diagrams Are the Document's Core Value

| Section | v3 Avg Rating |
|---------|---------------|
| Data Flow | **4.1/5** |

Highest-rated section across all three rounds. Every agent praised the ASCII diagrams, message flow sequences, and component inventory as genuinely useful reference material.

**Consensus**: Keep and maintain as the primary architecture reference.

### 5. `_broadcastToSession` Must Be Fixed

All 10 agents, all 3 rounds. The function name promises session filtering but delivers global broadcast. The Builder clarifies it's a 4-8 hour fix with a design decision: 3 of 8 callers intentionally broadcast to all clients, so the method needs either always-filter behavior or a separate `_broadcastGlobal` method.

---

## Key Debates Resolved in v3

### Dashboard React Rewrite: When, Not If

| Position | Agents | v3 Verdict |
|----------|--------|------------|
| Never rewrite, ship vanilla JS | Minimalist | Viable for v0.2, creates debt |
| Rewrite now (8-12 days) | Builder | Correct effort, wrong timing |
| Rewrite within 6-9 months | Futurist, Historian | **Consensus position** |

**Resolution**: The session-switch flash (`dashboard-app.js:1364` innerHTML wipe) and streaming markdown performance are fixable in vanilla JS for now. When the next desktop feature wave arrives (multi-pane sessions, rich settings UI, integrated file browser), the 1,793-line IIFE becomes the bottleneck. Plan the rewrite then.

### Differential Sync: Mobile Only

| Position | Agents | v3 Verdict |
|----------|--------|------------|
| Defer forever | Minimalist | Wrong -- mobile reconnects are real pain |
| Build for all clients | Original audit | Over-scoped |
| Mobile reconnection only | Historian, Futurist | **Consensus position** |

**Resolution**: Desktop connects to its own child process over localhost -- the only disconnection is server restart, which requires full replay anyway. Mobile reconnects over cellular through Cloudflare relay frequently. The `seq` field is already on every message. Build it for mobile when reconnection complaints increase. Estimated effort: 2-3 days (Historian) to 1-2 weeks (Skeptic, who notes the fire-and-forget protocol needs careful adaptation).

### Per-Device Tokens: Months 3-6

| Position | Agents | v3 Verdict |
|----------|--------|------------|
| Defer forever | Minimalist | Wrong for a phone-based tool |
| Fix now | Adversary | Over-scoped for v0.2 |
| Months 3-6 | Futurist, Historian | **Consensus position** |

**Resolution**: Fix token-in-HTML immediately (critical security, 2-4 hours). The single shared token is adequate for a single-user personal tool, especially with E2E encryption. But device loss is a real scenario for a phone-based tool (Futurist), and per-device token derivation via HMAC is a 1-2 week project that should happen before v1.0.

### `win.eval()`: Migrate Opportunistically

| Position | Agents | v3 Verdict |
|----------|--------|------------|
| Replace now (1 day) | v2 master | Over-scoped |
| Keep forever | Minimalist | Acceptable short-term |
| Migrate when enabling `withGlobalTauri` | Tauri Expert | **Consensus position** |

**Resolution**: The single `eval()` call passes safe values to a controlled page. Not worth a standalone task. But when `withGlobalTauri` is enabled for the first native feature (likely permission notifications), migrate the eval to `app.emit()` as 30 minutes of incremental work.

---

## Final Priority Matrix (v3 Revised)

### Immediate (This Week) -- 3-5 hours total

| Action | Effort | Source |
|--------|--------|--------|
| Fix `config.json` permissions in `setup.rs` (0o600) | 15 min | Guardian, Adversary |
| Fix `settings.json` permissions in `settings.rs` (0o600) | 15 min | Guardian (v3 new) |
| Remove token from HTML/URL rendering | 2-4 hours | Adversary |
| Add `safeTokenCompare` tests (7 cases) | 20 min | Tester |
| Fix EventNormalizer completeness test (add 3 missing events) | 20 min | Tester |

### Short-term (Weeks 1-4)

| Action | Effort | Source |
|--------|--------|--------|
| Add `tauri-plugin-single-instance` | 1-2 hours | Guardian (v3), Tauri Expert |
| Tunnel URL in tray menu with copy-to-clipboard | 2-3 days | Minimalist, Operator |
| Fix `_broadcastToSession` to actually filter | 4-8 hours | Skeptic, all |
| Add orphan process detection (PID file) | 1-2 days | Guardian |
| Permission notification when window hidden (native OS) | 2-3 days | Operator |
| Flush `_pendingStreams` on shutdown | 2 hours | Guardian (v3 new) |
| Add re-entry guard to tunnel recovery | 30 min | Tester |
| Structured health endpoint (tunnel/session status) | 1 day | Historian (v3 new) |

### Medium-term (Months 1-3)

| Action | Effort | Source |
|--------|--------|--------|
| Instant dashboard when server already running | 0.5-1 day | Operator (v3 new) |
| Fix session-switch flash (vanilla JS) | 1 day | Operator, Minimalist |
| Persistence abstraction layer (prep for future SQLite) | 1-2 days | Futurist |
| Remove `.passthrough()` from security-sensitive schemas | 1-2 days | Adversary (v3 new) |
| Circuit breaker for tunnel recovery | 1-2 days | Historian (v3 new) |
| Close socket on nonce desync | 30 min | Guardian (v3 new) |

### Planned (Months 3-6)

| Action | Effort | Source |
|--------|--------|--------|
| Per-device token derivation | 1-2 weeks | Futurist, Historian |
| Differential sync (mobile only) | 2 days - 2 weeks | Historian, Skeptic |

### Planned (Months 6-9) -- Trigger: Next Feature Wave

| Action | Effort | Source |
|--------|--------|--------|
| Vite + React build pipeline | 2-3 days | Builder |
| Dashboard React rewrite | 8-12 days | Builder |
| Tauri command/event bridge (as needed) | 3-5 days | Builder, Tauri Expert |

### Deferred (Probably Never)

| Action | Rationale |
|--------|-----------|
| Binary serialization (MessagePack/CBOR) | 1μs savings on 90-byte messages |
| Message priority system | 1-2 clients, no contention |
| Protocol v2 with backward compatibility | Monorepo clients ship together |
| Shared-memory terminal buffers | Does not exist in Tauri |
| Session templates | Saves 5 seconds of typing |
| Filesystem repo discovery | 5-7 days for questionable value |

---

## Architecture Decisions Locked In

These decisions have consensus across 10 agents after 3 rounds and should be codified in the architecture docs:

1. **Dashboard stays Node-served.** The WebView loads `http://localhost:{port}/dashboard`. The dashboard and Node server are a versioned unit. Same dashboard serves web browsers, mobile, and desktop. (Tauri Expert, Minimalist, Builder)

2. **WebSocket stays the primary communication channel.** Even for the local desktop connection. Tauri IPC (`#[tauri::command]` + `app.emit()`) is used only for desktop-native capabilities: clipboard, file dialogs, window management, native notifications. (Tauri Expert, Minimalist, Historian)

3. **The Rust layer's job is process management and tray menu.** It is not a protocol bridge, message router, or application server. (Minimalist, Tauri Expert)

4. **E2E encryption is a genuine differentiator.** No competitor offers application-level E2E. Carry forward and maintain. (Historian, all)

5. **Provider registry and tunnel adapter registry are the crown jewels.** Both use the strategy pattern with capability introspection. Both support extension without modification. (Futurist, Historian)

6. **EventNormalizer's declarative EVENT_MAP pattern is correct.** Bidirectional normalization (CommandNormalizer) is a nice-to-have for the future, not a prerequisite. (Historian, Futurist)

---

## v2 → v3 Comparison

| Metric | v2 | v3 | Change |
|--------|-----|-----|--------|
| Aggregate rating | 2.95/5 | 3.03/5 | +0.08 |
| New findings | 47 | 10 | Converging |
| Overturned findings | 0 | 1 | `tunnel-check.js` exists |
| Effort estimate revisions | -- | 7 | Builder revised 7 items |
| Items moved to "Deferred" | -- | 0 | Minimalist proposed 4, panel split |
| Items added to priority matrix | -- | 6 | From v3 new findings |
| Architecture decisions locked | -- | 6 | Consensus positions |
| Critical path estimate | 5-7 weeks | 2-3 weeks | Builder revision, confirmed by Historian |

**What v3 added over v2**: Convergence. The v2 audit identified problems; the v3 audit resolved debates, locked in architecture decisions, revised effort estimates, and produced a priority matrix that all 10 agents broadly endorse. The remaining disagreements are about timing (months, not approach).

---

## Final Verdict

**The audit document should be rewritten as an architecture reference + implementation roadmap.**

Keep:
- Data flow diagrams (4.1/5)
- Message catalog and protocol reference
- Component inventory with file:line references
- Tunnel section analysis

Remove:
- Proposed Protocol Enhancements section (1.6/5)
- IPC channel proposal (technically impossible as described)
- Bottleneck analysis based on `_broadcastToSession` (premise is wrong)

Add:
- Security fixes (Immediate tier)
- Architecture decisions (6 locked-in positions above)
- Revised priority matrix with effort estimates
- Strengths section (E2E encryption, provider registry, tunnel adapters)

**Bottom line**: Three rounds of 10-agent review have converged. The codebase is sound. The audit document is a strong inventory but needs to become an actionable roadmap. The path forward is: fix security (this week), ship incremental desktop improvements (weeks 1-4), and plan the React rewrite for when the next feature wave demands it (months 6-9). Critical path: 2-3 weeks for meaningful desktop improvements, not 5-7 weeks.
