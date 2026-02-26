# Master Assessment: Chroxy Codebase Re-Baseline (Feb 26, 2026)

**Audit Target**: Full codebase at commit 8f7b4262
**Agent Count**: 8
**Date**: 2026-02-26
**Aggregate Rating**: 3.4 / 5 (weighted)

---

## a. Auditor Panel

| # | Agent | Perspective | Rating | Key Contribution |
|---|-------|------------|--------|-----------------|
| 1 | Skeptic | Claims vs reality | 3.5 | Found conversation history messages bypass Zod schema — feature is broken. Catalogued 9+ missing WS types in reference.md. |
| 2 | Builder | Implementability | 3.8 | Identified `session-db.js` as dead code carrying a native addon dependency. Mapped provider capability divergence. |
| 3 | Guardian | Safety/reliability | 3.5 | No `uncaughtException`/`unhandledRejection` handlers. Conversation scanner unbounded DoS. Standby server infinite retry. |
| 4 | Minimalist | Complexity reduction | 2.5 | `dashboard.js` is a 2,768-line string monolith. `ws-schemas.js` has 60 unused server→client schemas. `codex-session.js` is speculative. |
| 5 | Operator | UX walkthrough | 3.5 | Queued messages provide zero feedback. Auto-connect failure is silent for 19s. LAN scan has no empty state. |
| 6 | Tester | Test coverage | 3.5 | Conversation history has zero test coverage at every layer. `message-handler.ts` has 67 types, 3 tested. 102 sleep-based assertions. |
| 7 | Adversary | Attack surface | 3.0 | Token broadcast on rotation negates rotation security. `launch_web_task` prompt has no size cap. No CSP on dashboard. |
| 8 | Futurist | Long-term viability | 3.5 | Cloudflare tunnel is single point of failure. No protocol version negotiation. Single-connection store blocks multi-machine. |

---

## b. Consensus Findings (5+ agents agree)

### 1. CRITICAL: Conversation history messages bypass Zod schema validation (7/8 agents)

`list_conversations` and `resume_conversation` are not in the `ClientMessageSchema` discriminated union (`ws-schemas.js:432-463`). Every message passes through `ClientMessageSchema.safeParse(msg)` at `ws-server.js:969-976` — unknown types fail and get `INVALID_MESSAGE` error. The handlers at `ws-message-handlers.js:427-473` are dead code. The conversation history feature shipped in the last release cycle is **completely broken**.

**Evidence**: Skeptic, Guardian, Tester, and Adversary independently verified by reading `ws-schemas.js`. Tester confirmed zero test coverage. Builder noted it indirectly. Operator noted the HistoryScreen has no error handling for this failure.

**Action**: Add `ListConversationsSchema` and `ResumeConversationSchema` to `ClientMessageSchema`. Add integration tests. This is a 2-line schema fix + test coverage.

### 2. `dashboard.js` is a 2,768-line HTML/CSS/JS string monolith (6/8 agents)

The entire desktop frontend lives in a JavaScript template literal. No linting, no type checking, no modularity. Tests check DOM structure via `.includes()` on a string, not JS behavior. The dashboard has acquired feature parity with the mobile app (sessions, history, QR pairing, syntax highlighting, terminal, permissions) all maintained in a format immune to tooling.

**Evidence**: Minimalist (detailed line counts), Builder (effort impact), Futurist (6-month trajectory), Operator (UX gaps vs app), Skeptic (acceptEdits gap), Adversary (no CSP, XSS risk).

**Action**: Extract into a proper web app with a build step. Serve as static assets. The server already has `/assets/` serving. Effort: 2-3 days.

### 3. Missing error handlers create silent crash risk (5/8 agents)

No `process.on('uncaughtException')` or `process.on('unhandledRejection')` in either `server-cli.js` or `server-cli-child.js`. Node 22 terminates on unhandled rejections by default. The supervisor restarts the child but logs only `code 1, signal null` — no error context.

**Evidence**: Guardian (detailed analysis of crash paths). Builder, Tester, Futurist, and Adversary referenced the reliability gap.

**Action**: Add global error handlers to both entry points. Log the error before exiting. 15 minutes of work.

### 4. Provider capability gaps are not surfaced to users (5/8 agents)

`SdkSession.capabilities.planMode = false` but the UI still shows plan mode controls. `CliSession.capabilities.resume = false` but `resume_conversation` doesn't check before creating. Users can enable plan mode on SDK sessions — the UI accepts it, the server stores it, but no `plan_started`/`plan_ready` events ever fire.

**Evidence**: Builder (detailed capability matrix), Futurist (protocol evolution concern), Skeptic, Tester, Operator (UX failure path).

**Action**: Check `session.constructor.capabilities` before allowing `set_permission_mode: plan` and `resume_conversation`. Return `session_error` if unsupported.

