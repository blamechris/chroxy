# Guardian's Audit: Workspace Extraction (#2518, #2510)

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages
**Overall Rating**: 3.2/5
**Date**: 2026-03-19

## Methodology

Evaluated both issues through the lens of failure modes, rollback safety, and operational risk. Focused on what breaks silently, what's hard to debug, and what wakes you up at 3am.

## Finding 1: Build-Time Safety for #2518

**Severity**: Medium (silent failure risk)

The server already handles a missing dashboard gracefully -- `http-routes.js` returns a 404 with a helpful message when `dashboardDistPath` doesn't resolve. This is good existing behavior.

Post-move, the risk shifts from "missing dashboard" to "silent path resolution failure":

- `path.resolve(__dirname, '../dashboard/dist')` becomes `path.resolve(__dirname, '../../dashboard/dist')` or similar
- If the path is wrong, the server starts fine but serves 404s for all dashboard routes
- The Tauri desktop app shows a blank white screen (no error, no crash, just nothing)
- `bundle-server.sh` silently copies nothing if the source path is wrong (`cp -R` on a nonexistent source just... doesn't copy)

**Mitigation**: Add a startup assertion in `http-routes.js` that verifies `dashboardDistPath` exists and contains `index.html`. Log a clear warning if not. This is a 5-line fix that prevents hours of debugging.

## Finding 2: Nuclear Scenario for #2510

**Severity**: Critical (architectural risk)

The worst-case scenario for #2510 is premature abstraction over divergent code. Here's what "divergent" actually means:

### Control flow differences

**App handler** (`connection.ts`):
```
switch (message.type) {
  case 'stream_start': ...
  case 'stream_delta': ...
}
```

**Dashboard handler** (`ws-handler.ts`):
```
const HANDLERS = new Map([
  ['stream_start', handleStreamStart],
  ['stream_delta', handleStreamDelta],
])
```

These aren't cosmetically different -- they have different extension patterns, different error boundaries, and different debuggability characteristics.

### State shape differences

**App**: Messages are arrays in sub-stores, accessed via `useSessionStore.getState().messages`
**Dashboard**: Messages are maps keyed by session ID, accessed via `store.getState().sessions[sessionId].messages`

A shared handler that writes to "the message list" needs completely different state mutation logic.

### Side effect differences

**App-only side effects**: Push notification registration, Haptic feedback, SecureStore writes, React Navigation
**Dashboard-only side effects**: Tauri IPC, localStorage, browser notifications, xterm.js direct writes

Abstracting over these creates a dependency injection surface that's larger than the shared code it replaces.

## Finding 3: Encryption Nonce State Is a Ticking Bomb

**Severity**: Critical (data integrity risk)

Both app and dashboard maintain E2E encryption state with mutable nonce counters:

- `sendNonce` / `recvNonce` are module-level mutable state
- Each encrypted message increments the nonce
- Nonce must be monotonically increasing -- reuse = decryption failure
- Nonce desync = silently dropped messages (decryption fails, message discarded)

During extraction to store-core:

1. If nonce state is accidentally shared between module instances (ESM singleton behavior in monorepo), both consumers could increment the same counter
2. If nonce state is duplicated, each consumer has independent counters that could drift
3. If the extraction changes module initialization order, nonces could start from different values

This is the kind of bug that:
- Doesn't show up in tests (tests don't typically test multi-instance encryption state)
- Doesn't show up immediately (first few messages work, drift causes failures later)
- Is extremely hard to debug (messages silently disappear, no error logged)

**Mitigation**: Add nonce monotonicity assertions -- every decrypt should verify nonce > last_nonce. Log and alert on any violation. This should be added BEFORE extraction, not during.

## Finding 4: No Version Mismatch Risk in Monorepo

**Severity**: Low (non-issue in current setup)

In a published-package world, version mismatches between store-core and consumers would be a major risk. In a monorepo with workspace links, all packages always use the same version. This is a non-issue.

However, the config injection contract (server -> dashboard via `<meta>` tag) does need schema validation. Currently:

- Server injects arbitrary JSON into the meta tag
- Dashboard parses it with `JSON.parse()` and trusts the shape
- No validation, no versioning, no fallback for missing fields

If a server update adds/removes config fields that the dashboard expects, the dashboard breaks silently. This isn't caused by the extraction but is exposed by it -- moving dashboard to its own package makes the contract boundary explicit.

**Mitigation**: Add a Zod schema for the config injection contract in `@chroxy/protocol`. Validate on both sides. This is 20 lines of code and prevents a class of silent failures.

## Finding 5: Rollback Risk Assessment

**Severity**: Varies by issue

### #2518 rollback: LOW RISK
- File moves are trivially reversible (`git revert`)
- Path updates are mechanical
- No logic changes, no behavior changes
- Rollback = move files back, revert path edits

### #2510 rollback: HIGH RISK
- Deep coupling between store-core handlers and both consumers
- Adapter layer woven into state management
- Test rewiring is extensive
- Rollback touches every changed file in 3 packages
- Partial rollback is nearly impossible -- it's all or nothing

This asymmetry is another argument for doing #2518 first (easy to undo) and being very cautious with #2510 (hard to undo).

## Recommendation

1. **Converge handlers before extracting** -- make app and dashboard handlers use the same control flow pattern (both Map-based or both switch-based) BEFORE attempting extraction. This reduces the abstraction surface.
2. **Add nonce monotonicity assertions NOW** -- before any encryption-adjacent code moves. This is a safety net that should exist regardless of extraction.
3. **Add config schema validation** -- define the server->dashboard config contract in `@chroxy/protocol` with Zod.
4. **Do #2518 with startup path assertion** -- verify dashboardDistPath exists at server startup.
5. **Approach #2510 with explicit rollback checkpoints** -- define "done" criteria for each phase and verify before proceeding.
