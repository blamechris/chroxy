# Skeptic's Audit: Chroxy v0.6.0 Tech Debt

**Agent**: Skeptic
**Overall Rating**: 2.3/5
**Date**: 2026-03-18

## Perspective

The Skeptic examines the codebase for dead code, stale abstractions, documentation drift, and anything that exists "just because it always has." Asks: *does this still earn its place?*

---

## 1. Dead Code & Backward-Compat Shims (1.5/5)

### tunnel.js shim (5 lines)
`packages/server/src/tunnel.js` is a trivial re-export shim left over from the tunnel refactor. It re-exports from `cloudflare-tunnel.js` and serves no purpose other than avoiding import path updates. All internal consumers should import directly.

### ws-file-ops.js shim (2 lines)
`packages/server/src/ws-file-ops.js` is a 2-line file that re-exports from the split modules (`ws-file-read.js`, `ws-file-write.js`). Created during the file-ops extraction but never cleaned up. No external consumers need the aggregated import.

### Dead re-exports in ws-message-handlers.js
The message handler registry still re-exports symbols that were moved to dedicated handler modules. These re-exports are not imported by any file — verified by grep. They inflate the module's export surface and confuse IDE auto-import.

### Legacy cliSession code path
`session-manager.js` still contains branching logic for the removed `cli-session.js` provider. The CLI headless mode was removed in v0.2.0, but conditional checks for `session.type === 'cli'` persist in at least 3 locations.

### ws-schemas.js (105 lines)
The schema validation module duplicates structure definitions that already exist as TypeScript types in the dashboard and app. The server never validates outbound messages against these schemas in production — they are only used in tests, and even there, coverage is partial.

---

## 2. Stale Abstractions (2.0/5)

### Message handler duplication (~4,480 lines)
The most significant abstraction failure in the codebase. `packages/app/src/store/message-handler.ts` (2,271 lines) and `packages/server/src/dashboard-next/src/store/message-handler.ts` (2,209 lines) implement the same WebSocket message parsing, state management, and event handling — independently. They have diverged in non-obvious ways:

- App handler has plan-mode detection that dashboard lacks
- Dashboard handler has enriched-tab logic that app lacks
- Error recovery paths differ
- `createEmptySessionState()` returns slightly different shapes

Every new feature requires parallel implementation in both handlers. This is the single biggest source of bugs and wasted effort.

### Diverged createEmptySessionState
The app and dashboard define `createEmptySessionState()` independently. The app version includes `planMode` and `voiceInput` fields. The dashboard version includes `enrichedTabs` and `terminalScrollback`. Neither is a superset of the other. State shape divergence causes subtle bugs when sessions are shared across clients.

### Duplicate crypto implementations
`packages/server/src/crypto.js` (135 lines) implements encryption/decryption using `tweetnacl` (XSalsa20-Poly1305). The app's `store-core.ts` also implements encryption, with its own key derivation. These should share a single implementation.

---

## 3. Inconsistent Logging (2.5/5)

### 312 raw console calls across 30 files
The codebase has `createLogger` utility but uses it inconsistently. A grep reveals:
- `console.log`: ~180 occurrences
- `console.error`: ~85 occurrences
- `console.warn`: ~47 occurrences

These bypass the structured logging that `createLogger` provides (level filtering, timestamps, component tags). Debug statements mixed with intentional user-facing output. No way to control verbosity at runtime.

Key offenders:
- `ws-server.js`: 28 raw console calls
- `session-manager.js`: 22 raw console calls
- `server-cli.js`: 19 raw console calls
- `environment-manager.js`: 15 raw console calls

---

## 4. Documentation Drift (2.5/5)

### AES-GCM claim (factually wrong)
`docs/architecture/reference.md` states the E2E encryption uses AES-256-GCM. The actual implementation in `crypto.js` uses `tweetnacl`'s `secretbox` — which is XSalsa20-Poly1305. This is not a cosmetic issue; it describes a fundamentally different algorithm and could mislead security reviewers.

### Phantom files in reference.md
The architecture reference lists files that no longer exist:
- `packages/server/src/pty-session.js` (removed in v0.2.0)
- `packages/server/src/tmux-manager.js` (removed in v0.2.0)
- `packages/server/src/terminal-output.js` (consolidated into session output)

### Stale env var documentation
`config.js` documents 27 environment variables. At least 3 are no longer read by any code path: `CHROXY_TRANSFORMS`, `CHROXY_SANDBOX`, `CHROXY_PTY_SHELL`.

---

## 5. Dependency Issues (3.0/5)

### expo-secure-store in root package.json
`expo-secure-store` appears in the root `package.json` dependencies. It is a React Native native module and should only be in `packages/app/package.json`. Its presence in root causes confusing hoisting behavior.

### dotenv as production dependency
`dotenv` is listed in `dependencies` rather than `devDependencies` in the server package. The server reads config via `config.js` which has its own env loading — `dotenv` is only used in development/testing.

---

## Summary

The codebase carries significant dead weight from prior architectural phases. The message handler duplication is the most expensive ongoing cost. The backward-compat shims are trivial to remove but signal a pattern of incomplete cleanup. Documentation drift undermines trust in the reference material.

| Area | Rating | Priority |
|------|--------|----------|
| Dead code / shims | 1.5/5 | Medium |
| Stale abstractions | 2.0/5 | **High** |
| Logging consistency | 2.5/5 | Medium |
| Documentation drift | 2.5/5 | Medium |
| Dependencies | 3.0/5 | Low |
