# Skeptic's Audit: Chroxy Security Architecture

**Agent**: Skeptic -- Cynical systems engineer who cross-references claims against code
**Overall Rating**: 2.5 / 5
**Date**: 2026-02-12

## Verdict

**"Has good bones but missing critical organs"**

The authentication and rate-limiting are well-implemented, but there are **fundamental architectural vulnerabilities** that make several security claims false or incomplete. The system will resist casual attacks but fails under targeted scrutiny.

## Section Ratings

### 1. Authentication System: 2/5 ⚠️

**Claims vs Reality:**
- ✓ Constant-time token comparison (ws-server.js:14-34)
- ✓ Auth rate limiting with exponential backoff (ws-server.js:187-388)
- ✗ **CRITICAL FLAW**: Weak token generation (randomUUID = 122 bits, not 256)

**Fatal Flaw**: Token generation uses `randomUUID()` with only 122 bits of entropy (cli.js:65). Industry standard is 256 bits minimum. Token stored in plaintext at `~/.chroxy/config.json` with file permissions only, no encryption.

### 2. WebSocket Protocol: 3/5 ⚙️

**Partially Implemented**: Session isolation leaks via optional broadcast filters. While most calls filter correctly, the default broadcasts to ALL authenticated clients (ws-server.js:1713-1720).

### 3. Session Management: 3/5 🔒

**Two Flaws Found:**
- Directory traversal in session names (ws-server.js:742-743) - no validation
- State file race condition (permission-hook.js:15-37) - in-process lock only, doesn't prevent concurrent chroxy instances from corrupting state

### 4. Permission System: 2/5 🛡️

**Critical Bypass**: Permission hook depends on `CHROXY_PORT` env var that users control. Simply `unset CHROXY_PORT` before running Claude bypasses mobile app entirely (permission-hook.sh:13-19).

**Predictable Request IDs**: Sequential + timestamp makes timing attacks easier (ws-server.js:1612).

### 5. Tunnel Security: 3.5/5 🌐

**Mostly Good**: Named tunnel mode uses stable URLs, process recovery with backoff works well. But Quick Tunnel URL changes aren't always propagated to clients (supervisor.js:146-159).

### 6. Config Handling: 3/5 📁

**Logging Leak Risk**: Sensitive keys masked in final output but could leak during intermediate logging. No encryption at rest - tokens in plaintext JSON.

## Top 5 Findings

1. **Weak Token Generation** (config.js:65) - UUIDv4 has only 122 bits entropy vs 256-bit standard
2. **Permission Hook Bypass** (permission-hook.sh:13-19) - Trivially bypassed by unsetting env vars
3. **Predictable Request IDs** (ws-server.js:1612) - Sequential makes timing attacks easier
4. **Session Name Injection** (ws-server.js:742-743) - No path separator validation
5. **State File Race** (session-manager.js:424) - No file-level locking, corruption risk

## Concrete Recommendations

### High Priority
1. Use `crypto.randomBytes(32).toString('base64')` for tokens (cli.js:65)
2. Sign permission hook responses with server HMAC to prevent bypass
3. Use `randomUUID()` for request IDs instead of sequential counters

### Medium Priority
4. Add regex validation for session names: `/^[a-zA-Z0-9 _-]{1,64}$/`
5. Use atomic writes + file locking for state serialization
6. Enforce session broadcast filters (make filter required, not optional)

## Evidence Summary

| File | Line | Claim | Reality |
|------|------|-------|---------|
| cli.js | 65 | Secure tokens | 122-bit UUID (weak) |
| permission-hook.sh | 13-19 | Enforced permissions | Bypassable via env vars |
| ws-server.js | 1612 | Secure request IDs | Sequential + predictable |
| ws-server.js | 742 | Input validation | Session names not validated |
| session-manager.js | 424 | Safe state | Race condition exists |