---

## c. Contested Points

### `ws-schemas.js` server→client schemas: Delete vs Keep

**DELETE** (Minimalist): 60 of 64 exported schemas have zero production callers. The 1,227-line test file validates Zod itself, not business logic. Total waste: ~1,567 lines.

**KEEP** (Tester, Guardian — implicitly): The schemas serve as living protocol documentation. `ws-schemas.test.js` validates message shapes, catching drift when fields are renamed. The test-to-value ratio is low but the documentation value is real.

**Assessment**: The Minimalist has the stronger argument on pure code terms, but deleting the schemas removes the only machine-readable protocol spec. **Compromise: keep the schemas, delete the separate test file. Use the schemas as TypeDoc/JSDoc references, and add a single integration test that validates real server output matches the schema shapes.**

### `codex-session.js`: Delete vs Keep

**DELETE** (Minimalist): 555 lines with no tests, no documentation, no dependency in package.json, no users. Pure YAGNI.

**KEEP** (Builder, Futurist — implicitly): The provider registry pattern is proven by its existence. Adding a provider later is trivial. But keeping untested code signals to future developers that it works.

**Assessment**: **Delete it.** The provider registry makes re-adding trivial. Keeping untested, undocumented code that references an uninstalled dependency (`@openai/codex`) is misleading. If Codex support is needed, it can be re-implemented with tests in a focused PR.

### `session-db.js`: Wire in vs Delete

**WIRE IN** (Builder): The schema is well-designed, the migration path is thoughtful, and SQLite persistence would replace the fragile in-memory ring buffer. 2-3 days to integrate.

**DELETE** (Minimalist): It ships `better-sqlite3` (a native addon) as a production dependency with zero runtime callers. Remove it until it's actually needed.

**Assessment**: **Delete for now**, re-add when persistence is a priority. The native addon adds compile time and platform complexity to `npm install` for zero benefit today.

---

## d. Factual Corrections

| Claim | Correction | Found By |
|-------|-----------|----------|
| Conversation history feature is shipped and working | Messages fail schema validation — feature is completely broken | Skeptic, Guardian |
| `acceptEdits` not in dashboard | PR #935 (in flight) adds it with dynamic population | Skeptic, Operator |
| `client.mode` is used for terminal/chat routing | The value is written but never read anywhere in the server | Minimalist |
| `session-db.js` backs session persistence | The file has zero production callers; `session-manager.js` uses an in-memory Map | Builder |
| `codex-session.js` is a working provider | `@openai/codex` is not in package.json dependencies; no tests exist | Minimalist |

---

## e. Risk Heatmap

```
                    IMPACT
           Low      Medium     High
        +---------+---------+---------+
  High  |         | Stale   | Schema  |
  L     |         | docs    | bypass  |
  I     |         |         | (conv   |
  K     |         |         | history)|
  E     +---------+---------+---------+
  L     | Dead    | dash.js | No      |
  I     | mode    | monolith| error   |
  H     | message |         | handlers|
  O     |         |         |         |
  O     +---------+---------+---------+
  D     | codex   | Store   | Token   |
        | dead    | singleton| broadcast|
        | code    | (future) | on rotate|
        +---------+---------+---------+
```

---

## f. Recommended Action Plan

### This Week (hours, not days)

1. **Fix conversation history schema** — Add `ListConversationsSchema` and `ResumeConversationSchema` to `ClientMessageSchema` in `ws-schemas.js`. Add integration tests in `ws-server.test.js`. **P0 — the feature is broken.** Effort: 2-4 hours.

2. **Add global error handlers** — `process.on('uncaughtException')` and `process.on('unhandledRejection')` in `server-cli.js` and `server-cli-child.js`. Effort: 30 minutes.

3. **Merge PR #935** — `acceptEdits` in dashboard. Already reviewed and clean.

4. **Add capability gates** — Check `capabilities.planMode` before allowing plan mode switch. Check `capabilities.resume` before `resume_conversation`. Return `session_error` if unsupported. Effort: 1-2 hours.

5. **Cap `launch_web_task` prompt size** — Add `.max(10_000)` to `LaunchWebTaskSchema.prompt` in `ws-schemas.js`. Effort: 5 minutes.

### Next 2 Weeks

6. **Delete dead code** — Remove `codex-session.js` (555 lines), `session-db.js` (579 lines) + `better-sqlite3` dep, dead `mode` message handler. Effort: 1-2 hours.

7. **Add `conversationHistoryLoading` timeout** — 10-second timeout in `fetchConversationHistory()` to clear loading spinner on no response. Effort: 30 minutes.

8. **Fix standby server infinite retry** — Add retry counter to `_startStandbyServer()` EADDRINUSE handler. Effort: 30 minutes.

