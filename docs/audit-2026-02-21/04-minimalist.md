# Minimalist's Audit: Chroxy Complexity & Backlog Review

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code
**Overall Rating**: 2.5 / 5
**Date**: 2026-02-21

---

## Codebase Inventory

| Area | Files | Lines of Code |
|------|-------|---------------|
| Server (`packages/server/src/`) | 40 | 11,615 |
| App (`packages/app/src/`) | 37 | 7,514 |
| Server Tests (`packages/server/tests/`) | 29 | ~8,000+ |
| App Tests (`packages/app/src/__tests__/`) | 9 | ~2,000+ |
| Maestro Flows (`packages/app/.maestro/`) | 11 | ~500 |
| **Total production code** | **77** | **~19,100** |
| **Total including tests** | **126** | **~30,000+** |

For a v0.1.0 project with one developer, this is a lot of code. The test-to-production ratio (~1.1:1 by LOC) is healthy, but the absolute size suggests over-engineering.

---

## Over-Engineering Audit

### 1. Provider Registry (`providers.js`)
A plugin registry pattern for... two providers (SDK and CLI). The registry includes capability declarations (`permissionModeSwitch`, `planMode`, `backgroundAgents`), validation logic, and a formal registration API. There is no third provider planned. A simple `if/else` would suffice.

**Verdict: YAGNI.** ~150 lines that could be 20.

### 2. Tunnel Registry (`packages/server/src/tunnel/`)
Three files (`base.js`, `cloudflare.js`, `registry.js`) implementing a tunnel abstraction layer. There is one tunnel provider: Cloudflare. The base class, registry pattern, and capability system exist for hypothetical future tunnel providers that do not exist.

**Verdict: YAGNI.** ~300 lines that could be 100.

### 3. EventNormalizer (`event-normalizer.js`)
Added in PR #714 to normalize session events. Reasonable in concept -- it decouples the WS protocol from session internals. But it adds another layer between session and ws-server, and the normalization is straightforward mapping that could live in the session classes themselves.

**Verdict: BORDERLINE.** Useful if there will be more event sources. Over-engineered if SDK is the only path forward.

### 4. Zod Schemas (`ws-schemas.js`)
PR #712 added Zod validation for all WS messages. For a single-client app with trusted connections (behind auth + encryption), this is belt-and-suspenders. The schemas are 170 lines validating messages that the app already constructs correctly.

**Verdict: BORDERLINE.** Good for documentation and catching bugs, but the app is the only client.

### 5. ws-server.js God Object (2,691 lines)
This file handles: HTTP server, health checks, WebSocket upgrades, authentication, rate limiting, encryption handshake, message routing, session management bridge, file browsing, diff generation, history replay, and broadcasting. It is not over-engineered -- it is under-decomposed. The complexity is real but concentrated in one place.

**Verdict: NEEDS SPLITTING**, not deletion.

### 6. Supervisor (`supervisor.js`)
The supervisor is 5x the complexity needed for "restart on crash." It has backoff curves, standby health check responses, signal forwarding, and graceful shutdown choreography. For a dev tool that one person uses, a bash `while true` loop would have worked.

**Verdict: OVER-ENGINEERED.** But it works, so leave it.

### 7. PTY Mode (Legacy)
Four files totaling 1,345 lines:
- `server.js`: 168 LOC
- `pty-manager.js`: 251 LOC
- `pty-session.js`: 178 LOC
- `output-parser.js`: 748 LOC

Plus their test files: `pty-manager.test.js`, `output-parser.test.js`.

CLI headless mode (`server-cli.js` + `sdk-session.js`) is the primary path. PTY mode is `--terminal` flag only. It requires tmux, node-pty (which breaks on Node 25), and parses raw ANSI output with a 748-line state machine. The CLI mode gets structured JSON directly.

**Verdict: DELETE.** This is 1,345 lines of production code + ~2,000 lines of tests that serve a deprecated path.

---

## Issue Backlog Triage

29 open issues. Categorized:

### Actually Needed (4)

| Issue | Why |
|-------|-----|
| #685 Client persistence | Core UX -- losing chat on disconnect is unacceptable |
| #686 Dynamic models | Static list breaks when Anthropic adds models |
| #607 Diff viewer (app) | Server plumbing done, app needs to render it |
| #684 Image results | Computer-use screenshots are a key Claude Code feature |

