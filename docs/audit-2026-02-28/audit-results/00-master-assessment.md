# Master Assessment: Desktop Architecture Audit

**Target:** `docs/audit-2026-02-28/desktop-architecture-audit.md`
**Auditors:** 6 agents (4 core + 2 extended), all Opus 4.6 with extended thinking
**Date:** 2026-02-28
**Aggregate Rating:** 2.9 / 5

---

## a. Auditor Panel

| # | Agent | Perspective | Rating | Weight | Key Contribution |
|---|-------|------------|--------|--------|-----------------|
| 1 | Skeptic | Claims vs reality | 3.0/5 | 1.0x | Found `_broadcastToSession` doesn't filter by session; message counts wrong by 40% |
| 2 | Builder | Implementability | 3.5/5 | 1.0x | IPC channel not viable as described; dashboard is a full rewrite not incremental |
| 3 | Guardian | Safety & failure modes | 3.2/5 | 1.0x | 2-second persist crash window; checkpoint non-atomic; nonce precision limit |
| 4 | Minimalist | YAGNI & complexity | 2.0/5 | 1.0x | Most proposed enhancements are premature optimization for 1-3 client system |
| 5 | Tester | Testability & edge cases | 3.2/5 | 0.8x | `safeTokenCompare` has zero tests; differential sync conflates per-client/per-session seq |
| 6 | Adversary | Attack surface & security | 3.0/5 | 0.8x | API token exposed in HTML and world-readable config; no per-session authorization |

**Weighted Average:** (3.0 + 3.5 + 3.2 + 2.0 + 3.2*0.8 + 3.0*0.8) / (4 + 0.8 + 0.8) = **2.9 / 5**

---

## b. Consensus Findings (4+ agents agree)

### Consensus 1: `_broadcastToSession` Does Not Filter by Session (6/6 agree)

Every agent identified this as a factual error in the document and a real code issue.

**Evidence:**
- Skeptic: `ws-server.js:1038-1044` -- no `client.activeSessionId === sessionId` check
- Guardian: Information leak -- all clients receive all sessions' data
- Adversary: Cross-session data leakage by design
- Tester: No tests verify session filtering behavior

**Recommended Action:** Fix the broadcast to filter by `client.activeSessionId`. One-line change. Also correct the audit document.

---

### Consensus 2: The IPC Channel Proposal Is Over-Engineered and Not Viable (6/6 agree)

All agents identified the Tauri IPC proposal as impractical, unnecessary, or both.

**Evidence:**
- Builder: Zero `#[tauri::command]` handlers exist; Node has no stdin protocol; stdout consumed by log threads
- Minimalist: Four layers of indirection to save 0.1ms over localhost WebSocket
- Skeptic: Tauri WebView serializes to JSON anyway; no shared memory API
- Guardian: IPC channel has no security model
- Adversary: Bypassing encryption without authentication model creates attack surface
- Tester: No discussion of message ordering between IPC and WS channels

**Recommended Action:** Delete the IPC channel proposal. Keep `ws://localhost` with existing encryption bypass. For v2, consider Tauri events (not command bridge) if profiling shows actual latency issues.

---

### Consensus 3: The Proposed Protocol Section Is Over-Specified and Under-Analyzed (5/6 agree)

All agents except Builder rated the protocol section 1-2/5. Consensus: solutions searching for problems that don't exist, with critical edge cases unaddressed.

**Evidence:**
- Minimalist: Differential sync avoids replaying 100KB over localhost in <10ms; binary serialization saves 1us per message
- Tester: `sync_request` conflates per-client seq with per-session history (fundamental design flaw); seq resets on reconnect
- Skeptic: Message priority on FIFO TCP is meaningless; shared encryption undermines forward secrecy
- Guardian: Ring buffer eviction makes `lastSeq` unreliable; priority implementation needs per-client outbound queue
- Adversary: `sync_request` with arbitrary `lastSeq` enables information disclosure; `subscribe_sessions` has no access control

**Recommended Action:** Remove or heavily revise the entire "Proposed Protocol Enhancements" section. If differential sync is desired in the future, design per-session (not per-client) sequence numbers as a prerequisite.

---

### Consensus 4: The Document's Description of Existing Architecture (Sections 1-5) Is Valuable (5/6 agree)

All agents except Minimalist rated the descriptive sections (data flow diagrams, message catalogs, code references) as 3-4/5 or higher.

**Evidence:**
- Builder: "Excellent reference document for understanding the existing codebase"
- Tester: "Adequate as an architectural guide for a developer"
- Skeptic: "Data flow diagrams are clear, code references are mostly accurate"
- Guardian: "Accurately describes most of the system's message flow"

**Recommended Action:** Preserve Sections 1-5 as reference material. Correct factual errors (message counts, jitter values, broadcast behavior).

---

### Consensus 5: Security Token Handling Needs Immediate Attention (4/6 agree)

Guardian, Adversary, Tester, and Skeptic identified security issues with token lifecycle.

