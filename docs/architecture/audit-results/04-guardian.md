# Guardian Security Audit: Chroxy In-App Development

**Agent**: Guardian -- paranoid security engineer / SRE
**Overall Rating**: 2.5 / 5
**Date**: 2026-02-09

---

## Executive Summary

This architecture proposes that a system update itself through the same interface that depends on that system being operational. The design is thoughtful and addresses many failure modes, but I have identified **critical gaps** that will cause 3am pages if shipped as specified. None of the proposed safety mechanisms exist today. The entire safety story lives in a markdown file.

---

## Safety Mechanism Ratings

| Mechanism | Rating | Justification |
|-----------|:------:|--------------|
| P1: Known-Good Version | 3/5 | Good concept; `git checkout` is not atomic. No `npm install`. |
| P2: Health Check Gate | 2/5 | HTTP-only misses WS/protocol bugs. No extended check. |
| P3: Automatic Rollback | 2/5 | Only triggers on crash-within-60s. Silent failures never trigger. |
| P4: Watchdog Timer | 3/5 | 5min timeout reasonable. Ownership unclear. |
| P5: Git Safety | 3/5 | Clean worktree check good. Doesn't handle `node_modules`. |
| P6: Lock File | 2/5 | Lifecycle ownership undefined. Who cleans up? |
| Supervisor Design | 3/5 | Correct architecture. No OS-level service manager. |
| Named Tunnel | 4/5 | Correct solution to URL stability. |
| Session Serialization | 2/5 | Depends on Claude's `--resume` (unverified). |
| Connection Phase SM | 4/5 | Well-designed. Not implemented yet. |

---

## Top 5 Safety Gaps (MUST FIX Before v1)

### 1. CRITICAL: App Clears Saved Connection on Retry Exhaustion
`connection.ts` lines 505-508: `clearConnection(); set({ savedConnection: null })`. Any restart exceeding ~19s retry window permanently destroys credentials. User must physically access machine for new QR.

### 2. CRITICAL: Health Check Must Validate WebSocket Protocol
HTTP `GET /health` returning 200 does not detect broken WS protocol. A server that responds to HTTP but sends corrupt WS frames will pass health check and trap user in broken state. Health check must: (a) HTTP GET, (b) WS upgrade + auth, (c) ping/pong.

### 3. HIGH: `~/.claude/settings.json` Concurrent Write Race
`cli-session.js` lines 623-686: Multiple CliSession instances do unsynchronized read-modify-write on `settings.json`. Classic TOCTOU race. Will corrupt permission hooks.

### 4. HIGH: Rollback Must Handle Dirty `node_modules`
`git checkout known-good-hash` does not restore `node_modules`. If failing code introduced a dependency change, rolling back source without rolling back `node_modules` means "known-good" code also fails.

### 5. HIGH: Lock File Cleanup Responsibility Undefined
`deploy.js` creates lock, signals supervisor, "immediately exits." Nobody removes the lock after restart. Stale lock blocks all future deploys.

---

## Race Conditions

| # | Race Condition | Likelihood | Impact |
|---|---|:---:|:---:|
| 1 | `settings.json` concurrent write (EXISTING BUG) | 4/5 | Corrupted permission hooks |
| 2 | Deploy during active Claude message | 3/5 | Lost response, partial file writes |
| 3 | Health check before port binding | 3/5 | Spurious rollback |
| 4 | Lock file cleanup race | 2/5 | Stale lock blocks deploys |
| 5 | Concurrent app + server deploys | 2/5 | Bundle export fails during restart |
| 6 | WebSocket reconnect during history replay | 3/5 | `_receivingHistoryReplay` stuck true |

---

## The Nuclear Scenario

Claude introduces a bug that: passes `node --check` → passes `GET /health` → breaks the WebSocket protocol → app disconnects and reconnects in tight loop → retries exhausted → **clears savedConnection** → user locked out → no QR code (supervisor terminal is remote) → must physically access machine.

**What would make this survivable:**
- Extended health check with full WS connect + auth + test message
- Server-side WS error counter (>10 errors in 60s = self-rollback)
- App-side "force reconnect" button that survives connection state reset
- Supervisor HTTP status page on a different port
