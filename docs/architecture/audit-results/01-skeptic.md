# Skeptic's Audit: In-App Iterative Development Architecture

**Agent**: Skeptic -- cynical systems engineer who has seen too many over-designed systems fail
**Overall Rating**: 2.8 / 5
**Date**: 2026-02-09

---

## Executive Summary

This is an ambitious architecture document that proposes turning a working v0.1.0 product into a self-modifying system. I have read every file the document references and cross-checked every claim against the actual codebase. What follows is not pretty.

The document is well-structured and clearly written. The problem space is genuinely hard. But the gap between what the document *describes* and what the codebase *actually does* is enormous. Several claims are outright false. Multiple "Small effort" estimates are off by 3-5x. And the three hardest problems in the design are barely acknowledged.

---

## Section-by-Section Ratings

| Section | Rating | Summary |
|---------|:------:|---------|
| 1. Vision & Problem Statement | 4/5 | Accurate, well-articulated. "One sentence solution" understates the surface area. |
| 2. System Architecture Overview | 3/5 | Aspirational but hides critical details (port race, IPC gap, Claude cooperation). |
| 3. Supervisor Process | 3/5 | Good concept. "~100 LOC" is a lie. QR code dependency unsolved. Timing hole in startup. |
| 4. Server Self-Update | 2/5 | Most claims-vs-reality problems. `--resume` not wired in CLI mode. `_sessionId` not persisted. |
| 5. Connection Persistence | 3/5 | Best-analyzed section. `isReconnect` partially true. Navigation guard is the sleeper issue. |
| 6. Mobile App Updates | 2/5 | Highest-risk section. expo-updates not installed. Dynamic URL solution is untested. |
| 7. Build & Deploy Pipeline | 3/5 | Meta-restart correctly identified. "Clean working tree" requirement is hostile to the workflow. |
| 8. Safety & Reliability | 4/5 | Best section. Risk matrix is honest. F10 (recursive loop) underrated. |
| 9. WS Protocol Extensions | 4/5 | Clean, well-defined. Minor naming inconsistency with state machine. |
| 10. Implementation Roadmap | 2/5 | Effort estimates systematically underestimated. Critical path is incomplete. |

---

## Claims vs Reality Summary

| Document Claim | Verdict | Evidence |
|---|---|---|
| "existing `isReconnect` logic preserves messages" | **Partially true** | Works when URL is same; always false for Quick Tunnels |
| "`--resume` flag preserves Claude session" | **Not implemented in CLI mode** | Exists for PTY mode only; `CliSession` has no resume support |
| "Session metadata written to `session-state.json`" | **Does not exist** | No serialize/restore methods, no file I/O |
| "`GET /version` endpoint" | **Does not exist** | Only `/` and `/health` routes |
| "supervisor.js (~100 LOC)" | **Optimistic** | Will be 200-400 LOC with tunnel management, health checks, rollback |
| "`--supervised` mode for server-cli.js" | **Does not exist** | Zero IPC, zero flag parsing, zero conditional paths |
| "Custom close code 4000/4001" | **Not used anywhere** | Neither server nor client inspect or send custom close codes |
| "expo-updates enables OTA updates" | **Not installed** | No `expo-updates` dependency in the project |
| "Small effort" for session serialization (1.2) | **Underestimate** | Requires new methods, file I/O, `--resume` integration |

---

## The 5 Hardest Unsolved Problems

### 1. Port Binding Handoff During Restart
On macOS, TCP `TIME_WAIT` can hold the port for 30-60 seconds after close. The document's 5-second health check window is insufficient. Solutions: `SO_REUSEPORT` (Linux only), proxy approach (supervisor binds port and forwards), or staggered ports.

### 2. Session Preservation Across Restarts
`--resume` does not work in CLI headless mode. The entire session preservation strategy depends on a feature that is not implemented. Even if wired up, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` is experimental with no guarantees.

### 3. Navigation Guard Preventing SessionScreen Preservation
Current `App.tsx` uses `isConnected` as a hard gate. When WebSocket closes, SessionScreen unmounts, destroying all React local state. The `connectionPhase` enum fix requires either keeping SessionScreen mounted with an overlay or restructuring the navigator entirely.

### 4. The Dirty Working Tree Paradox
Deploy requires clean `git status`. But Claude modifies files and needs to test before committing. This forces committing untested code, which pollutes git history on failure.

### 5. cloudflared Process Ownership Transfer
Current `TunnelManager` is 189 lines with event handling, backoff, crash recovery. Replicating this in the "~100 LOC" supervisor blows the budget. URL parsing regex and mode switching must also live there.

---

## Top 5 Recommendations

1. **Build the supervisor as a TCP proxy, not a tunnel launcher.** Bind port 8765 in the supervisor, proxy to server child on a random internal port. Eliminates port handoff entirely.

2. **Prototype `--resume` in CLI headless mode before committing to this architecture.** Manually verify `claude -p --resume <session_id>` works. If it doesn't, the session preservation strategy falls apart.

3. **Fix the navigation guard first (Phase 3.1 should be Phase 0).** This is a prerequisite for any tolerable restart experience.

4. **Drop the "clean working tree" requirement for deploys.** Use `git add -A && git commit -m "wip: pre-deploy"` automatically before deploy.

5. **Add a deploy rate limiter.** Max 3 deploys in 10 minutes to prevent recursive self-modification loops.
