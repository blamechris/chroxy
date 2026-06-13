# Guardian's Audit: Reconnect / Lifecycle Cluster

**Agent**: Guardian — paranoid SRE/security; races, data-integrity, 3am pages
**Overall Rating**: 3 / 5
**Date**: 2026-06-13

---

## #5622 — Reconnect-storm starves the event loop (HEADLINE)
Confirmed, and worse than the title implies, but narrower than "anonymous DoS." The eager E2E handshake runs **inline, synchronously, on the main loop** for every successful auth: client `prepareEagerKeyExchange()` fires in `socket.onopen` on every reconnect (`message-handler.ts:2912-2913`); server derives per connection — `createKeyPair()`, `deriveSharedKey()` (`nacl.box.before`), `signExchangeKey()` (Ed25519), `deriveConnectionKey()` (SHA-512) at `ws-history.js:185-197`. All pure-JS tweetnacl (`crypto.ts`), no worker offload, no `crypto.subtle`.

**Rate-limiting doesn't save you:** `authFailures` throttling only fires on auth *failure* (`ws-auth.js:219-227`); a valid token is never rate-limited and the derivation happens *after* auth succeeds. The `_maxPendingConnections=20` cap counts only *unauthenticated* sockets (`ws-client-manager.js:400-406`) — bounds concurrent in-flight handshakes, not derivation throughput. No cap on authenticated connections.

**Realistic trigger = fan-in:** a supervisor restart / tunnel flap drops every client; phone + N desktop tabs all reconnect in the same window, each firing a synchronous handshake on the cold-starting child. Self-DoS amplification on restart. **RISK: likelihood HIGH × impact MEDIUM = HIGH.**

## #5623 / #5613 — stale session_role across reconnect
#5613 (server re-emit) fixed (`ws-history.js:763-769`, clears stale role via `primaryClientId:null`). **Residual:** the re-sync is inside `sendSessionInfo`, called only for the *active* session on reconnect (`ws-history.js:480`) — background subscribed sessions don't get a fresh `session_role`. **RISK: likelihood MED × impact LOW = LOW.**

## Standby EADDRINUSE give-up
`20 × 500ms = 10s` then resets `_standbyRetries=0` and returns silently (`supervisor.js:543-546`); child restart proceeds independently — correct. **Adjacent hazard:** the retry path schedules a `setTimeout` that nulls `_standbyServer` then re-enters `_startStandbyServer`; if `_stopStandbyServer()` runs between the error firing and the timeout, you can flap a half-open listener. Won't crash (guarded), but flap-leaks under exactly the contended restart it exists for. **RISK: LOW × LOW = LOW.** Bump the cap + tighten the close/re-enter race.

## resume_budget silent no-op
The WS handler is a literal no-op stub: `resumeBudget: () => {}` (`ws-message-handlers.js:136`), while the real `sessionManager.resumeBudget()` exists unused (`session-manager.js:2653`). A client clicking resume gets no ack and nothing happens — a **dead button**. No false-ack desync as-is; the *proposed* fix (reuse `budget_resumed`) is what would create one. Needs a dedicated ack wire-type. **RISK: MED × LOW = LOW** (stuck-control footgun, no integrity hole).

## Question-answer stale-toolUseId fallback (the one I'd lose sleep over)
Two layered weaknesses: (1) routing falls back to active session when toolUseId is absent/unmapped — `const questionSessionId = (msg.toolUseId && questionSessionMap.get(msg.toolUseId)) || client.activeSessionId` (`input-handlers.js:808`); (2) cli/sdk `respondToQuestion(text)` writes to stdin if `_waitingForAnswer` is true with **no toolUseId match** (`cli-session.js:1487-1503`). Repro: Q1(A) times out → turn advances → Q2(B) sets waiting again → a late answer to Q1 arrives → A unmapped → falls back to active session → fed to Q2. Cross-session is gated (subscribe check at 825-828), so damage is **intra-session answer-to-wrong-question** — a deny can become an approve on a different tool. **RISK: likelihood LOW × impact HIGH = MEDIUM-HIGH.**

## Harness-preamble — trust
The global key from `~/.chroxy/config.json` is operator-owned (pre-trusted daemon class) — right boundary. Get right: apply the 4000-char cap to the **folded total**, not per-segment, else a long global preamble silently squeezes out the operator's trusted repo/session text. Keep the global slot writable only from local config (no remote `set_session_preamble` into it). **RISK: LOW.**

## #5668 / #5631 / #5674 — scanned for safety only
All LOW: reliability/UX/parity, no new attack surface; #5673 already stamps `sessionId` server-side so #5674 is display-only (no wire-level mis-attribution).

## Risk heatmap
```
            IMPACT →
          LOW         MEDIUM        HIGH
  HIGH  |           | #5622       |             |
  MED   | resume_   |             | qa-stale-   |
        | budget    |             | toolUseId   |
  LOW   | EADDRINUSE | harness cap | (mis-route) |
        | #5613 fixd | #5631/#5674 |             |
```

## Recommendations (hard gates before the reconnect sprint)
- **#5622:** bound the *derivation*, not just the client ladder — per-token throttle on the authenticated path, cap authenticated connections per token, offload/stagger the scalar-mults, add a handshake-per-sec metric.
- **qa-stale-toolUseId:** when toolUseId is present but unmapped, **drop + log, do NOT fall back to active session**; pass toolUseId into cli/sdk `respondToQuestion` to refuse id-mismatched answers (claude-tui already does).
- **resume_budget:** wire the stub + dedicated `budget_resume_ack`.
- **#5623 residual:** re-emit `session_role` for all subscribed sessions on reconnect.
- **harness-preamble:** cap the folded total; global slot local-config-only.

## Verdict: 3 / 5
The cluster is structurally sound (trust gates, #5737 re-emit, #5748 double-fork fix, bounded client ladder all real), but #5622's mitigation is aimed at the wrong layer and the qa-stale-toolUseId hole needs a fail-closed guard regardless of whether its fix ships.
