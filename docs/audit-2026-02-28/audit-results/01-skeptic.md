# Skeptic's Audit: Desktop Architecture Audit

**Agent**: Skeptic -- Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

### Section 1: Message Synchronization -- Rating: 3/5

**What it gets right:** Accurate description of the event pipeline (Session -> EventNormalizer -> WsForwarding -> WsServer.broadcast). Delta buffering mechanism correctly described.

**What it gets wrong:**

The `_broadcastToSession` description is **factually incorrect**. The document says "sends to all authenticated clients viewing that session." The actual code at `ws-server.js:1038-1044`:

```javascript
_broadcastToSession(sessionId, message, filter = () => true) {
    const tagged = { ...message, sessionId }
    for (const [ws, client] of this.clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        this._send(ws, tagged)
      }
    }
}
```

There is **no** `client.activeSessionId === sessionId` check. Every authenticated client receives every session's messages. The message is tagged with `sessionId` for client-side routing, but the server does not filter. Bandwidth and encryption overhead scales as O(clients * sessions), not O(clients-per-session * sessions).

### Section 2: Repository and Session Management -- Rating: 3/5

Accurate on session lifecycle and persistence. The "pluggable" description of the provider registry is slightly oversold but functionally correct.

### Section 3: Tunnel Implementation -- Rating: 3/5

The document calls the E2E encryption "production-grade" -- this is an overstatement. The nonce counter uses JavaScript `number` which loses precision at 2^53, not the 2^64 implied by the 8-byte nonce field. The "pluggable adapter registry" has exactly one adapter and has never been validated with a second one.

### Section 4: WebSocket / Real-Time Communication -- Rating: 4/5

Most thorough section. Protocol catalog is comprehensive. However, message type counts are significantly wrong.

### Section 5: Data Flow Diagram -- Rating: 4/5

Accurate ASCII diagrams. Reconnection jitter values are wrong (0-50% additive, not +/-10%).

### Proposed Protocol -- Rating: 2/5

"Skip JSON serialization" via Tauri IPC is not grounded in Tauri's actual capabilities. Message priority via field labels doesn't make TCP deliver faster. "Shared encryption for broadcast" undermines per-client forward secrecy.

---

## Top 5 Findings

### Finding 1: `_broadcastToSession` Does NOT Filter by Session

**Document claim:** "sends to all authenticated clients viewing that session"
**Reality:** Sends to ALL authenticated clients. No session filtering. This means per-client encryption cost is even worse than described -- messages are encrypted for clients that will discard them.

### Finding 2: Message Type Counts Are Significantly Wrong

**Document claim:** "28 client-to-server types, 55+ server-to-client types, 58+ total"
**Reality:** 35 client-to-server types (31 in Zod union + 4 handled separately), 67+ server-to-client. Total exceeds 100. Getting the primary metric wrong by 40%+ is a credibility issue for a "comprehensive audit."

### Finding 3: "Pluggable Tunnel Adapter Registry" Has Exactly One Adapter

`registry.js` is 53 lines. Only `CloudflareTunnelAdapter` is ever registered. `parseTunnelArg` has hardcoded shortcuts for Cloudflare modes. No evidence this abstraction has been tested with a second adapter. The "pluggable" label is marketing for an unvalidated indirection layer.

### Finding 4: Reconnection Jitter Values Are Wrong

**Document claim:** "delays: 1s, 2s, 3s, 5s, 8s with +/-10% jitter"
**Reality** (`utils.ts:61-63`): Jitter is 0% to +50% additive only, not +/-10%. A 1s delay becomes 1.0-1.5s, not 0.9-1.1s. Factual error.

### Finding 5: Tauri IPC "Skip JSON Serialization" Is Not Grounded in Reality

Tauri's webview-to-Rust communication uses JSON serialization for all command invocations. There is no shared memory API between the WebView and the Rust backend. The proposal is presented as a straightforward optimization when it would require significant architectural work with no prior art.

---

## Concrete Recommendations

1. **Fix `_broadcastToSession`** -- Add `client.activeSessionId === sessionId` filter. One-line fix with real impact.
2. **Don't build priority queues for WebSocket** -- TCP is FIFO. Move low-priority messages to polling-on-demand.
3. **Use Tauri events, not command bridge** -- Events support string payloads with lower overhead than commands.
4. **Validate the tunnel adapter abstraction** -- Implement a second adapter or remove the registry layer.
5. **Recount and document the actual message catalog** -- Create machine-readable catalog verifiable by tests.

---

## Verdict

This document is a competent survey that correctly identifies major components and relationships. However, it fails on precision -- message counts are wrong by 40%, the broadcast mechanism is misdescribed, reconnection jitter values are fabricated, and the "pluggable" tunnel registry claim is unearned. The proposed protocol enhancements range from reasonable (differential sync) to naive (shared memory IPC, message priority via field labels). Most critically for an audit document, it tends to describe what the code *should* do rather than what it *actually* does.