9. **Add Content-Security-Policy to dashboard** — `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss:`). Effort: 30 minutes.

10. **Update reference.md** — Add 9+ missing server→client message types and 8+ missing app files. Effort: 1-2 hours.

### Next 30 Days

11. **Extract `dashboard.js` into a real web app** — Serve as static files from `packages/dashboard/`. Enable linting, type checking, and proper testing. Effort: 2-3 days.

12. **Add protocol version negotiation** — `protocolVersion: 1` in `auth_ok`. Graceful degradation in `message-handler.ts` for unknown types from older servers. Effort: 2-3 hours.

13. **Add UX improvements from Operator findings** — Queued message feedback, LAN scan empty state, auto-connect progress indicator. Effort: 1-2 days.

14. **Expand test coverage for `message-handler.ts`** — Cover `permission_request`, `stream_start/delta/end`, `plan_started/ready`, `session_switched`. Effort: 2-3 days.

### 60+ Days

15. **Remove token broadcast on rotation** — Send only `token_rotated: true`, require re-auth. Effort: 1-2 days (protocol change).

16. **Add alternative tunnel provider** — ngrok or Tailscale adapter alongside Cloudflare. Effort: 3-5 days.

17. **Introduce server registry for multi-machine** — Abstract the single-connection store into a multi-server model. Effort: 5-8 days.

18. **Standardize sleep-based test assertions** — Replace 102 `setTimeout` patterns with event-based negative assertions. Effort: 2-3 days.

---

## g. Final Verdict

### Aggregate Rating

Weighted calculation (core panel: 1.0x weight, extended panel: 0.8x weight):

```
Core panel (Skeptic 3.5, Builder 3.8, Guardian 3.5, Minimalist 2.5): weight 1.0x each
Extended panel (Operator 3.5, Tester 3.5, Adversary 3.0, Futurist 3.5): weight 0.8x each

Numerator:   (3.5 + 3.8 + 3.5 + 2.5) * 1.0 + (3.5 + 3.5 + 3.0 + 3.5) * 0.8
           = 13.3 + 10.8
           = 24.1

Denominator: 4 * 1.0 + 4 * 0.8
           = 4 + 3.2
           = 7.2

Rating:      24.1 / 7.2 = 3.35 → 3.4/5
```

### Verdict

**Aggregate Rating: 3.4 / 5** (up from 3.3 at the Feb 21 audit)

Chroxy has made meaningful progress since the last audit: the ws-server.js monolith was split (2,691 → 1,226 lines), PTY mode was fully removed, ESLint achieved zero-warning baseline, and significant features shipped (conversation history, QR pairing, VPN filtering). The server architecture is genuinely well-structured and the test suite is dense where it covers.

The critical finding is that the conversation history feature — the most recently shipped user-facing work — is completely broken in production. `list_conversations` and `resume_conversation` messages fail Zod schema validation before reaching their handlers. Seven of eight auditors independently identified this. This is a release process gap: the feature was implemented and tested at the handler level but never wired into the schema union that gates all inbound messages. A 2-line schema fix resolves it, but the absence of an integration test that would have caught this is the deeper problem.

Beyond this showstopper, the codebase's chronic issues are: `dashboard.js` (2,768 lines of HTML/CSS/JS in a template string, flagged by 6 agents), dead code carrying real dependencies (`session-db.js` with `better-sqlite3`, `codex-session.js` with no installed dependency), and provider capability gaps silently breaking features (plan mode on SDK, resume on CLI). The Adversary's finding about token broadcast on rotation is a genuine security concern for production use. The Futurist correctly identifies that the single-connection store and absent protocol versioning will become blocking issues if App Store submission proceeds.

The path forward: fix the schema bug immediately, merge PR #935, add error handlers and capability gates, then clean up dead code. The 30-day priority is extracting `dashboard.js` into a real web app and adding protocol version negotiation before the app is published.

---

## h. Appendix: Individual Reports

| # | Agent | File | Rating |
|---|-------|------|--------|
| 1 | Skeptic | [01-skeptic.md](01-skeptic.md) | 3.5/5 |
| 2 | Builder | [02-builder.md](02-builder.md) | 3.8/5 |
| 3 | Guardian | [03-guardian.md](03-guardian.md) | 3.5/5 |
| 4 | Minimalist | [04-minimalist.md](04-minimalist.md) | 2.5/5 |
| 5 | Operator | [05-operator.md](05-operator.md) | 3.5/5 |
| 6 | Tester | [06-tester.md](06-tester.md) | 3.5/5 |
| 7 | Adversary | [07-adversary.md](07-adversary.md) | 3.0/5 |
| 8 | Futurist | [08-futurist.md](08-futurist.md) | 3.5/5 |
