# Skeptic's Audit: Desktop Architecture Audit

**Agent**: Skeptic -- Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

| Section | Rating | Key Issue |
|---------|--------|-----------|
| Message Synchronization | 3/5 | `_broadcastToSession` does NOT filter by session; seq numbers are dead metadata |
| Repository & Session Mgmt | 4/5 | Mostly accurate; session limit described as "hardcoded" when it's configurable |
| Tunnel Implementation | 4/5 | `tunnel-check.js` does not exist; E2E encryption misplaced under tunnels |
| WebSocket Layer | 3/5 | Client message count wrong (36 actual vs 28 claimed); jitter 5x wrong |
| Data Flow Diagram | 4/5 | Dashboard and WsServer share same HTTP server, not depicted as separate peers |
| Proposed Protocol | 3/5 | Multi-session subscription already describes current behavior (server already broadcasts everything) |

## Top 5 Findings

### 1. `_broadcastToSession` Does NOT Filter by Session (HIGH)
**Claim (line 37):** "sends to all authenticated clients viewing that session"
**Reality:** `ws-server.js:1038-1045` sends to ALL authenticated clients. Default filter is `() => true`. No `client.activeSessionId === sessionId` check. The proposed "multi-session subscription" already describes current behavior.

### 2. Client-to-Server Message Count Is Wrong (MEDIUM)
**Claim:** "28 types." **Reality:** 32 in discriminatedUnion + 4 handled separately = **36 total**. A 22% undercount.

### 3. `tunnel-check.js` Does Not Exist (MEDIUM)
**Claim (lines 201-204):** "Tunnel verification (`tunnel-check.js`)." **Reality:** No such file. Health checking is inline in `server-cli.js` and `supervisor.js`.

### 4. Jitter Value Is 5x Wrong (MEDIUM)
**Claim:** "+/-10% jitter." **Reality:** `utils.ts:61-63` implements 0% to +50% additive jitter. 1s becomes 1000-1500ms, not 900-1100ms.

### 5. `seq` Numbers Are Dead Metadata (MEDIUM)
Server assigns `seq` at `ws-server.js:1198-1200`, but no client code ever reads, checks, or uses this field. Mobile dedup uses content-based comparison. The audit presents `seq` as functional infrastructure when it is unused scaffolding.

## Verdict
The architectural narrative is broadly correct -- event flow, components, persistence, and encryption are described faithfully. Where it fails is in the specifics: fabricated filenames, wrong counts, wrong numbers, and a critical misunderstanding of broadcast behavior that undermines both the bottleneck analysis and proposed enhancements.