### Nice to Have (4)

| Issue | Why |
|-------|-----|
| #628 Onboarding | Helps new users, not blocking daily use |
| #623 Connection quality | Useful indicator, not essential |
| #619 Biometric lock | Security feature, low effort |
| #627 Terminal export | Convenience feature |

### YAGNI (21)

| Issues | Category | Reasoning |
|--------|----------|-----------|
| #610, #620 | Web client / Claude Code Web | Massive scope expansion for hypothetical users |
| #613 | Codex provider | Multi-agent orchestration for a mobile terminal app |
| #611 | Parallel sessions | One person talks to one Claude at a time |
| #614 | Dev server preview | Feature creep beyond core use case |
| #617 | Checkpoint/rewind | Git already does this |
| #618 | Tablet/landscape | One user, one phone |
| #615 | Conversation search | Nice but premature for v0.1 |
| #622 | WS compression | Premature optimization |
| #624 | Token rotation | Single user, single device |
| #625 | Session timeout | Sessions are manual |
| #626 | Cost budget | Claude Code already warns on cost |
| #616 | Usage limit awareness | Same |
| #621 | Enterprise self-hosting guide | There is one user |
| #679 | SQLite migration | JSON files work fine at current scale |
| #683 | MCP awareness | Adds complexity for marginal benefit |
| #662, #663, #713, #716, #665 | Stale / resolved | Should already be closed |

---

## Roadmap Consolidation

**Competitive audit roadmap**: Done through Phase 3. Phase 4 has 5 items, 4 not started.
**In-app-dev roadmap**: Partially stale, 3 items listed as not-started are done.

**Recommendation:** Archive the in-app-dev roadmap. Use the competitive audit roadmap as the single source of truth. Add the 4 "actually needed" items from the backlog triage above if they are not already there.

---

## What to Delete (The 30% Cut)

| Target | LOC Saved | Risk |
|--------|-----------|------|
| PTY mode (server.js, pty-manager.js, pty-session.js, output-parser.js) | ~1,345 | Low -- CLI headless is the path forward |
| PTY mode tests (pty-manager.test.js, output-parser.test.js) | ~2,000 | None -- tests for deleted code |
| Provider registry (replace with direct import) | ~130 | Low -- only 2 providers |
| Tunnel registry (inline Cloudflare) | ~200 | Low -- only 1 tunnel provider |
| 21 YAGNI issues | 0 LOC but mental overhead | Low -- can reopen if needed |
| Stale audit docs (consolidate) | ~0 (docs) | None |
| **Total** | **~3,675 LOC** | Approximately 20% of production code |

With PTY mode tests, closer to **~5,675 LOC** or **~19% of total codebase**.

---

## The 80/20 Question

If you could only do three things for the next month, what would they be?

1. **Auto-connect + client persistence** -- the two things that make the app feel "installed" rather than "demo." Auto-connect is already implemented (`ConnectScreen.tsx:79-98`), just needs timeout tuning. Client persistence (#685) is the bigger lift but the most impactful UX improvement.

2. **Split ws-server.js** -- extract message routing, file operations, and auth into separate modules. The 2,691-line god object is the #1 maintenance risk and the #1 barrier to contribution.

3. **Delete PTY mode** -- 1,345 lines of production code for a deprecated feature path. Every line you keep is a line you maintain.

---

## Top 5 Recommendations

1. **Cut PTY mode entirely.** Remove `server.js`, `pty-manager.js`, `pty-session.js`, `output-parser.js`, and their tests. Save 3,345+ lines. CLI headless is the future.

2. **Close 24 issues.** 5 stale + 21 YAGNI = 24 issues that should not be open. A 29-issue backlog for a v0.1 solo project is anxiety, not planning. Keep 5 issues max.

3. **Merge roadmaps.** One roadmap. One priority list. Archive the rest.

4. **Collapse registries.** Replace provider registry with direct import of `SdkSession`. Replace tunnel registry with direct import of `CloudflareTunnel`. Save ~330 lines and two layers of abstraction.

5. **Split ws-server.js.** Extract into `ws-auth.js`, `ws-router.js`, `ws-files.js`, `ws-encryption.js`. The god object pattern is the biggest complexity driver in the codebase.
