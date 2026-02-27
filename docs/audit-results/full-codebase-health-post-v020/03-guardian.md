# Guardian's Audit: Full Codebase Health Post-v0.2.0

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages
**Overall Rating**: 3.8 / 5
**Date**: 2026-02-26

## Section Ratings

| Area | Rating | Key Issue |
|------|--------|-----------|
| Auth & Authorization | 4/5 | Token in URL query string and page source; no per-client scoping |
| Encryption & Keys | 4/5 | Dashboard uses unencrypted `ws://localhost`; nonce counter is JS Number |
| Input Validation | 4/5 | Zod + execFile everywhere; web task prompt passes to claude --remote |
| File System | 4/5 | realpath checks good; TOCTOU race between check and use |
| Process Spawning | 5/5 | All execFile with arrays; no shell injection path found |
| Network Exposure | 3/5 | mDNS advertises service; unauthenticated WS connections unlimited |
| Dashboard Security | 3/5 | Token in URL & page source; CSP connect-src too narrow for tunnel |
| Mobile Security | 4/5 | SecureStore for tokens; biometric lock; E2E encryption |

## Top 5 Findings

1. **Token in mDNS TXT record** (server-cli.js:198) — advertises auth mode to entire LAN
2. **Incomplete crash handler cleanup** (server-cli.js:406-418) — no sessionManager.destroyAll, no tunnel.stop, orphaned child processes
3. **CSP connect-src breaks tunnel dashboard** (ws-server.js:481) — `ws://localhost` only
4. **`modeLabel` TDZ in supervisor** (supervisor.js:183 vs 200) — tunnel_recovered references const before declaration
5. **server-cli-child.js no cleanup on crash** (server-cli-child.js:120-128) — immediate process.exit(1) with no broadcastShutdown

## Verdict

Strong security engineering: constant-time auth, NaCl encryption, Zod validation, realpath sandboxing, execFile everywhere. Primary gaps are crash-path cleanup (orphaned processes, missing state serialization) and token exposure in URLs. No exploitable vulnerabilities found, but reliability under failure conditions needs hardening.
