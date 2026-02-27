# Master Assessment — Full Codebase Health Post-v0.2.0

**Audit Date:** 2026-02-26
**Scope:** Full codebase — server, app, desktop, tests, CI, docs
**Auditor Panel:** 8 agents (Skeptic, Builder, Guardian, Minimalist, Tester, Adversary, Operator, Futurist)

---

## a. Auditor Panel

| Agent | Perspective | Rating | Key Contribution |
|-------|------------|--------|-----------------|
| Skeptic | Claims vs reality | 3.5/5 | CSP connect-src breaks tunnel dashboard; app token_rotated is no-op; dead tmux code |
| Builder | Missing components | 4.0/5 | No desktop Rust tests; double _schedulePersist; vestigial PTY types |
| Guardian | Security & failure modes | 3.8/5 | Crash handler cleanup incomplete; token in URL/page source; mDNS leaks auth mode |
| Minimalist | Dead code & complexity | 3.5/5 | handleCliMessage duplication (115 lines); 11K lines of stale audit docs; dashboard is second app |
| Tester | Coverage gaps | 3.0/5 | 13 WS handlers untested; 50 tunnel tests excluded from CI; zero app UI tests |
| Adversary | Attack surface | 3.8/5 | Token extraction via browser history; DoS via WS connection flood; no pre-auth limit |
| Operator | UX & accessibility | 3.8/5 | ConnectScreen missing accessibility roles; dashboard not keyboard-navigable; Android rename broken |
| Futurist | Extensibility & debt | 3.5/5 | Protocol duplicated 3x; Zustand monolith; single-user architecture |

---

## b. Consensus Findings (4+ Agents Agree)

### 1. Mobile App Ignores `token_rotated` (6 agents)

**Skeptic, Builder, Guardian, Tester, Adversary, Futurist** all identified that `message-handler.ts:1817-1822` handles `token_rotated` with `console.log` + `break`. The dashboard has a complete re-auth flow. The app silently breaks.

**Evidence:** Compare `dashboard-app.js:1616-1625` (full re-auth UI) vs `message-handler.ts:1817-1822` (no-op).

**Action:** Implement app-side token rotation handling — disconnect, show re-scan QR prompt, clear stored token.

### 2. Dashboard CSP / WebSocket URL Restricts to Localhost Only (5 agents)

**Skeptic, Guardian, Adversary, Operator, Futurist** identified that `connect-src` in ws-server.js:481 only allows `ws://localhost:PORT`. The dashboard JS hardcodes `ws://localhost:PORT` at dashboard-app.js:1211. Dashboard over tunnel serves HTML but WebSocket cannot connect.

**Evidence:** CSP at ws-server.js:481, WS URL at dashboard-app.js:1211.

**Action:** Either document dashboard as localhost-only, or compute WS URL from `window.location` and dynamically set CSP.

### 3. 50 Tunnel Tests Silently Excluded from CI (4 agents)

**Tester, Builder, Skeptic, Futurist** identified the test glob `./tests/*.test.js` in package.json:13 doesn't recurse into `./tests/tunnel/`. Three test files (base.test.js, cloudflare.test.js, registry.test.js) with 50 passing tests never run in CI.

**Evidence:** package.json test command vs `tests/tunnel/*.test.js` file paths.

**Action:** One-line fix: change glob to `'./tests/**/*.test.js'`.

### 4. No Desktop (Rust) Tests (5 agents)

**Builder, Tester, Guardian, Minimalist, Futurist** identified zero `#[test]` blocks across 7 Rust source files (1,197 lines). No `cargo test` in CI either.

**Evidence:** Zero test infrastructure in packages/desktop/src-tauri/.

**Action:** Add `#[cfg(test)]` modules for at minimum server.rs and config.rs. Add `cargo test` to CI.

### 5. Crash Handler Cleanup Is Incomplete (4 agents)

**Guardian, Skeptic, Builder, Tester** identified that crash handlers in server-cli.js:406-418 call `broadcastShutdown` and `wsServer.close()` but skip `sessionManager.destroyAll()` (orphaned Claude processes), `tunnel.stop()`, and `removeConnectionInfo()`. server-cli-child.js:120-128 has zero cleanup.

**Evidence:** Compare graceful SIGTERM handler (full cleanup) vs crash handlers (partial cleanup).

**Action:** Add best-effort `sessionManager.destroyAll()` and `removeConnectionInfo()` in crash handlers. Add cleanup to child process handlers too.

---

## c. Contested Points

### Dashboard Complexity: Feature or Liability?

- **Minimalist** (3/5): "dashboard-app.js is a second app hiding inside the server" — 1,793 lines reimplementing WS, markdown, persistence, terminal. Should be modularized or questioned.
- **Builder** (4/5): "Dashboard JS is a 1793-line IIFE... readability is starting to strain" but functionally complete.
- **Operator** (4/5): Dashboard UX is good — reconnect banner, syntax highlighting, session tabs all work well.
- **Futurist** (3/5): "Third independent protocol implementation" — compounding debt.

**Assessment:** The Minimalist and Futurist are right about the structural risk. The dashboard works today but at 1,793 lines with zero behavioral tests, it is the highest-risk file for regressions. Modularization into 3 files (ws, ui, terminal) would make it testable without reducing functionality.

### Protocol Version: Adequate or Insufficient?

- **Futurist** (3/5): "Protocol version negotiation is one-way and insufficient for breaking changes."
- **Builder** (4/5): Current protocol is stable and well-documented in reference.md.
- **Skeptic** (neutral): Noted version constants are manually synced across 3 locations.

**Assessment:** The Futurist's concern is forward-looking but valid. The immediate fix (add `protocolVersion` to auth message) is low-effort and enables future negotiation without blocking current development.

---

## d. Factual Corrections

