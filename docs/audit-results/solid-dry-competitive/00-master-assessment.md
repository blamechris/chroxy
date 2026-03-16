# Master Assessment: SOLID/DRY/Competitive Audit

**Date:** 2026-03-16
**Target:** Chroxy codebase — SOLID principles, DRY violations, competitive gaps
**Agents:** 6 (4 core + Futurist + Operator)
**Aggregate Rating:** 3.1 / 5

---

## a. Auditor Panel

| # | Agent | Rating | Key Contribution |
|---|-------|--------|------------------|
| 1 | Skeptic | 3.3/5 | GeminiSession.setModel LSP violation, fat _handlerCtx, _pendingStreams encapsulation leak |
| 2 | Builder | 2.8/5 | Two parallel 2200-line message handlers, utils/crypto/types.ts duplicated across app+dashboard |
| 3 | Guardian | 2.8/5 | Dual permission lifecycle paths, ConnectionPhase not a real state machine, timeout inconsistency |
| 4 | Minimalist | 3.0/5 | @chroxy/protocol doesn't earn its keep, tunnel registry for 1 plugin, ws-client-sender.js is 72 lines |
| 5 | Futurist | 3.2/5 | Event whitelist blocks provider extension, no plugin architecture, single-token auth blocks teams |
| 6 | Operator | 6.2/10 | LAN scan needs 1-tap connect, no auto-resume on restart, voice hidden during streaming, no batch permission approve |

---

## b. Consensus Findings

### 1. App and dashboard message handlers are parallel 2200-line implementations (5/6 agents)
The same WS protocol is handled by two independent ~2200-line files with the same heartbeat logic, delta batching, RTT calculation, and session state management. Changes must be applied twice. Divergences already exist (missing `activityState`, `GitFileStatus` vs `GitStatusEntry`).

### 2. The app's message-handler.ts switch is the last god-function (4/6 agents)
81 cases in one function, violating SRP and OCP. The server solved this with a handler registry — the app never got the same treatment. Steps 1-3 extracted 29 handlers; ~52 remain.

### 3. No extensibility surface for providers or operators (4/6 agents)
Event whitelist is hardcoded, handler registry is closed, no plugin API, no custom command hooks. Every new provider feature requires modifying core files.

### 4. Single-token auth blocks any multi-user/team story (4/6 agents)
All clients share one token with identical permissions. No read-only observers, no per-user sessions, no audit identity.

---

## c. Risk Heatmap

```
                    IMPACT
            Low    Medium    High    Critical
          +--------+--------+--------+--------+
  Likely  | ws-    | utils  | app    |        |
          | client | .ts    | msg    |        |
          | sender | duped  | handler|        |
          +--------+--------+--------+--------+
 Possible | tunnel | types  | auth   | dual   |
          | reg    | .ts    | single | perm   |
          | 1 plug | drift  | token  | paths  |
          +--------+--------+--------+--------+
 Unlikely |        | crypto | event  | history|
          |        | .ts    | white  | at     |
          |        | duped  | list   | scale  |
          +--------+--------+--------+--------+
```

---

## d. Recommended Action Plan

### Priority 1 — SOLID/DRY (Code Quality)
1. Fix GeminiSession.setModel to call super.setModel() (LSP violation)
2. Move shared utils (stripAnsi, nextMessageId, withJitter) to @chroxy/store-core
3. Move shared crypto.ts to @chroxy/store-core with platform adapter
4. Unify types.ts — shared types in store-core, platform-specific extensions in each consumer
5. Extract getSessionCwd() helper for 18 copy-pasted two-liners in handlers
6. Close _pendingStreams encapsulation leak in SessionManager
7. Replace raw console.log with createLogger in handlers + token-manager
8. Continue app message-handler decomposition (steps 4-8, ~52 cases remaining)

### Priority 2 — Architecture (Extensibility)
9. Add registerEventType() to EventNormalizer for provider custom events
10. Export registerMessageHandler() from ws-message-handlers.js
11. Add extension_message envelope type to protocol for provider-specific payloads
12. Inject CheckpointManager/DevPreviewManager/WebTaskManager into WsServer constructor

### Priority 3 — Safety Patterns
13. Unify dual permission lifecycle (PermissionManager + ws-permissions) into single interface
14. Add proper state machine for ConnectionPhase with transition guards
15. Add project-wide timeout utility with consistent defaults
16. Fix supervisor shutdown to await child exit (not wall-clock timer)

### Priority 4 — UX / Competitive
17. Auto-resume last session on server reconnect
18. One-tap connect for LAN-discovered servers
19. Show voice mic button during Claude streaming
20. Add "allow this tool for this session" batch permission option
21. Use SyntaxHighlightedCode in FileEditor
22. Add cost/token count to HistoryScreen conversation rows

### Priority 5 — Simplification
23. Evaluate inlining @chroxy/protocol into server (1 consumer, mandatory tsc step)
24. Collapse tunnel registry into direct factory (1 provider)
25. Merge ws-client-sender.js into ws-broadcaster.js

---

## e. Final Verdict

**Aggregate Rating: 3.1 / 5**

| Agent | Raw | Weight | Weighted |
|-------|-----|--------|----------|
| Skeptic | 3.3 | 1.0 | 3.3 |
| Builder | 2.8 | 1.0 | 2.8 |
| Guardian | 2.8 | 1.0 | 2.8 |
| Minimalist | 3.0 | 1.0 | 3.0 |
| Futurist | 3.2 | 0.8 | 2.56 |
| Operator | 3.1 | 0.8 | 2.48 |
| **Total** | | **5.6** | **16.94** |
| **Avg** | | | **3.03 ≈ 3.1** |

The server-side architecture is genuinely well-structured after the 34-PR marathon — provider registry, handler decomposition, tunnel abstraction, and session manager delegation are all solid patterns. The debt is concentrated in three areas: (1) the app/dashboard parallel implementation gap (~4400 lines of duplicated protocol handling), (2) the closed extensibility surface that blocks provider-specific features and operator customization, and (3) competitive UX gaps in session management and permission workflow that are addressable without architectural changes.
