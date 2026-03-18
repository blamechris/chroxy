# Guardian's Audit: Chroxy v0.6.0 Tech Debt

**Agent**: Guardian
**Overall Rating**: 3.1/5
**Date**: 2026-03-18

## Perspective

The Guardian examines the codebase for safety, security, error handling, and crash recovery. Asks: *what happens when things go wrong?*

---

## 1. Race Conditions — EnvironmentManager (1.5/5) **HIGHEST PRIORITY**

### Zero concurrency guards
`environment-manager.js` (743 lines) manages Docker containers for development environments. It has **no mutex, semaphore, or queue** protecting concurrent operations. Multiple WebSocket clients can trigger:

- **Concurrent create**: Two clients calling `createEnvironment()` simultaneously can allocate the same port, create conflicting container names, or corrupt the environment registry.
- **Create-during-destroy**: A `destroyEnvironment()` running in parallel with `createEnvironment()` can leave orphaned containers or dangling network attachments.
- **Concurrent snapshot**: `snapshotEnvironment()` calls `docker commit` while the container may be in an inconsistent state from a parallel `restoreEnvironment()`.
- **Restore-during-use**: `restoreEnvironment()` stops and replaces a container that may have active exec sessions.

**Impact**: Data loss, orphaned containers, port conflicts, corrupted environment state.

**Recommendation**: Add per-environment mutex using a simple Map of Promises (no external dependency needed). Operations on the same environment ID must serialize.

---

## 2. Security Findings (2.5/5)

### SEC-01: _authFailures Map unbounded
`ws-server.js` tracks authentication failures in a `Map` keyed by IP address. This Map is never pruned. An attacker cycling through source IPs (trivial with IPv6 or behind a proxy) can grow this Map indefinitely until the process runs out of memory.

**Recommendation**: Cap the Map size (e.g., 10,000 entries) with LRU eviction, or use a time-bucketed counter that resets periodically.

### SEC-02: DevContainer mounts not validated
`createEnvironment()` accepts a DevContainer spec that can include volume mounts. The `containerEnv` keys and mount paths are passed directly to Docker without validation. A malicious or misconfigured spec could:
- Mount the host's home directory into the container
- Mount `/etc/passwd`, SSH keys, or cloud credentials
- Set environment variables that override container security settings

**Recommendation**: Validate mount sources against an allowlist (project directory only). Sanitize environment variable keys to alphanumeric + underscore.

### SEC-03: handler-utils.js path traversal surface
`handler-utils.js` validates file paths for the file operation handlers. While it does check for `..` traversal, the validation is not tested. A bypass would allow reading/writing arbitrary files on the host.

---

## 3. Error Handling (3.0/5)

### Fire-and-forget Docker operations
Several Docker operations in `environment-manager.js` use `.catch(() => {})` or no error handling:
- `docker stop` during cleanup
- `docker network rm` during teardown
- `docker exec` for health checks

Failed cleanup operations leave resources allocated. Over time, this accumulates orphaned containers and networks.

### Non-atomic environment restore
`restoreEnvironment()` follows this sequence:
1. Stop current container
2. Remove current container
3. Create new container from snapshot
4. Start new container

If step 3 or 4 fails, the environment is destroyed with no rollback. The user loses their running environment and the snapshot.

**Recommendation**: Keep the old container until the new one is verified running. Only remove the old container after successful health check on the new one.

### Supervisor IPC error handling
`supervisor.js` sends IPC messages to the child process without try/catch. If the child has crashed but the supervisor hasn't detected it yet (race window between crash and `exit` event), the IPC send throws and can crash the supervisor itself.

---

## 4. Resource Leaks (3.5/5)

### Containers survive crashes
If the server process crashes (OOM, uncaught exception, SIGKILL), running environment containers are not stopped. There is no reconciliation on startup — the server does not check for orphaned containers from a previous run.

**Recommendation**: On startup, enumerate containers with a `chroxy-env-` prefix label and reconcile against the persisted environment state. Stop/remove any containers not in the registry.

### WebSocket connection cleanup
When a WebSocket connection is closed abnormally (network drop without close frame), the connection lingers in the `_clients` Map until the heartbeat timeout (30 seconds). During this window, messages are queued for a dead connection, consuming memory.

---

## 5. Crash Recovery (3.5/5)

### Session state persistence gaps
`session-manager.js` persists session state to disk, but the write is not atomic (no write-to-temp-then-rename). A crash during the write can corrupt the state file, losing all session data.

### No health check for environment containers
After creating an environment, the server assumes the container is healthy. There is no readiness probe. If the container's entrypoint fails, the environment appears "running" in the UI but is actually dead.

---

## Summary

The EnvironmentManager concurrency issue is the highest-priority finding in this audit. It is a correctness bug, not just a code quality concern — concurrent operations will produce incorrect results. The security findings (SEC-01 through SEC-03) are medium priority but straightforward to fix. Error handling in Docker operations needs attention to prevent resource accumulation.

| Area | Rating | Priority |
|------|--------|----------|
| EnvironmentManager races | 1.5/5 | **Critical** |
| Security (auth, mounts, paths) | 2.5/5 | **High** |
| Error handling | 3.0/5 | Medium |
| Resource leaks | 3.5/5 | Medium |
| Crash recovery | 3.5/5 | Low |
