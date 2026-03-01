# Adversary's Audit: Desktop Architecture Audit

**Agent**: Adversary -- Red-team security engineer who thinks like an attacker
**Overall Rating**: 2.0 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

| Section | Rating | Key Issue |
|---------|--------|-----------|
| Message Synchronization | 2/5 | Silent on replay data exposure; no session-level authorization analysis |
| Repository & Session Mgmt | 2/5 | State file contains full history; checkpoint git tags leak metadata |
| Tunnel Implementation | 3/5 | Strongest section; CSP `unsafe-inline` + wildcard localhost not flagged |
| WebSocket Layer | 2/5 | `.passthrough()` on 12 Zod schemas allows parameter injection |
| Data Flow Diagram | 2/5 | Dashboard operates in plaintext; IPC proposal "skips encryption + validation" |
| Proposed Protocol | 1/5 | `subscribe_sessions` with zero access control; IPC bypass = unprotected command channel |

## Top 5 Findings

### 1. CRITICAL -- Token Embedded in Dashboard URL and HTML
- `window.rs:26`: Token in URL query parameter
- `dashboard.js:138`: Token in `window.__CHROXY_CONFIG__` JavaScript global
- `ws-server.js:504`: Full token passed to `getDashboardHtml()`
- Visible in: browser history, process list, DevTools, any browser extension

### 2. HIGH -- No Session-Level Authorization
Any authenticated client can `switch_session` to any session and receive full history. `list_conversations` returns metadata for every Claude Code conversation on the machine. Single shared token = no defense in depth.

### 3. HIGH -- Config File Created World-Readable by Tauri
`setup.rs:33-34`: `fs::write()` uses default permissions (0o644). Node server uses `writeFileRestricted()` (0o600) but Tauri setup bypasses this. Local privilege escalation chain: read config -> steal token -> auth -> set `auto` permission mode -> arbitrary code execution.

### 4. MEDIUM -- `.passthrough()` in 12 Zod Schemas
`ws-schemas.js` lines 17, 26, 33, 37, 42, 48, 101, 106, 110, 114, 137, 231. Allows injecting arbitrary extra fields into validated messages. Could override `sessionId` to access other sessions' file listings.

### 5. MEDIUM -- Checkpoint Git Tags Leak Session Metadata
`checkpoint-manager.js:196-217`: Tags named `chroxy-checkpoint/{id}`. `git stash push --include-untracked` captures `.env` files and credentials. Tags could be pushed to remotes via `git push --tags`.

## Attack Scenario Summary

| Scenario | Outcome | Risk |
|----------|---------|------|
| LAN attacker via mDNS | Auth holds; health endpoint leaks version | Medium |
| Token theft (6 vectors) | Complete compromise: all sessions, code execution | Critical |
| Local privilege escalation | Full chain confirmed via world-readable config | High |
| Cross-session data leakage | Trivial -- any auth'd client accesses any session | High |
| Path traversal (browse_files) | Mitigated by `realpath()` boundary check | Low |
| WebView XSS | Partially mitigated; `unsafe-inline` + shell `open` create surface | Medium |

## Verdict
Excellent architecture audit, poor security audit. Treats authentication as solved while the token is exposed in HTML, URLs, and a world-readable config file. The system has no defense in depth: token compromise = total compromise. Fix token handling, add per-session authorization, and tighten CSP before building anything new.