**Evidence:**
- Adversary: Token embedded in HTML (`dashboard.js:138`) and URL query strings (`window.rs:25-27`); visible in browser history, Referer headers, dev tools
- Adversary: `setup.rs:34` creates config with default permissions (world-readable)
- Guardian: Token rotation grace period allows old token reuse for 5 minutes
- Tester: `safeTokenCompare` (the authentication gatekeeper) has zero test coverage

**Recommended Action:** Before building the new desktop app: (1) Fix `setup.rs` file permissions, (2) Move token out of URL query strings, (3) Add `safeTokenCompare` tests. Consider session cookies for dashboard authentication.

---

## c. Contested Points

### Contest 1: Should the Vanilla JS Dashboard Be Rewritten in React?

**Builder says YES:** "1,793 lines in a single IIFE with 30+ mutable globals. No component boundaries. Full rewrite required. Budget 2-3 weeks."

**Minimalist says NO (implicitly):** The dashboard works. The audit's value is in describing what exists, not proposing rewrites. Ship the three small tray improvements.

**Assessment:** Builder is right that the current dashboard can't be incrementally migrated, but the rewrite should be driven by feature needs, not architectural aesthetics. If the desktop app needs features the current dashboard lacks, rewrite. If it just needs a Tauri wrapper, keep the vanilla JS.

### Contest 2: Is Differential Sync Worth Building?

**Skeptic/Guardian say MAYBE:** "Reasonable and would address a real gap" (Skeptic). "Sound approach" (Guardian).

**Minimalist/Tester say NO:** "Solves a non-problem. 100KB replay in <10ms over localhost" (Minimalist). "Conflates per-client and per-session sequences -- fundamental design flaw" (Tester).

**Assessment:** Tester is right that the current proposal is broken as designed. The per-client `seq` cannot be used for per-session differential sync. If this is ever built, it needs a clean redesign with per-session monotonic counters. For v1, full replay over localhost is fast enough.

### Contest 3: How Much Security Investment Is Needed?

**Adversary says A LOT:** Token in HTML is CRITICAL. No per-session auth is HIGH. mDNS is MEDIUM. Fix before building anything new.

**Minimalist/Builder say PROPORTIONAL:** This is a personal dev tool running on your own machine. Token-in-HTML is a real issue but the threat model is "someone with physical access to your machine," at which point you have bigger problems.

**Assessment:** The Adversary's findings are technically correct but should be triaged against the actual threat model. Fix the easy wins (file permissions, remove token from URL). Defer the harder items (per-session auth, CSP hardening) unless the product moves toward multi-user or enterprise scenarios. The `safeTokenCompare` zero-test finding should be fixed immediately regardless of threat model -- it's the authentication gatekeeper with no safety net.

---

## d. Factual Corrections

| # | Claim in Document | Correction | Found By |
|---|------------------|------------|----------|
| 1 | "_broadcastToSession sends to all authenticated clients viewing that session" | Sends to ALL authenticated clients; no session filtering | Skeptic, Guardian, Adversary |
| 2 | "28 client-to-server types, 55+ server-to-client types" | 35 client-to-server (31 Zod + 4 separate), 67+ server-to-client. Total >100 | Skeptic |
| 3 | "58+ message types" (executive summary) | >100 message types total | Skeptic |
| 4 | "delays: 1s, 2s, 3s, 5s, 8s with +/-10% jitter" | Jitter is 0% to +50% additive (utils.ts:61-63), not +/-10% | Skeptic, Guardian |
| 5 | E2E encryption "production-grade" | Nonce counter limited to 2^53 precision (not 2^64) due to JS number type | Guardian, Tester |
| 6 | "5-session limit is hardcoded" | Configurable via constructor parameter (session-manager.js:75) | Builder |
| 7 | "Pluggable adapter registry" (presented as mature pattern) | Single adapter, never tested with second provider, hardcoded shortcuts | Skeptic |

---

## e. Risk Heatmap

```
                        IMPACT
                Low      Medium     High      Critical
           ┌──────────┬──────────┬──────────┬──────────┐
  Likely   │          │ mDNS     │ broadcast│ token in │
           │          │ info     │ no-filter│ HTML/URL │
           │          │ leak     │          │          │
           ├──────────┼──────────┼──────────┼──────────┤
  Possible │ nonce    │ config   │ persist  │          │
           │ overflow │ file     │ crash    │          │
           │ (theor.) │ perms    │ window   │          │
           ├──────────┼──────────┼──────────┼──────────┤
  Unlikely │ tunnel   │checkpoint│ token    │          │
           │ recovery │ non-     │ rotation │          │
           │ re-entry │ atomic   │ race     │          │
           ├──────────┼──────────┼──────────┼──────────┤
  Rare     │ seq      │ orphaned │          │          │
           │ overflow │ child    │          │          │
           │          │ process  │          │          │
L'HOOD     └──────────┴──────────┴──────────┴──────────┘
```

---

## f. Recommended Action Plan

### Priority 1: Immediate Fixes (Before Desktop Development)

