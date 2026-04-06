# Master Assessment: Chroxy v0.6.8 Full Codebase Audit

**Audit Date**: 2026-04-05
**Target**: Entire Chroxy codebase (v0.6.8) — server, app, desktop, protocol, store-core
**Agent Panel**: 8 agents (4 core + 4 extended)
**Aggregate Rating**: **3.2 / 5**

---

## a. Auditor Panel

| # | Agent | Perspective | Rating | Key Contribution |
|---|-------|-------------|--------|-----------------|
| 1 | Skeptic | Claims vs reality, false assumptions | 3.0/5 | Session token never validated on reconnect; nonce reuse |
| 2 | Builder | Implementability, effort, dependencies | 4.1/5 | Silent handler errors; session destroy race; git path validation |
| 3 | Guardian | Safety, failure modes, race conditions | 2.5/5 | Nonce reuse = broken E2E crypto; TOCTOU; replay attack |
| 4 | Minimalist | YAGNI, complexity reduction | 3.0/5 | @chroxy/protocol package overhead; handler fragmentation |
| 5 | Adversary | Attack surface, abuse cases | 2.8/5 | Shell injection in permission hook; symlink TOCTOU; rate limit bypass |
| 6 | Futurist | Extensibility, debt trajectory | 4.1/5 | Protocol schema drift; client capability gap; Docker silent failures |
| 7 | Tester | Testability, coverage gaps | 3.2/5 | Handler modules untested; no encrypted integration test |
| 8 | Operator | UX walkthrough, error states | 3.2/5 | Onboarding token confusion; silent permission expiry |

**Aggregate**: (3.0 + 4.1 + 2.5 + 3.0 + 2.8 + 4.1 + 3.2 + 3.2) / 8 = **3.24 / 5**

Core panel weight 1.0x: (3.0 + 4.1 + 2.5 + 3.0) / 4 = 3.15
Extended panel weight 0.8x: (2.8 + 4.1 + 3.2 + 3.2) / 4 = 3.33

Weighted aggregate: **(4 × 3.15 + 4 × 3.33 × 0.8) / (4 + 4 × 0.8) ≈ 3.2 / 5**

---

## b. Consensus Findings

Items where 4+ agents agree — high confidence:

### 1. Nonce Reuse on Reconnect (6/8 agents)

**Skeptic, Guardian, Adversary, Tester, Builder (implied), Futurist (implied)** all flagged this.

The E2E encryption nonce counter resets to 0 on every new WebSocket connection. Because the shared key is derived once from the DH handshake and persisted, every reconnect reuses `(key, nonce=0)`. XSalsa20-Poly1305 is a stream cipher; reusing a nonce with the same key allows an attacker who captures two sessions to XOR ciphertexts and recover the keystream. If either plaintext is known (e.g., the deterministic auth handshake), the other is fully recovered.

**Evidence**: `packages/store-core/src/crypto.ts` — nonce counter is session-local; no persistence or advancement mechanism across reconnects.

**Action**: Persist nonce counter across reconnects, or derive a fresh per-connection sub-key via HKDF with a random salt.

### 2. Silent Handler Errors (5/8 agents)

**Builder, Tester, Skeptic, Operator, Guardian** all noted that handler errors are not propagated as structured WS error responses.

**Evidence**: `packages/server/src/handlers/` — catch blocks log errors but do not call `ws.send(errorResponse)`.

**Action**: Add `sendError(ws, requestId, code, message)` utility; audit all handlers.

### 3. TOCTOU in File Operations (4/8 agents)

**Guardian, Adversary, Builder, Tester** all flagged the check-then-use race in `ws-file-ops/reader.js`.

**Evidence**: `packages/server/src/ws-file-ops/reader.js` — path validation uses string check, then separate `fs.readFile()`. Symlink substitution possible between check and read.

**Action**: Use `fs.realpath()` to resolve symlinks before path check; hold open file descriptor across check and read.

### 4. Onboarding and Error Message UX (4/8 agents)

**Operator, Skeptic, Builder, Tester** all noted first-time user friction points: Node version silent failure, token/URL confusion, and non-actionable error messages.

**Action**: Add Node version check in `cli.js`; improve ConnectScreen error messages; map WS close codes to user-readable messages.

---

## c. Contested Points

### Is @chroxy/protocol worth keeping?

**Minimalist** says no — the server is JavaScript and can't use TypeScript types; the Zod schemas could live in `store-core`.

**Futurist** says the schema coverage CI check is the priority, not eliminating the package — the package structure is not the root problem.

