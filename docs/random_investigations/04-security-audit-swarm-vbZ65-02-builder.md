# Builder's Audit: Chroxy Security Architecture

**Agent**: Builder -- Pragmatic full-stack dev who estimates implementation effort
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-12

## Production-Readiness Rating: **3.5/5**

**Verdict**: 80% there. Critical gaps need 10.5 hours (1.5 days) to reach "good enough for private beta". Public production requires 24.5 hours (3 days).

## Section Ratings

### 1. Code Organization: 4/5
**Good**: Clean separation, EventEmitter pattern, no global state.
**Needs Work**: ws-server.js is 1880 LOC - extract rate limiter (50 LOC), permission broker (100 LOC).

### 2. Error Handling: 3/5
**Issue**: 38 silent catch blocks, no error boundaries for malformed WebSocket messages.
**Critical**: Permission hook failures logged but not surfaced to clients (cli-session.js:157-160).

### 3. State Management: 4/5
**Good**: Map-based session isolation, proper cleanup.
**Issue**: No memory limits on `_pendingPermissions` Map - DoS vector (ws-server.js:1182-1183).

### 4. Recovery Mechanisms: 4/5
**Good**: Exponential backoff everywhere, auto-respawn.
**Issue**: After max respawn (5), session dead forever with no user notification.

### 5. Testing Coverage: 2/5
**Gap Analysis**: 9553 LOC tests but NO tests for rate limit bypass, permission DoS, session isolation, or CSRF.

### 6. Documentation: 5/5
**Excellent**: Comprehensive protocol docs, architecture diagrams, QA log with coverage matrix.

## Top 5 Findings

### 1. No WebSocket Message Size Limits (HIGH) - ws-server.js:326
**Impact**: Single malicious client crashes server via 1GB JSON payload.
**Fix**: Add 1MB limit check before `JSON.parse()` (30 min)

### 2. Permission Request Memory Leak (HIGH) - ws-server.js:1612-1678
**Impact**: Unbounded `_pendingPermissions` Map. Attacker sends 10,000 permission requests → OOM.
**Fix**: Cap at 100 pending, auto-deny excess (1 hour)

### 3. No Input Sanitization for tmux Names (MEDIUM) - ws-server.js:847
**Impact**: Allows `../../etc/passwd` as session name. Not exploitable now but defense-in-depth missing.
**Fix**: Reject `..` in validation regex (15 min)

### 4. Token in Process Env Vars (MEDIUM) - cli-session.js:132-133
**Impact**: Visible in `ps aux` on multi-user systems.
**Fix**: Document as known limitation OR redesign IPC (3 days for full fix, 30 min for docs)

### 5. No CSRF on HTTP Endpoints (LOW) - ws-server.js:238
**Impact**: Evil website can probe `localhost:8765/health` for server presence.
**Fix**: Add Origin validation (1 hour)

## Missing Components (Production Blockers)

### 1. TLS/HTTPS Support (HIGH if no tunnel)
**Status**: Server runs HTTP only. `--tunnel none` mode exposes unencrypted WebSocket.
**Effort**: 1 day (200 LOC) for self-signed cert generation + HTTPS wrapper

### 2. Session Storage Encryption (MEDIUM)
**Status**: State serialized to plaintext JSON (mode 0o600).
**Effort**: 4 hours (100 LOC) for XChaCha20-Poly1305 encryption + keychain integration

### 3. Audit Logging (LOW)
**Status**: Console logs only. No persistent trail for auth failures, permission decisions.
**Effort**: 2 hours (50 LOC) for NDJSON audit log with 10MB rotation

## Concrete Recommendations by File

### ws-server.js (Priority: HIGH)
1. Line 326: Add 1MB message size limit (30 min)
2. Line 1612: Cap `_pendingPermissions` at 100 (1 hour)
3. Line 238: Add Origin validation for `/version` (1 hour)
4. Line 331: Log malformed JSON with client ID (15 min)

**Total**: 3 hours + 5 test cases (2 hours)

### cli-session.js (Priority: MEDIUM)
1. Line 157: Emit `error` event on hook failure (30 min)
2. Line 219: Emit `session_fatal` after max respawn (1 hour)
3. Line 269: Add 10-min hard timeout on `sendMessage` (2 hours)

**Total**: 3.5 hours + 3 test cases (1 hour)

### NEW: rate-limiter.js (Priority: MEDIUM)
Extract auth rate limiting + add input rate limiting (100/min per client) + session creation (10/min per IP).
**Effort**: 4 hours (200 LOC + tests)

### NEW: tls.js (Priority: HIGH if no tunnel)
Self-signed cert generation + HTTPS server wrapper.
**Effort**: 1 day (200 LOC + tests)

## Effort Summary

| File | LOC | Hours | Priority |
|------|-----|-------|----------|
| ws-server.js | 50 | 3 | HIGH |
| cli-session.js | 30 | 3.5 | MEDIUM |
| rate-limiter.js | 200 | 4 | MEDIUM |
| tls.js | 200 | 8 | HIGH (no tunnel) |
| config.js | 20 | 1 | LOW |
| audit-log.js | 50 | 2 | LOW |
| Tests | 300 | 6 | HIGH |
| **TOTAL** | **850** | **27.5** | |

## Path to Production

**Private Beta** (10.5 hours):
- Message size limit
- Permission cap
- Rate limiting
- Adversarial tests

**Public Production** (+14 hours):
- TLS support
- Audit logging
- Error hardening
