# Skeptic's Audit: Desktop Architecture Audit (v3)

**Agent**: Skeptic -- Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 3.0 / 5 (unchanged from v2)
**Date**: 2026-02-28
**Pass**: v3 (re-review of original audit + v2 master assessment)

---

## Section-by-Section Ratings

| Section | v2 | v3 | Change | Justification |
|---------|-----|-----|--------|---------------|
| Message Sync | 3 | 3 | -- | `_broadcastToSession` still broken. Delta batching description still accurate. |
| Repo/Session | 4 | 3.5 | -0.5 | Session limit "hardcoded" quibble from v2 was overstated; `server-cli.js:60` does hardcode 5 with no user override |
| Tunnel | 4 | 3.5 | -0.5 | `tunnel-check.js` exists (v2 correction overturned), but named tunnel command arg order is wrong |
| WebSocket/RT | 3 | 2.5 | -0.5 | Deeper dig confirms seq is truly dead; jitter and count errors compound |
| Data Flow | 4 | 4 | -- | Still the strongest section. Accurate component relationships. |
| Proposed Protocol | 3 | 1.5 | -1.5 | IPC impossible, seq-based sync on dead field, multi-session already (broken) behavior |

## Top 5 Findings

### 1. v2 Correction Overturned: `tunnel-check.js` Exists (CORRECTION)
v2 claimed this file doesn't exist. It does. Credit where due. However, the audit's description of its behavior is still partially inaccurate.

### 2. `_broadcastToSession` Confirmed Even More Thoroughly (RECONFIRMED)
No filter is ever passed from any caller in the entire codebase. Every invocation uses the default `() => true`. The function name is actively misleading.

### 3. Named Tunnel Command Argument Order Wrong (NEW)
The audit shows the named tunnel command with incorrect argument ordering. The actual cloudflared invocation uses a different parameter structure.

### 4. `models_updated` Bypasses EventNormalizer Entirely (NEW)
The audit describes all events flowing through the EventNormalizer's EVENT_MAP. But `models_updated` events are broadcast directly via WsServer, completely bypassing the normalizer pipeline. This contradicts the audit's event flow description.

### 5. Session Limit: Practically Hardcoded (NUANCED)
v2 master assessment corrected "hardcoded" to "configurable via constructor." This is pedantically right but practically misleading. `server-cli.js:60` passes 5 with no CLI flag, env var, or config file override. Users cannot change it without modifying source code.

## V2 Master Assessment Priority Review

The priority categorizations are **correct**. No items need to move between tiers.

- **Immediate** security fixes (setup.rs permissions, token-in-URL) remain unfixed and critical
- **Deferred (Probably Never)** items are all correctly identified as solutions to non-problems
- **One estimate concern**: "Socket.IO v4-style connection state recovery" at "2-3 days" is an underestimate. Adding ack-based gap detection to a fire-and-forget protocol across server + 2 clients is closer to 1-2 weeks of careful work.

## Verdict

Same as v2: strong inventory, weak implementation guide. The v2 master assessment correctly identified what to keep (diagrams, inventory) and what to discard (protocol enhancements). The priority matrix is well-calibrated. The audit document serves well as a reference but should not be used as an implementation plan.
