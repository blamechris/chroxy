# Minimalist Audit: In-App Iterative Development Architecture

**Agent**: Minimalist -- ruthless engineer who believes the best code is no code
**Overall Rating**: Necessity 2.5 / 5 (the design is ~5x more complex than needed)
**Date**: 2026-02-09

---

## Executive Summary

This document describes a 4-phase, 26-step plan to solve a problem that can be stated in one sentence: "I want to edit Chroxy's server code from my phone without re-scanning a QR code." The proposed solution introduces a supervisor, IPC protocol, 8-state state machine, deploy manifest, OTA pipeline, message queues with per-type TTLs, connection phase enums, device pairing, local network fallback, and rollback architecture -- for a tool with exactly one user.

---

## Section Necessity Ratings

| Section | Rating | Verdict |
|---------|:------:|---------|
| 1. Vision & Problem Statement | 4/5 | Real problem. Challenge 4 (app updates) is scope creep. Challenge 5 (safety) overstated -- you have SSH. |
| 2. Architecture Overview | 3/5 | Correct in principle. IPC/lifecycle signals add weight to what is `fork()` + SIGUSR2. |
| 3. Supervisor Process | 3/5 | 4 of 9 listed responsibilities are needed. IPC protocol, state JSON, self-update, QR display are premature. |
| 4. Server Self-Update | 2/5 | 10-state machine for: kill old, start new, check /health. DRAINING, ABORTED, ROLLBACK -- cut for v1. |
| 5. Connection Persistence | 4/5 (Named Tunnel) / 2/5 (everything else) | Named Tunnel is the 80/20 item. 8-state enum, message queue, local fallback are polish. |
| 6. Mobile App Updates | 1/5 | Cut entirely. Not the stated goal. Server iteration is what matters. |
| 7. Build & Deploy Pipeline | 2/5 | 7-step sequence for restarting a Node.js process. A shell one-liner suffices. |
| 8. Safety & Reliability | 2/5 | 10-row risk matrix for a tool where the dev has SSH. Keep `node --check` and health gate. Cut the rest. |
| 9. WS Protocol Extensions | 2/5 | 10 new message types. Keep close code 4000 and `server_shutting_down`. Cut the rest. |
| 10. Implementation Roadmap | 2/5 | 26 steps across 4 phases. Reduce to 8 steps across 2 phases. |

---

## The One-User Question

The architecture uses words like "clients" (plural), "broadcast to all authenticated clients," "drain in-flight requests," and "message queue for offline periods." These are multi-user concepts applied to a single-developer tool.

- **Drain protocol**: Who is being drained? The one user who requested the restart.
- **Message queue with TTLs**: Who queues messages during a 3-second restart?
- **8-state connection enum**: One user either sees the app working or sees a spinner.

---

## YAGNI Violations (Top 10)

1. Deploy manifest with history array -- you have `git log`
2. Session state serialization with full metadata -- you need one session ID string
3. 8-state connection phase enum -- you need connected/reconnecting/disconnected
4. Per-type message queue TTLs -- 3-second restart not worth queuing for
5. Local network fallback -- saving 100ms on a multi-second API call
6. App OTA updates -- not the stated goal
7. Bundle rollback with last-3 retention -- not the stated goal
8. Supervisor self-update via sentinel file -- will happen approximately never
9. Lock file with PID validation -- one user, one process
10. Version display with server commit hash -- nice to have, not must have

---

## The 80/20 Cut: 4 Items That Deliver ~80% of Value

1. **Named Tunnel support in TunnelManager** -- Stable URL. Scan QR once, never again.
2. **40-line supervisor script** -- Spawn cloudflared + server. SIGUSR2 = restart. SIGTERM = die.
3. **`--supervised` flag in server-cli.js** -- Skip tunnel/QR when supervised. ~20 lines.
4. **`node --check` before restart** -- One-line validation prevents broken code.

---

## Minimal Viable Architecture (~140 LOC new code)

### Phase 1: Named Tunnel (the real problem)
| Step | Effort |
|------|--------|
| Named Tunnel mode in TunnelManager | Small |
| `chroxy tunnel setup` CLI command | Medium |
| Auto-detect named vs quick from config | Small |
| Close code 4000 on server shutdown (2 lines) | Trivial |

### Phase 2: Supervisor + Restart
| Step | Effort |
|------|--------|
| Supervisor script (~40 LOC) | Small |
| `--supervised` flag in server-cli.js (~15 lines) | Small |
| `chroxy start --supervised` integration | Small |
| Deploy: `node --check src/*.js && kill -USR2 $(cat pid)` | Trivial |

### Eliminated:
- Phase 3 (App Reconnection UX): Existing reconnect + close code 4000 is sufficient
- Phase 4 (App Self-Updates): Entirely out of scope

---

## Alternative: Zero Code Changes

```bash
# One-time: set up named tunnel
cloudflared tunnel create chroxy
cloudflared tunnel route dns chroxy chroxy.mysite.com

# Run forever:
cloudflared tunnel run --url http://localhost:8765 chroxy &
while true; do
  node packages/server/src/server-cli.js --tunnel-url wss://chroxy.mysite.com
  echo "Restarting in 2s..."
  sleep 2
done

# To deploy: kill $(pgrep -f server-cli.js)
```

The only missing piece is `--tunnel-url` flag (5-line change). This requires zero new files, zero new components, zero state machines.