| # | Action | Effort | Agents | Rationale |
|---|--------|--------|--------|-----------|
| 1 | Fix `_broadcastToSession` to filter by `client.activeSessionId` | 1 line | All 6 | Universal consensus; real bug |
| 2 | Fix `setup.rs` config file permissions (0o600) | 5 lines | Adversary, Guardian | Security: token readable by any local user |
| 3 | Add `safeTokenCompare` tests (7 cases) | 30 min | Tester, Adversary | Zero tests on authentication gatekeeper |
| 4 | Fix EventNormalizer completeness test | 20 min | Tester | 3 of 20 event handlers untested |
| 5 | Add tunnel recovery re-entry guard | 30 min | Tester, Guardian | Race condition in `_handleUnexpectedExit` |

### Priority 2: Pre-Build Decisions

| # | Decision | Options | Recommended |
|---|----------|---------|-------------|
| 6 | React rewrite vs keep dashboard | Full rewrite (2-3 wk) vs enhance existing | Keep existing for v1; rewrite when features demand it |
| 7 | Build pipeline for React (if rewriting) | Tauri-embedded vs Node-served vs both | Node-served (Option B) -- simplest, compatible |
| 8 | Move token out of URL/HTML | Session cookies, JWT, or HttpOnly cookie | Session cookie with CSRF token |

### Priority 3: Desktop App v1 Scope

| # | Feature | Effort | Value |
|---|---------|--------|-------|
| 9 | Surface tunnel status in tray | 1-2 days | High |
| 10 | Show LAN URL in dashboard | ~10 lines | Medium |
| 11 | Add "Restart Tunnel" to tray | ~30 lines | Medium |
| 12 | Enhanced conversation scanner (unique CWDs) | 1 day | Medium |

### Priority 4: Defer or Delete

| # | Proposed Feature | Reason to Defer |
|---|-----------------|-----------------|
| 13 | IPC channel (Tauri -> Rust -> Node) | Not viable as designed; 0.1ms saving; 2-3 weeks effort |
| 14 | Differential sync | Design flaw (per-client vs per-session seq); <10ms problem |
| 15 | Binary serialization | Saves 1us per message; adds dependency and dual serialization |
| 16 | Message priority system | TCP is FIFO; no contention with 1-2 clients |
| 17 | Protocol version 2 / backward compat | Same monorepo, ship all clients together |
| 18 | Multi-session subscription | Use `switch_session` or open multiple WebSocket connections |
| 19 | Session templates | Saves picking 2 fields; CRUD overhead not justified |
| 20 | Filesystem repo discovery | Conversation scanner covers 90% of use case |

---

## g. Final Verdict

**Aggregate Rating: 2.9 / 5 -- Adequate with significant reservations**

The desktop architecture audit document is a competent reference guide for understanding the existing Chroxy codebase. The data flow diagrams (Section 5), message catalogs (Section 4), and architectural descriptions (Sections 1-3) are largely accurate and genuinely useful for onboarding developers. Six agents verified the core architecture is sound: the event-driven pipeline, session management, tunnel recovery, and E2E encryption are well-implemented.

However, the document has two systemic failures. First, **factual precision**: the broadcast mechanism is misdescribed, message counts are wrong by 40%, jitter values are fabricated, and the "pluggable" tunnel registry is oversold. An audit that describes what code *should* do rather than what it *actually* does is dangerous -- it creates false confidence in the details where bugs live.

Second, and more critically, **the proposed protocol enhancements (Section 6) received near-universal rejection** (average 1.7/5 across all agents). The IPC channel is not viable with current Tauri capabilities. Differential sync has a fundamental design flaw (per-client vs per-session sequences). Binary serialization and message priority are premature optimizations for a system serving 1-3 clients. Protocol versioning adds maintenance burden for clients shipped from the same monorepo. The consensus recommendation is to delete or heavily revise the entire proposals section.

**The path forward is clear:** Fix the five immediate issues (broadcast filter, file permissions, safeTokenCompare tests, EventNormalizer completeness, tunnel re-entry guard), add three small tray features (tunnel status, LAN URL, restart tunnel), and defer everything else until real user needs emerge. The existing architecture -- Tauri tray app + Node server + WebSocket dashboard -- is the right foundation. The mistake would be over-engineering it.

---

## h. Appendix: Individual Reports

| # | Report | Agent | Rating | File |
|---|--------|-------|--------|------|
| 1 | Skeptic's Audit | Skeptic | 3.0/5 | [01-skeptic.md](01-skeptic.md) |
| 2 | Builder's Audit | Builder | 3.5/5 | [02-builder.md](02-builder.md) |
| 3 | Guardian's Audit | Guardian | 3.2/5 | [03-guardian.md](03-guardian.md) |
| 4 | Minimalist's Audit | Minimalist | 2.0/5 | [04-minimalist.md](04-minimalist.md) |
| 5 | Tester's Audit | Tester | 3.2/5 | [05-tester.md](05-tester.md) |
| 6 | Adversary's Audit | Adversary | 3.0/5 | [06-adversary.md](06-adversary.md) |
