# Adversary's Audit: Full Codebase Health Post-v0.2.0

**Agent**: Adversary -- Red-team security engineer who thinks like an attacker
**Overall Rating**: 3.8 / 5
**Date**: 2026-02-26

## Section Ratings

| Area | Rating | Key Issue |
|------|--------|-----------|
| Authentication | 4/5 | Token in URL query string and page source |
| Encryption | 4/5 | Solid NaCl implementation; dashboard uses unencrypted ws:// |
| Input Validation | 4/5 | Zod schemas + execFile arrays throughout |
| File System | 4/5 | realpath sandboxing; minor TOCTOU race |
| Process Spawning | 5/5 | No shell injection path found |
| Network Exposure | 3/5 | mDNS leaks service info; no pre-auth WS connection limit |
| Dashboard Security | 3/5 | Token in URL/page source; CSP correctly restrictive |
| Mobile Security | 4/5 | SecureStore + biometric lock + E2E encryption |

## Top 5 Attack Vectors

1. **Token extraction via dashboard URL / page source** — browser history, page source, Referer headers all expose full API token
2. **DoS via unauthenticated WebSocket connection exhaustion** — no pre-auth connection limit, 10s timeout per connection
3. **Privilege escalation via permission mode change** — compromised token → set_permission_mode auto → RCE via Claude Code
4. **LAN reconnaissance via mDNS** — service discovery exposes host, port, and auth mode
5. **TOCTOU race in file operations** — narrow window between realpath check and readdir/readFile

## Key Positive Findings

- Constant-time token comparison with timing-safe equal
- No command injection possible (all execFile, no exec)
- XSS correctly mitigated: escape-before-transform in renderMarkdown
- Auth rate limiting uses kernel-set socket IP, not spoofable headers
- Replay detection via strict nonce counter

## Verdict

Strong security engineering for a personal dev tool. Auth, crypto, and input validation are textbook implementations. The primary weakness is token lifecycle: the token appears in URLs, page source, and browser history, creating multiple exfiltration paths. Adding a session-cookie-based dashboard auth flow would eliminate the most impactful attack vector. No exploitable RCE or injection vulnerabilities were found.