**Assessment**: Both are right in different ways. The package structure is not urgent, but the schema drift problem (Futurist's concern) is real and worsening. The path of least resistance is to fix drift first (CI check), then evaluate consolidation. Minimalist's cut is valid but not urgent.

### Is the provider registry over-abstracted?

**Minimalist** says yes — 4 of 6 providers are near-identical wrappers.

**Futurist** says the extensibility is justified — adding an OpenAI-compatible provider would be trivial.

**Assessment**: Futurist is right here. The registry is a good pattern and the duplication is not high enough to justify refactoring. Defer.

---

## d. Factual Corrections

| Claim | Correction | Found By |
|-------|-----------|----------|
| "Sessions are authenticated" (docs) | Bearer token auth only; session token not validated on reconnect | Skeptic |
| "E2E encrypted" (README) | True at setup; broken on reconnect due to nonce reuse | Guardian |
| "Rate limited" (docs) | Rate limiter uses source IP; all tunnel traffic appears as `127.0.0.1` | Adversary |
| "Permission hook sandboxed" (docs) | Hook binary executed without parameter sanitization; shell injection possible | Adversary |

---

## e. Risk Heatmap

```
        IMPACT
        Low     Medium    High    Critical
      +-------+---------+--------+---------+
High  |       | schema  | silent | nonce   |
      |       | drift   | handler| reuse   |
L     |       |         | errors |         |
I     +-------+---------+--------+---------+
K Med | perf  | rate    | TOCTOU | hook    |
E     | prot. | limiter | symlink| inject. |
L     | pkg   | bypass  |        |         |
I     +-------+---------+--------+---------+
H Low | handler| settings| no     | no      |
O     | frag. | UX      | node   | replay  |
O     |       |         | check  | protec. |
D     +-------+---------+--------+---------+
```

**Critical × High**: Nonce reuse (must fix before production use)
**High × High**: Shell injection in permission hook
**Med × High**: Symlink TOCTOU, rate limiter bypass
**High × Medium**: Schema drift, silent handler errors

---

## f. Recommended Action Plan

### Phase 1 — Security (1-2 weeks)

| Priority | Finding | Effort | Owner |
|----------|---------|--------|-------|
| P0 | Fix nonce reuse: persist counter or derive per-conn sub-key | 4h | Crypto |
| P0 | Add replay protection: reject non-monotone nonce counters | 2h | Crypto |
| P1 | Fix hook injection: pass params via JSON stdin, not shell args | 3h | Server |
| P1 | Fix TOCTOU: use `realpath()` before path validation | 2h | Server |
| P2 | Fix rate limiter: use `CF-Connecting-IP` header | 1h | Server |
| P2 | Mask `apiToken` in debug config logging | 30m | Server |
| P2 | Add max-length constraints to WS message Zod schemas | 2h | Protocol |

### Phase 2 — Reliability (2-3 weeks)

| Priority | Finding | Effort | Owner |
|----------|---------|--------|-------|
| P1 | Add `sendError()` to all handlers | 4h | Server |
| P1 | Fix session destroy race (add `_destroying` guard) | 1h | Server |
| P1 | Validate git file op paths against workspace root | 2h | Server |
| P2 | Add Docker-specific error codes | 2h | Server |
| P2 | Add supervisor push notification on exit | 1h | Server |
| P2 | Session message history max size cap | 1h | Server |

### Phase 3 — Developer Experience (1-2 weeks)

| Priority | Finding | Effort | Owner |
|----------|---------|--------|-------|
| P1 | Add Node version check in `cli.js` | 15m | Server |
| P1 | Fix onboarding token confusion in ConnectScreen | 1h | App |
| P1 | Show permission expiry toast | 1h | App |
| P2 | Map WS error codes to user messages | 2h | App |
| P2 | Add Settings screen section groupings | 1h | App |
| P2 | Client capabilities in auth message | 3h | Protocol |

### Phase 4 — Testing & Debt (ongoing)

| Priority | Finding | Effort | Owner |
|----------|---------|--------|-------|
| P1 | Add handler unit tests (all 9 handler files) | 1 day | Server |
| P1 | Add encrypted E2E integration test | 3h | Server |
| P1 | Add supervisor max-retry enforcement test | 1h | Server |
| P2 | Add CI schema coverage check | 2h | CI |
| P3 | Evaluate @chroxy/protocol consolidation | 4h | Protocol |
| P3 | Decompose WsServer (#2147) | XL | Server |
| P3 | Decompose SessionManager (#2148) | XL | Server |

---

## g. Final Verdict

**Aggregate Rating: 3.2 / 5**

Chroxy v0.6.8 is a capable remote terminal application with solid architecture and an impressive feature set for its stage. The monorepo structure, WebSocket protocol design, session management, and test coverage breadth are all strengths. The project is clearly maintained actively.

However, it is **not ready for production use as a security-critical tool** until the nonce reuse issue is resolved. The E2E encryption is broken in practice: every mobile reconnect (which happens on every connection drop — common over cellular) reuses nonce 0 with the same key, allowing passive decryption by a network observer. This is not a theoretical concern; it is a straightforward known-plaintext attack. The README and documentation describe the system as "encrypted" without qualification, which is misleading.

The shell injection vulnerability in the permission hook is the second critical issue. Given that Chroxy runs Claude Code on arbitrary repositories, and Claude Code can be prompted to call tools with attacker-controlled parameters, the attack chain from prompt injection to RCE on the developer's machine is realistic.

Both critical issues have straightforward fixes (4-6 hours each). The rest of the findings are medium-priority operational improvements. The project should proceed with Phase 1 security fixes before any further feature development.

---

## h. Appendix — Individual Reports

| Report | Agent | Rating | Focus |
|--------|-------|--------|-------|
| [01-skeptic.md](01-skeptic.md) | Skeptic | 3.0/5 | Claims vs reality, token validation, nonce reuse |
| [02-builder.md](02-builder.md) | Builder | 4.1/5 | Handler errors, session races, file validation |
| [03-guardian.md](03-guardian.md) | Guardian | 2.5/5 | Crypto failure, replay, TOCTOU, supervisor |
| [04-minimalist.md](04-minimalist.md) | Minimalist | 3.0/5 | Protocol package overhead, handler fragmentation |
| [05-adversary.md](05-adversary.md) | Adversary | 2.8/5 | Shell injection, symlink attack, rate limit bypass |
| [06-futurist.md](06-futurist.md) | Futurist | 4.1/5 | Schema drift, capability negotiation, debt trajectory |
| [07-tester.md](07-tester.md) | Tester | 3.2/5 | Coverage gaps, integration tests, overflow tests |
| [08-operator.md](08-operator.md) | Operator | 3.2/5 | Onboarding, permission expiry, error messages |
