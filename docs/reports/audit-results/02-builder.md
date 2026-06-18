# Builder's Audit: Status Report Backlog

**Agent**: Builder — pragmatic full-stack dev who will implement this; file-by-file change lists + realistic estimates
**Overall Rating**: 4 / 5 (implementation-readiness)
**Date**: 2026-06-13

---

**The status report is stale on three items** — #5623, #5674, and the substance of #5613 all shipped *today* (2026-06-13). Plan around current `main`, not the report.

## Plumbing verification (report §4 claims) — VERIFIED, the global-preamble feature is genuinely small
- `BaseSession._buildSystemPrompt()` — `base-session.js:1091-1107`. Folds `[sessionPreamble, CHROXY_CONTEXT_HINT_TEXT, skillsText].join('\n\n')`. The user preamble rides at the FRONT (1103). Exactly where a global harness preamble folds in.
- Repo→session folding upstream in `session-manager.js:776-887`: `foldPreamble(resolved.preamble, sessionPreamble)` → `effectiveSessionPreamble` (789-790), forwarded via `forwardPerSessionSettingsToProviderOpts` (879-887).
- `set_session_preamble` runtime wire path exists (`setSessionPreamble` at base-session.js:949).
- `BASE_SESSION_OPT_KEYS` picker (base-session.js:125) means a new ctor opt propagates to every provider for free.

**Conclusion:** harness preamble = config-read + one more `foldPreamble` call, not a plumbing build.

## Item-by-item
- **Global harness preamble — S.** `config.js` add `harnessPreamble` to `CONFIG_SCHEMA`+`validateConfig` (copy `validateBillingBlock`); `session-manager.js:776-816` fold before repo: `foldPreamble(harness, foldPreamble(repo, session))`. Risk: shared 4000-char cap — a fat harness preamble eats the repo/session budget. Provider-specific notes = M and optional, skip for v1. No protocol/client changes.
- **#5631 — L (deceptively large, cross-package).** Spans 4 packages. `models.js` pins opus 4-7 (current 4-8); dashboard `model-pricing.ts:28-41` badly stale (3.5/3.7 era, zero 4.x). Two independent pricing tables (`server/models.js` vs `dashboard/model-pricing.ts`). **Split:** (a) S quick win — opus→4-8 + dashboard 4.x rows; (b) L — unify behind discovery. Don't do (b) blind.
- **#5613 — DONE (verify & close).** Shipped via #5737; `handleSessionRole` shared in `store-core/handlers/index.ts:1547`. Close it.
- **#5623 — DONE.** Closed today; subsumed by #5737's re-emit.
- **#5674 — DONE.** Closed today via #5694. Report listing it open is stale.
- **#5622 — M.** Confirmed `ws-auth.js:559-564` runs `createKeyPair()`+`deriveSharedKey()`+`deriveConnectionKey()` synchronously per connect. Cheap fix (S/M): concurrency gate + `setImmediate` yields. Proper fix (L): worker_thread pool (bigger blast radius — sync crypto crosses a thread boundary). Auth-critical; gate is the right unattended scope.
- **#5668 — S (desktop/Rust).** `speech.rs:114` sets `.stderr(Stdio::null())`; early exit emits a bare `voice_stopped` (167). Fix: `Stdio::piped()`, check exit status after `child.wait()`, emit `voice_error` (struct already exists) before `voice_stopped`. Needs a desktop rebuild to verify.
- **resume_budget — S+protocol (M).** Needs a new wire type (`budget_resume_ack`); no such type exists. Reusing `budget_resumed` injects a false "resumed" chat event. Protocol + both clients. Defer.
- **EADDRINUSE cap — S (trivial).** `supervisor.js:33` bump the constant.
- **question-answer toolUseId — leave it.** Legacy single-session subtlety.

## Top 5 findings
1. Report stale on 3 of 6 friction items (#5613/#5623/#5674). Reconnect cluster mostly done — only #5622 remains.
2. #5631 is the deceptively-large item — 4 packages, two pricing tables. Split it.
3. Global harness preamble = best ROI, verified S, server-only, no ripple.
4. resume_budget dreg is a protocol change in disguise (no `budget_resume_ack` type). Defer.
5. #5622 is auth-critical — concurrency gate (S/M) is the right unattended scope; worker pool is a deliberate call.

## Recommended build order
1. Global harness preamble (S) → 2. #5631 quick-win half (S) → 3. #5668 mic surfacing (S, batch with a desktop rebuild) → 4. #5622 concurrency gate (M) → 5. EADDRINUSE cap (S). **Defer:** #5631 discovery-unification (L), resume_budget ack (M), toolUseId fallback. Verify-and-close #5613.

## Verdict: 4 / 5
Plumbing claims check out exactly; harness preamble is genuinely small + server-local; half the friction list already shipped. Two traps: #5631 is a multi-package pricing iceberg mislabeled cleanup, and two "small" dregs are secretly protocol/cross-client changes.
