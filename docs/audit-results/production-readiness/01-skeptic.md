# Skeptic Audit — Cynical Systems Engineer

**Overall Rating: 3.2/5**

## Category Ratings

| Category | Rating | Notes |
|----------|--------|-------|
| Error Handling | 2.0/5 | Unhandled rejections in hot paths, missing global handler |
| Security | 3.5/5 | Solid token handling, but path validation broken on case-insensitive FS |
| Performance | 2.5/5 | PostAuthQueue memory leak, no backpressure monitoring |
| Observability | 1.0/5 | Near-zero structured metrics, silent failures everywhere |

## Key Findings

### 1. Unhandled Promise Rejections in Hot Paths
`server-cli.js` lacks a global `unhandledRejection` handler. Async errors in message processing, session creation, and tunnel setup can crash the process silently.

### 2. PostAuthQueue Memory Leak
When a client disconnects during the key exchange phase, the PostAuthQueue for that connection is never cleaned up. Over time with reconnection churn, these accumulate unbounded.

### 3. Respawn Guard Race Condition
`_respawnScheduled` is set *after* the spawn call, not before. If spawn throws synchronously or if multiple signals arrive in quick succession, duplicate respawns can occur.

### 4. Path Validation Broken on Case-Insensitive Filesystems
macOS APFS is case-insensitive by default. Path validation that relies on exact string comparison can be bypassed with case variations (e.g., `/Users/../USERS/`).

### 5. Supervisor Deploy Rollback Continues on Failure
When a rollback step fails during supervisor deploy, execution continues to the next step instead of exiting immediately. A failed rollback that silently proceeds leaves the system in an indeterminate state.

## Verdict

The server works for a dev tool used by its author. It is not production-ready for multi-tenant or untrusted-network deployment. The biggest gap is observability — when something goes wrong, there is almost no telemetry to diagnose it.
