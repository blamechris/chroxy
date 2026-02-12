# Guardian's Audit: Chroxy Security Architecture

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages
**Overall Rating**: 2 / 5 🔴
**Date**: 2026-02-12

## Verdict

**Would I run this exposed to the internet?** ⚠️ **NO** — Not without significant hardening.

Chroxy exposes arbitrary code execution over public WebSocket tunnels with **multiple CRITICAL vulnerabilities** enabling authentication bypass, RCE, DoS, and session hijacking.

## Section Ratings

### 1. Authentication Bypass: 2/5
- ✓ Constant-time comparison
- ✓ Rate limiting with backoff
- ✗ Length oracle in token check
- ✗ Rate limiting bypassed by IP rotation
- ✗ No warning when `--no-auth` enabled

### 2. Input Validation: 1.5/5 🔴
**CRITICAL FAILURES:**
- Path traversal in `list_directory` (ws-server.js:1418) - read any filesystem directory
- User-controlled `cwd` in session creation (session-manager.js:741-756)
- JSON bomb - no WebSocket message size limit
- No length limit on session names (DoS)

### 3. Privilege Escalation: 2/5 🔴
- Auto permission mode bypasses ALL checks (no audit trail)
- Race condition: permission mode can change mid-execution
- Settings.json write race (in-process lock only)
- HTTP permission endpoint is DoS vector (5-min timeout × unlimited connections)

### 4. Denial of Service: 1/5 🔴
**Trivial vectors:**
- WebSocket flood: no rate limit on `input` messages
- Session exhaustion: max 5 sessions, no per-client limit, no expiry
- History accumulation: 100 messages × 1MB each = 500MB RAM
- Ping interval too slow (30s) misses connection exhaustion
- Unbounded retry: destroy + create loop thrashes CPU

### 5. Data Exfiltration: 2.5/5 🟡
- `list_directory` leaks full filesystem structure
- Session state includes cwds, models, permission modes
- User input logged (PII leak risk)
- Permission hook uses HTTP (not HTTPS) to localhost

### 6. Race Conditions: 1/5 🔴
**Critical races:**
- Concurrent auth (check-then-act on `!client.authenticated`)
- Session switching during message processing
- Permission response vs timeout (double execution risk)
- Primary client race (multiple concurrent writers)
- Session destroy during active message

## TOP 5 NUCLEAR SCENARIOS

### 🔥 #1: Path Traversal → Full Filesystem Access (CVSS 9.8)
**Attack:**
```javascript
{type: "create_session", cwd: "/etc"}
{type: "input", data: "/read /etc/passwd"}
{type: "list_directory", path: "/home/victim/.ssh"}
```
**Impact**: Read arbitrary files, enumerate SSH keys, AWS credentials

### 🔥 #2: Permission Mode Race → RCE Without Approval (CVSS 9.1)
**Attack**: Switch to auto mode mid-message to bypass permission prompts.
**Impact**: Execute arbitrary commands without user approval

### 🔥 #3: WebSocket Flood → DoS (CVSS 7.5)
**Attack**: Send 100,000 messages with 1MB payloads.
**Impact**: Server OOMs, legitimate users can't connect

### 🔥 #4: Session Exhaustion → Lock Out Users (CVSS 6.5)
**Attack**: Create 5 sessions (max), block all other users indefinitely.
**Impact**: Denial of service, no idle timeout

### 🔥 #5: Settings.json Race → Corrupted Permissions (CVSS 6.0)
**Attack**: Run two chroxy instances simultaneously.
**Impact**: Corrupted settings.json, broken permission system

## Additional Findings

6. **Weak Session IDs** - randomUUID().slice(0, 8) = only 32 bits (collision risk)
7. **No Session Expiry** - sessions persist forever, consume resources
8. **Broadcast Amplification** - single message broadcasts to all clients (1 → N amplification)
9. **Cloudflare Trust** - trusts cf-connecting-ip header (spoofable if bypassing Cloudflare)

## RECOMMENDATIONS (Prioritized)

### CRITICAL (Fix before public release)
1. **Path Traversal** - Allowlist permitted directories, canonicalize paths
2. **WebSocket Rate Limiting** - 10 msg/min per client, 64KB max size, 3 connections per IP
3. **Permission Mode Locking** - Lock during active messages, require re-confirmation
4. **Session Limits** - 2 per client, 1 hour idle timeout

### HIGH (Fix within 1 month)
5. **Session ID Strength** - Use full UUID or 128-bit crypto ID
6. **Settings Lock** - Use filesystem lock for cross-process safety
7. **Audit Logging** - Log all auth, permissions, directory access

### MEDIUM (Fix within 3 months)
8. **Input Sanitization** - Validate lengths, character sets
9. **Broadcast Rate Limiting** - Prevent amplification attacks
10. **Connection Pooling** - Limit concurrent permission long-polls

## Final Verdict: **2/5** 🔴

Chroxy is **not production-ready** for internet exposure. Critical vulnerabilities in path handling, permission races, and DoS vectors make it exploitable by moderately skilled attackers.

**Safe Use Cases:**
- ✅ Local development (localhost only, trusted users)
- ✅ Private VPN with trusted clients
- ❌ Public internet exposure
- ❌ Multi-tenant environments
