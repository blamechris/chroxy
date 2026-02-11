# Guardian's Audit: Chroxy System

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages. Finds race conditions and nuclear scenarios.
**Overall Rating**: 3.3 / 5
**Date**: 2026-02-10

---

## Section Ratings

### 1. WebSocket Safety -- 3.5/5

**Strengths:**
- Auth enforcement solid: unauthenticated clients kicked after 10s timeout
- Model IDs validated against `ALLOWED_MODEL_IDS`, permission modes validated, tmux names regex-sanitized
- Draining mode blocks input while allowing in-flight permission responses
- Body size limit (64KB) on `/permission` POST prevents memory exhaustion
- 30s ping/pong keepalive catches dead connections

**Weaknesses:**
- **No message rate limiting** -- malicious client can flood server with messages
- **No message schema validation** beyond checking `msg.type`
- **Multi-client race on permission_response** -- first response wins, losing client gets no notification

### 2. Process Lifecycle -- 4/5

**Strengths:**
- Supervisor with bounded backoff (10 max restarts, 2s-10s delays)
- Deploy crash detection and automatic git rollback
- Drain protocol with 30s timeout + 2s serialization buffer
- Force-kill safety nets throughout: 5s then SIGKILL for child, 3s then SIGKILL for CliSession, 10s then SIGKILL for model change
- `heartbeatInterval.unref()` prevents keepalive from blocking exit

**Weaknesses:**
- Shutdown race: supervisor calls `tunnel.stop()` immediately after sending shutdown to child, then `process.exit(0)` after 1s -- child may outlive tunnel
- `process.exit(0)` is abrupt -- in-flight writes may be truncated

### 3. File System Safety -- 2.5/5 (CRITICAL)

**CRITICAL: Hardcoded `homedir()` paths -- no test isolation possible.**

`registerPermissionHookSync()` and `unregisterPermissionHookSync()` use `resolve(homedir(), '.claude', 'settings.json')` (lines 43, 85). No override mechanism exists. Consequences:
1. Tests contaminate real settings.json (P1 incident)
2. Multiple Chroxy instances race on same file (TOCTOU -- no inter-process coordination)
3. Crash leaves stale hooks -- orphaned entry causes 300s curl timeout hang

**No atomic writes:** `writeFileSync` used directly for settings.json, session-state.json, supervisor PID file, config file. Mid-write kill = corrupted JSON.

### 4. Tunnel Failure Modes -- 3.5/5

**Strengths:**
- Auto-recovery with bounded retries (3 attempts, 3s/6s/12s backoff)
- `intentionalShutdown` flag prevents recovery during controlled shutdown
- Named tunnel preserves URL after crash

**Weaknesses:**
- Quick tunnel URL change = hard disconnect for mobile clients
- 30s timeout on tunnel start -- if Cloudflare slow, silently kills process

### 5. Permission System -- 3/5

**Strengths:**
- SDK mode in-process permissions cleaner than HTTP hook pipeline
- 5-minute timeout with auto-deny on both paths
- AbortSignal handling for cancelled permissions

**Weaknesses:**
- **`allowAlways` silently treated as `allow`** -- user taps "Always Allow" expecting persistence, but decision is not persisted. Next invocation prompts again. UX deception.
- SDK mode: pending permissions not cleaned up if session destroyed mid-permission -- permission prompt stays in UI forever

### 6. Memory/Resource Leaks -- 3.5/5

**Strengths:**
- Session destroy calls `removeAllListeners()` on all types
- Timer cleanup thorough in destroy()
- Delta buffers bounded, history ring buffer capped at 100, message queue capped at 10
- Pending streams cleaned up on session destroy

**Weaknesses:**
- `deltaFlushTimer` in `_setupSessionForwarding` may not be cleared on session switch
- No explicit `ws.terminate()` in all error paths

---

## Top 5 Findings

1. **settings.json writes are critical single-point-of-failure** -- hardcoded path, no test isolation, no atomic writes, no inter-process coordination
2. **Stale hooks = 5-minute hang** -- crashed server's hook pointing to dead port causes all Claude sessions to hang on curl's 300s `--max-time`
3. **No rate limiting on WS messages** -- any authenticated client can flood server
4. **`allowAlways` silently discarded** -- users tap "Always Allow" but it doesn't persist
5. **`process.exit(0)` in supervisor shutdown** -- abrupt termination may truncate in-flight writes

---

## Verdict

The system shows good security instincts in many areas: auth timeouts, bounded backoff, drain protocols, keepalive. The critical weakness is the file system safety story around settings.json -- it's shared global state with no coordination, no atomic writes, and no test isolation. The stale hook problem (crashed server + 300s curl timeout) is the most operationally dangerous finding. Fix the file system safety issues before anything else.