| Claim | Correction | Found By |
|-------|------------|----------|
| server-cli.js:23 "Auto-discovers tmux sessions" | tmux fully removed in v0.2.0 | Skeptic |
| types.ts:298 `serverMode: 'cli' \| 'terminal'` | `'terminal'` is dead; PTY removed | Builder, Futurist |
| `new_sessions_discovered` handler (server-cli.js:127) | Event never emitted; dead code | Skeptic, Minimalist |
| server-cli-child.js crash handlers | No broadcastShutdown or cleanup despite server-cli.js having it | Guardian |

---

## e. Risk Heatmap

```
                    IMPACT
            Low      Medium     High
         ┌─────────┬──────────┬──────────┐
  High   │         │ WS DoS   │ Token in │
         │         │ (no pre- │ URL/page │
         │         │ auth lim)│ source   │
         ├─────────┼──────────┼──────────┤
Likely   │ Dead    │ App      │ 50 tests │
  hood   │ tmux    │ token_   │ excluded │
  Med    │ code    │ rotated  │ from CI  │
         │         │ no-op    │          │
         ├─────────┼──────────┼──────────┤
  Low    │ TOCTOU  │ mDNS     │ Crash    │
         │ race    │ service  │ handler  │
         │         │ leak     │ orphans  │
         └─────────┴──────────┴──────────┘
```

---

## f. Recommended Action Plan

### Priority 1: High-Impact, Low-Effort (do now)

1. **Fix tunnel test glob** — change `./tests/*.test.js` to `'./tests/**/*.test.js'` in package.json. Recovers 50 tests in CI. (1 line)
2. **Remove dead tmux code** — delete `new_sessions_discovered` handler in server-cli.js:127-133, update JSDoc at line 23. (~15 lines)
3. **Remove dead session-manager code** — delete `SessionNotFoundError`, `getFullHistory` sync, duplicate `_schedulePersist`. (~25 lines)
4. **Extract `_killAndRespawn()`** in cli-session.js — deduplicate the 37-line block in setModel/setPermissionMode.

### Priority 2: High-Impact, Medium-Effort (next sprint)

5. **Implement app `token_rotated` handler** — disconnect, clear stored token, show re-scan UI. (~2-4 hours)
6. **Add crash handler cleanup** — `sessionManager.destroyAll()` + `removeConnectionInfo()` in both server-cli.js and server-cli-child.js crash handlers.
7. **Unify `handleCliMessage` into `handleSessionMessage`** — eliminate the 115-line legacy duplicate in ws-message-handlers.js.
8. **Add pre-auth WebSocket connection limit** — reject connections when >10 unauthenticated sockets are pending.

### Priority 3: Strategic Improvements (1-2 months)

9. **Add `protocolVersion` to auth message** — client declares version, server can adapt or reject.
10. **Add integration tests for untested WS handlers** — create_session, destroy_session, resume_budget, checkpoints (13 handlers total).
11. **Modularize dashboard-app.js** — split into dashboard-ws.js, dashboard-ui.js, dashboard-terminal.js for testability.
12. **Add accessibility roles to ConnectScreen** — accessibilityRole + accessibilityLabel on all touchables.
13. **Add keyboard navigation to web dashboard** — :focus-visible styles, tabindex on session tabs.

### Priority 4: Foundation for Growth (3-6 months)

14. **Create packages/protocol/** — shared message types, Zod schemas, version constants.
15. **Split Zustand store into slices** — connection, sessions, features.
16. **Add component tests for app** — ChatView, InputBar, SessionScreen using React Native Testing Library.
17. **Add Rust tests + cargo test to CI** — start with server.rs and config.rs.

---

## g. Final Verdict

**Aggregate Rating: 3.6 / 5**

*(Core panel average: 3.7, weighted 1.0x. Extended panel average: 3.5, weighted 0.8x. Combined weighted: 3.6)*

Chroxy at v0.2.0 is a well-engineered project that punches above its weight. The server has strong security fundamentals (constant-time auth, NaCl encryption, Zod validation, execFile everywhere, realpath sandboxing), a clean provider/adapter architecture, and a 1.3:1 test-to-source ratio. The mobile app has a well-decomposed Zustand store, proper connection state machine, and encrypted transport. The CI pipeline uses pinned action SHAs and runs 4 parallel quality gates.

The audit identified two categories of issues: **operational gaps** and **structural debt**. The operational gaps — app ignoring token_rotated, 50 tests excluded from CI, crash handlers skipping cleanup, dead tmux code — are high-priority but low-effort fixes that should be addressed immediately. The structural debt — three independent protocol implementations, the Zustand monolith, the dashboard's untested 1,793-line JavaScript — represents the natural growth ceiling of a v0.2.0 project and should be addressed strategically over the next 1-3 months.

No security vulnerabilities were found that would allow unauthenticated access. The most impactful security improvement would be replacing the token-in-URL dashboard auth with a session cookie flow to eliminate the browser history/page source token exfiltration path.

The codebase is healthy, well-documented, and ready for continued feature development — provided the Priority 1 and 2 items are addressed first to close the gaps the audit revealed.

---

## h. Appendix

| # | Agent | File |
|---|-------|------|
| 1 | Skeptic | [01-skeptic.md](./01-skeptic.md) |
| 2 | Builder | [02-builder.md](./02-builder.md) |
| 3 | Guardian | [03-guardian.md](./03-guardian.md) |
| 4 | Minimalist | [04-minimalist.md](./04-minimalist.md) |
| 5 | Tester | [05-tester.md](./05-tester.md) |
| 6 | Adversary | [06-adversary.md](./06-adversary.md) |
| 7 | Operator | [07-operator.md](./07-operator.md) |
| 8 | Futurist | [08-futurist.md](./08-futurist.md) |
