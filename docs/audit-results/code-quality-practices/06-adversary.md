# Adversary's Audit: Codebase-Wide Security

**Agent**: Adversary -- Red-team security engineer who thinks like an attacker
**Overall Rating**: 3.5 / 5
**Date**: 2026-03-15

---

## Section Ratings

| Area | Rating | Summary |
|---|---|---|
| Authentication & Authorization | 4/5 | Solid design with a few material gaps |
| Cryptography | 4/5 | Good primitives, one nonce-integrity concern |
| File Operations & Path Traversal | 3/5 | Sound; scope boundary concern |
| Input Validation & Injection | 4/5 | Schema-gated; shell injection surface properly closed |
| WebSocket Protocol Abuse | 3/5 | Rate-limit bypass exists; permission replay risk |
| Information Disclosure | 3/5 | Token in plaintext on disk; git metadata leaked globally |
| Privilege & Sandbox Escalation | 2/5 | Auto-mode bypasses permission; CHROXY_TOKEN in child env |
| Dashboard XSS | 3/5 | DOMPurify used but one fragile injection path |

---

## Finding 1 — CRITICAL: CHROXY_TOKEN Passed to Every Child Process

**File:** `packages/server/src/cli-session.js:130-133`

The permanent API token is injected into every `claude` child process via `CHROXY_TOKEN` env var. Any tool Claude executes can read `process.env` and exfiltrate the token. Attack chain: prompt Claude to run `echo $CHROXY_TOKEN` → full server takeover.

**Recommendation:** Use a separate, short-lived, hook-scoped secret for the permission endpoint.

---

## Finding 2 — HIGH: `localhostBypass` Defaults to `true` — Encryption Skipped Locally

**Files:** `packages/server/src/ws-server.js:300`, `ws-history.js:51`

Any loopback connection bypasses E2E encryption. The dashboard (Tauri on 127.0.0.1) always connects without encryption. No CLI flag to disable the bypass.

**Recommendation:** Make `localhostBypass` a configurable option with documentation.

---

## Finding 3 — HIGH: API Token Written in Plaintext to `~/.chroxy/connection.json`

**File:** `packages/server/src/server-cli.js:357-365`

Full plaintext token written on every server start with `0o600` mode. Risks: same-UID process reads, cloud sync, backup tools.

**Recommendation:** Write redacted version. Use pairing URL instead of static token in `connectionUrl`.

---

## Finding 4 — HIGH: Rate Limiting Excluded for `permission_response`

**File:** `packages/server/src/ws-server.js:799-805`

Any authenticated client can send unlimited `permission_response` messages. Combined with predictable `requestId` (Finding 5), a rogue client can race-resolve permissions.

**Recommendation:** Apply a separate, relaxed rate limit (60/min) on permission responses.

---

## Finding 5 — HIGH: `requestId` Is Predictable — Permits Permission Race

**File:** `packages/server/src/ws-permissions.js:83`

`requestId` format is `perm-N-TIMESTAMP` — predictable counter + timestamp. A rogue authenticated client can pre-send responses to future permission requests.

**Recommendation:** Use `randomUUID()` for `requestId`. Scope resolution to primary client only.

---

## Additional Findings

- **`safeTokenCompare` short-circuit**: The final `&&` chain is not constant-time due to JS short-circuit evaluation. Minor timing oracle.
- **`list_directory` exposes entire home**: Any authenticated client can browse `~/.ssh/`, `~/.aws/`, etc. May be intentional but should be documented.
- **Dashboard HTML meta injection**: `http-routes.js:304` injects config via template string in single-quote context. Currently safe (only numbers/booleans) but fragile if strings are added.
- **Git commit message length uncapped**: `execFileAsync` with uncapped user input. No injection risk (execFile not shell) but memory pressure possible.
- **`localhostBypass` has no runtime disable**: Not exposed through CLI or config.
