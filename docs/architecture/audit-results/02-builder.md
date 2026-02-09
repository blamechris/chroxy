# Builder's Audit: In-App Iterative Development Architecture

**Agent**: Builder -- pragmatic full-stack developer who will implement this
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-09

---

## Executive Summary

This is an ambitious but fundamentally sound design. The core insight -- supervisor owns tunnel, server is a restartable child -- is correct and aligns well with how the code is already structured. However, several effort estimates are underscoped, there are missing glue components, and a few API design gaps need filling before this is codeable from the doc alone.

---

## Section-by-Section Ratings

| Section | Rating | Summary |
|---------|:------:|---------|
| 1. Vision & Problem Statement | 5/5 | Accurate, no issues. |
| 2. System Architecture Overview | 4/5 | Correct. Deploy script exit semantics need clarity. |
| 3. Supervisor Process | 4/5 | QR code dep problem unsolved. Supervisor self-update should be cut. |
| 4. Server Self-Update | 3/5 | State machine ownership unclear (who holds it?). `--resume` wiring is doable. |
| 5. Connection Persistence | 4/5 | `connectionPhase` is right but the refactor cascades to 4+ files. |
| 6. Mobile App Updates | 3/5 | Deferred to Phase 4, reasonable. expo-updates install is "Medium" not "Small". |
| 7. Build & Deploy Pipeline | 3/5 | Critical gap: deploy script uses SIGUSR2, not IPC. Lock lifecycle undefined. |
| 8. Safety & Reliability | 4/5 | Thorough. Excluded files check is a `diff | grep` one-liner. |
| 9. WS Protocol Extensions | 4/5 | Close code 4000 needs verification on React Native's WS implementation. |
| 10. Implementation Roadmap | 3/5 | Phasing correct. Effort estimates ~30-40% low. |

---

## Revised Effort Estimates

| Step | Description | Doc Estimate | Revised | Rationale |
|------|-------------|:---:|:---:|---|
| 1.1 | Build manifest + `/version` | Small | Small-Medium | Need deploy-manifest.js utility |
| 1.2 | Session serialization | Medium | Medium | Accurate |
| 1.3 | IPC drain protocol | Medium | Medium | Accurate but depends on 1.2 |
| 1.4 | `--supervised` mode | Medium | Medium | ~60-80 new lines in server-cli.js |
| 1.5 | Named Tunnel support | Medium | Medium | Accurate |
| 2.1 | Supervisor process | Medium | **Large** | QR dep, edge cases, PID management |
| 2.4 | Blue-green restart | Medium | **Medium-Large** | Distributed state machine coordination |
| 2.7 | Deploy script | Medium | **Large** | Change detection, validation, signaling, locks |
| 3.1 | `connectionPhase` enum | Medium | **Large** | Deep refactor of 1300-line store |
| 3.7 | `tunnel setup` command | Medium | Medium-Large | Interactive CLI with external tool orchestration |
| 4.1 | Install expo-updates | Small | **Medium-Large** | Requires native build, breaks Expo Go |
| 4.2 | Bundle serving | Medium | **Medium-Large** | Mini-CDN with expo-updates protocol compliance |

**Phase totals (developer-days):**
- Phase 1: 4-5 days (doc implies 3-4)
- Phase 2: 7-9 days (doc implies 5-6)
- Phase 3: 5-7 days (doc implies 4-5)
- Phase 4: 5-7 days (doc implies 3-4)
- **Total: 21-28 days** (doc implies 15-19)

---

## Missing Components

1. **`deploy-manifest.js`**: Read/write utility for `~/.chroxy/deploy-manifest.json` (~50-80 LOC)
2. **QR code in supervisor**: Can't use `qrcode-terminal` with zero npm deps. Allow one dep or delegate to child via IPC.
3. **Port conflict detection**: Check for stale server on port before spawn (~20 LOC)
4. **Graceful drain broadcast**: `WsServer.gracefulClose(code)` method that broadcasts before closing (~30 LOC)
5. **Extended health check**: `GET /health?deep=true` that verifies at least one CliSession is alive (~20 LOC)
6. **State file I/O utilities**: Shared atomic write helpers for all state files (~40-60 LOC)
7. **SIGUSR2 handler in supervisor**: Deploy script is not a child of supervisor -- needs signal path, not IPC
8. **Test coverage**: ~400-600 lines of new tests needed (supervisor, deploy, serialization, reconnection)

---

## File-by-File Code Changes Audit

### `server-cli.js` (~60-80 new lines, ~20 modified)
- Wrap tunnel block (lines 114-165) in `if (!config.supervised)`
- Replace SIGINT/SIGTERM handlers with IPC listeners in supervised mode
- Add `process.send({ type: 'ready', port })` after WsServer starts

### `cli-session.js` (~30-40 new lines)
- Add `serialize()` returning `{ claudeSessionId, cwd, model, permissionMode }`
- Add `resumeSessionId` constructor option
- Add `--resume` flag in `start()` args building

### `ws-server.js` (Phase 1-2: ~50 lines, Phase 4: ~80 more)
- `GET /version` route (10 lines)
- `serverCommit` in `auth_ok` (3 lines)
- `restart_request` handler (20-30 lines)
- `server_shutting_down` broadcast in `close()` (5 lines)

### `connection.ts` (~150-200 lines modified/added)
- `connectionPhase` enum replacing booleans
- Message queue with per-type TTL
- Close code 4000 handling in `onclose`
- Remove `clearConnection()` on retry exhaustion

### `App.tsx` (~10 lines)
- Navigation guard from boolean to phase-aware condition

---

## Critical Dependencies the Roadmap Misses

- Phase 2.7 (deploy script) depends on `deploy-manifest.js` (not listed as a step)
- Phase 2.1 (supervisor) depends on solving QR code dependency
- Phase 1.3 (IPC drain) depends on `SessionManager.drain()` (not listed)
- Phase 3.1-3.2 (connectionPhase) tightly coupled with App.tsx navigation guard
