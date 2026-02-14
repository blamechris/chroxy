# Chroxy Final Codebase Audit (2026-02-14)

## Scope and method
- Reviewed server and app runtime paths end-to-end with focus on session routing, permissions, reconnect/replay, deploy/restart, and install/run ergonomics.
- Ran server test command(s) and inspected behavior under current environment constraints.
- Captured only issues with concrete code evidence and practical impact.

## Evidence summary
- `npm test -w @chroxy/server` and direct `node --test ...` runs produce large pass output but do not complete promptly in this environment because the default test set includes network/integration tests.
- Key source files audited:
  - `packages/server/src/ws-server.js`
  - `packages/server/src/sdk-session.js`
  - `packages/server/src/session-manager.js`
  - `packages/server/src/pty-manager.js`
  - `packages/server/src/server-cli.js`
  - `packages/app/src/store/connection.ts`
  - `packages/server/package.json`
  - `packages/server/tests/tunnel.integration.test.js`

## Findings (prioritized)

### 1) Session-scoped permission/question responses are routed by active session only (P0)
Evidence:
- App response payloads do not include `sessionId`: `packages/app/src/store/connection.ts:1931`, `packages/app/src/store/connection.ts:1941`
- Server routes permission responses to `client.activeSessionId` first and breaks: `packages/server/src/ws-server.js:704`
- SDK session silently ignores unknown permission IDs: `packages/server/src/sdk-session.js:422`
- Same active-session routing pattern exists for user questions: `packages/server/src/ws-server.js:881`

Impact:
- In multi-session use, a response can be delivered to the wrong session and dropped.
- If two sessions prompt concurrently, responses are ambiguous.

Opinion A (delivery):
- Assume prompts mostly happen on active session; keep payloads simple.

Opinion B (reliability):
- This is a correctness bug in core control flow and will surface as “frozen permissions” or stuck prompts.

Consensus:
- Add request routing maps in server: `requestId -> sessionId`.
- Include `sessionId` in app response payloads and enforce session match server-side.
- Add a regression test for cross-session permission/question concurrency.

---

### 2) “Always Allow” is treated as deny in SDK mode (P1)
Evidence:
- App sends `allowAlways`: `packages/app/src/store/connection.ts:1215`
- SDK only treats `decision === 'allow'` as allow; all else deny: `packages/server/src/sdk-session.js:430`
- No server-side normalization for `allowAlways`.

Impact:
- User intent is inverted in SDK mode; “Always Allow” behaves like deny.

Opinion A (delivery):
- Remove the UI option temporarily in SDK mode.

Opinion B (reliability):
- Normalize decision centrally so both SDK and hook flows behave consistently.

Consensus:
- Map `allowAlways -> allow` in `ws-server` before dispatch.
- Longer term: persist per-tool/per-session policy if “always” semantics are desired.

---

### 3) Stream delta batching key is not session-safe in app store (P1)
Evidence:
- Deltas are keyed by `messageId` only: `packages/app/src/store/connection.ts:481`, `packages/app/src/store/connection.ts:932`
- Message IDs are session-local (`msg-1`, `msg-2`, ...): `packages/server/src/sdk-session.js:102`, `packages/server/src/cli-session.js:254`
- Server already uses composite `sessionId:messageId` key to avoid this: `packages/server/src/ws-server.js:1084`

Impact:
- Concurrent streams from different sessions can overwrite/corrupt each other in client state.

Opinion A (delivery):
- Rare enough for casual use; defer.

Opinion B (reliability):
- Multi-session is a core feature; this directly undermines it.

Consensus:
- Change app pending delta key to composite `${sessionId}:${messageId}`.
- Add test coverage for simultaneous streams in two sessions with same `messageId`.

---

### 4) Default server test command unintentionally includes integration tests (P1)
Evidence:
- Test script: `node --test ./tests/*.test.js` in `packages/server/package.json`
- Glob includes `packages/server/tests/tunnel.integration.test.js`
- Integration suite requires `cloudflared` and network conditions.

Impact:
- Routine `npm test` can be slow/flaky/hang depending on environment.
- Developer feedback loop is slower than necessary.

Opinion A (delivery):
- Keep one command for simplicity.

Opinion B (reliability):
- Unit and integration tests should be separated for deterministic CI and local fast path.

Consensus:
- Split scripts explicitly:
  - `test:unit` for deterministic tests only
  - `test:integration` opt-in
  - `test` should default to unit

---

### 5) PTY mode hardcodes Homebrew tmux path (P1 for install portability)
Evidence:
- Hardcoded path use: `packages/server/src/pty-manager.js:63`, `packages/server/src/pty-manager.js:74`
- Other codepaths use `tmux` via PATH (`session-discovery`), creating inconsistent behavior.

Impact:
- Breaks PTY mode on Linux and non-Homebrew macOS setups.
- Contradicts “optional tmux mode” portability expectations.

Opinion A (delivery):
- Keep mac-focused assumption for now.

Opinion B (reliability):
- Simple to fix and directly improves install/run success.

Consensus:
- Resolve tmux binary once (PATH lookup + fallback list), store in config, use consistently everywhere.

---

### 6) Attached tmux sessions lose real working directory context (P2)
Evidence:
- `attachSession` stores `cwd: process.cwd()` instead of discovered tmux cwd: `packages/server/src/session-manager.js:304`
- Discovery already provides cwd: `packages/server/src/session-discovery.js:81`
- Command/agent listing relies on session cwd: `packages/server/src/ws-server.js:900`, `packages/server/src/ws-server.js:906`

Impact:
- Slash commands/agents/file operations can target wrong project context after attach.

Opinion A (delivery):
- Accept approximate cwd for first release.

Opinion B (reliability):
- Wrong cwd degrades core UX for attached sessions and confuses command discovery.

Consensus:
- Pass discovered `cwd` through attach flow and store per attached session.

---

### 7) Workspace start script points to legacy PTY entrypoint, not default SDK flow (P2)
Evidence:
- Workspace start script: `packages/server/package.json` -> `node src/index.js`
- `src/index.js` calls legacy `startServer` (PTY stack): `packages/server/src/index.js:6`
- Documented default path is CLI headless/SDK.

Impact:
- `npm run server` from workspace can launch a different architecture than expected.
- Increases onboarding friction and debugging confusion.

Opinion A (delivery):
- Keep for backward compatibility.

Opinion B (reliability):
- Start commands should reflect the recommended default to avoid drift.

Consensus:
- Align scripts with CLI entry (`src/cli.js start`) or clearly label legacy script names.

## High-value action plan
1. Fix session-scoped response routing and add concurrency tests (Findings 1, 2, 3).
2. Split unit vs integration test scripts and CI jobs (Finding 4).
3. Remove tmux path assumptions and preserve true attached cwd (Findings 5, 6).
4. Align start scripts to documented default architecture (Finding 7).

## Suggested feature tie-in to Chroxy core vision
- Once Findings 1-3 are fixed, multi-session self-iteration and in-place upgrades become significantly safer because control-plane actions (permissions/questions/streams) behave deterministically across concurrent sessions.
