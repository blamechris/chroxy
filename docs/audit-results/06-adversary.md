# Adversary's Audit: Chroxy System

**Agent**: Adversary -- Red team security assessment. Attack surface, abuse cases, security boundaries.
**Overall Rating**: 2.5 / 5
**Date**: 2026-02-10

---

**IMPORTANT CONTEXT:** This system provides remote shell access to a developer's machine. The severity bar is extremely high.

## Section Ratings

### 1. Authentication -- 2/5

**Token generation:** `crypto.randomUUID()` provides 122 bits of entropy -- cryptographically adequate.

**Weaknesses:**
- **Token comparison not constant-time** -- `msg.token === this.apiToken` at ws-server.js:427 is timing-vulnerable. Same at line 1202 for HTTP Bearer.
- **No rate limiting on auth attempts** -- unlimited WebSocket connections, unlimited guesses. Only mitigation is 10s auth timeout per connection.
- **Token in QR code** -- anyone who photographs the QR or reads terminal output gets full access
- **Token stored plaintext on server** -- `~/.chroxy/config.json` with default umask (0644 = world-readable)
- **`--no-auth` mode exists** -- disables auth entirely. Binds to localhost and disables tunnel, but a footgun if combined with tunnel by future change
- **No token rotation** -- compromised token requires server restart, no revocation mechanism
- **No session tokens** -- WebSocket auth is lifetime of connection, no expiry

### 2. Authorization -- 2/5

**Flat permission model.** Once authenticated, every client has identical full privileges:
- Send arbitrary text to Claude Code (which can execute arbitrary commands)
- Create/destroy/rename sessions
- **Switch permission mode to `auto` (bypass ALL permissions)** via `set_permission_mode` -> `bypassPermissions` -> `allowDangerouslySkipPermissions = true`
- Change model, interrupt processes
- Discover and attach to any tmux session on host

**No per-client scoping, no roles, no audit log for permission mode changes.**

### 3. Network Exposure -- 3/5

**Strengths:**
- Cloudflare tunnel TLS for transport
- Quick tunnel URLs have sufficient entropy

**Weaknesses:**
- **`GET /version` endpoint** -- returns git commit, branch, uptime. No auth required. Information disclosure.
- **No WebSocket Origin check** -- allows Cross-Site WebSocket Hijacking in browser context
- **Health endpoint leaks server mode** -- `{"status":"ok","mode":"cli"}`

### 4. Command Injection -- 3/5

**CRITICAL: `cli.js` lines 309 and 326:**
```javascript
execSync(`cloudflared tunnel create ${tunnelName}`, { stdio: 'inherit' })
execSync(`cloudflared tunnel route dns ${tunnelName} ${hostname}`, { stdio: 'inherit' })
```
`tunnelName` and `hostname` come from user input via `prompt()`. Direct shell injection via template literals in `execSync()`. Attack vector: interactive CLI requiring local access (limits risk but violates best practices).

**Lower risk:** `session-discovery.js` uses `execSync` with template literals for `pgrep`, `ps`, `lsof` commands with PID values from parsed tmux output. PIDs are integers but pattern is dangerous.

**Good:** `cli-session.js:124` uses `spawn()` with array args (no shell). tmux session names validated via regex at `ws-server.js:699`.

### 5. Permission System -- 3/5

**Strengths:**
- Hook script falls through safely when CHROXY_PORT absent
- 5-minute timeout with auto-deny on both paths
- Bearer token auth on HTTP permission endpoint

**Weaknesses:**
- `decision` value not validated against whitelist in `permission_response` handler
- Auto mode bypass available to any authenticated client with no additional confirmation
- Stale hooks from crashed server = 300s hang for all Claude sessions

### 6. Config Safety -- 3/5

- **No `chmod` on config files** -- API token in `~/.chroxy/config.json` potentially world-readable
- **No atomic writes** -- `writeFileSync` for settings.json, session state, PID file, config
- **Single-process lock only** -- multiple chroxy instances can corrupt settings.json (TOCTOU)

### 7. Supply Chain -- 3/5

- `qrcode-terminal` last published 2018 -- processes token to generate ASCII art, unmaintained
- `@anthropic-ai/claude-agent-sdk` ^0.1.0 -- pre-release, wide version range
- 0 npm audit vulnerabilities currently

---

## Top 5 Findings

1. **Permission bypass via `set_permission_mode auto`** -- any authenticated client can silently disable ALL permission gates, giving Claude unrestricted tool access. No confirmation, no audit log.
2. **Shell injection in `cli.js` tunnel setup** -- `execSync` with template literals from user input. Use `execFileSync` instead.
3. **No auth rate limiting** -- unlimited brute force attempts against API token
4. **World-readable config files** -- API token stored without explicit permissions
5. **Token comparison timing vulnerability** -- `===` is not constant-time (lower severity due to 122-bit token)

---

## Recommendations

1. **Require confirmation for auto permission mode** -- add a `confirm_dangerous_mode` handshake before enabling `bypassPermissions`
2. **Replace `execSync` with `execFileSync`** in cli.js tunnel setup commands
3. **Add auth rate limiting** -- max 5 failed attempts per IP per minute, exponential backoff
4. **Set explicit file permissions** -- `chmod 0600` on config.json after write
5. **Add constant-time comparison** -- use `crypto.timingSafeEqual` for token verification

---

## Verdict

For a system that provides remote shell access to a developer's machine, the security posture is concerning. The permission bypass (any client can disable all gates) is the highest-severity finding -- it means the mobile app is one `set_permission_mode auto` message away from giving Claude unrestricted access to the host filesystem, process execution, and network. The auth mechanism works but lacks hardening (rate limiting, token rotation, constant-time comparison). The shell injection in tunnel setup is a code quality issue that should be fixed immediately. The threat model assumes the tunnel URL + token is sufficient protection -- this holds as long as QR codes aren't photographed and tokens aren't leaked, but there's no defense in depth.
