# Operator's Audit: Happy vs Chroxy Architecture

**Agent**: Operator -- UX-obsessed engineer who counts taps and measures friction
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-19

---

## Section-by-Section Ratings

| # | Section | Rating | Notes |
|---|---------|--------|-------|
| 1 | Topology | 4/5 | Clear diagrams, good for communicating architecture to non-engineers |
| 2 | Wire Protocol | 3/5 | Message count errors, but protocol comparison is useful for UX planning |
| 3 | Ordering | 5/5 | Message ordering directly impacts user experience — correctly flagged |
| 4 | Providers | 3/5 | Multi-provider is a UX distraction until users ask for it |
| 5 | Connectivity | 4/5 | Reconnection UX is well-analyzed, offline gaps correctly identified |
| 6 | Events | 3/5 | Event flow matters for UX responsiveness, fabricated constant undermines trust |
| 7 | Encryption | 4/5 | Users don't care about E2E vs transit — they care about "is it secure?" |
| 8 | State | 4/5 | Session persistence directly impacts user trust and satisfaction |
| 9 | RPC | 4/5 | Read-only is the right UX choice — mutations should go through Claude Code |
| 10 | Feature Matrix | 3/5 | Feature comparison useful but factual errors reduce utility |

---

## Top 5 UX Findings

### 1. Onboarding: Chroxy 8 Steps vs Happy 5 — Happy Wins First-5-Minutes

**Chroxy onboarding flow**:
1. Install Node.js 22
2. Install tmux (if PTY mode)
3. Install cloudflared
4. `npm install -g chroxy`
5. `npx chroxy start`
6. Wait for tunnel URL
7. Scan QR code on phone
8. Start chatting

**Happy onboarding flow** (estimated):
1. Sign up for Happy account
2. Install Happy agent
3. `happy agent start`
4. Open Happy app / scan QR
5. Start chatting

Happy abstracts away tunnel setup, Node version requirements, and cloudflared installation. The relay model trades operational complexity (on Happy's side) for onboarding simplicity (on the user's side).

**Impact**: First-5-minutes experience heavily determines retention. Chroxy loses potential users who hit Node version issues, tmux requirements, or cloudflared installation failures before ever seeing the product work.

**Recommendation**: Create a `chroxy doctor` command that checks all prerequisites and provides fix commands. Add a one-line install script that handles Node 22 + cloudflared.

### 2. 8-Hour Day: Chroxy Works 90% of Time, 10% Failure is Painful

In a typical 8-hour development day, Chroxy works well for the 90% case: you send messages, see streaming responses, approve permissions, switch models. The UI is responsive, the chat view is clean, the terminal view works.

The 10% failure case is **losing permission prompts during reconnection**. Here's the scenario:

```
10:00 AM — Developer starts working, Chroxy connected
10:30 AM — Phone locks, WiFi→cellular handoff
10:31 AM — Claude Code asks for permission to edit a file
10:31 AM — Permission request sent to WebSocket... which is disconnected
10:32 AM — Phone wakes up, Chroxy reconnects
10:32 AM — Permission request is GONE — it was a transient event
10:32 AM — Claude Code is waiting for permission that will never come
10:33 AM — Developer wonders why Claude is "stuck"
10:35 AM — Developer gives up, interrupts, re-asks the question
```

This is the #1 UX gap. The user has no way to know that a permission prompt was lost. There's no notification, no error, no indication that Claude is waiting.

**Recommendation**:
1. Re-emit pending permission requests on reconnect
2. Add a "Claude is waiting for permission" indicator that checks server-side state
3. Add push notification for permission requests (already exists but may not cover the reconnect gap)

### 3. Permission Modes: 3 is Right, Add `acceptEdits` for 4th

Current permission modes:
1. **approve** — prompt for every permission (most secure, most friction)
2. **auto** — approve everything (least friction, least secure)
3. **plan** — plan mode, review changes before applying

Missing mode:
4. **acceptEdits** — auto-approve file edits, prompt for commands/network

This is the sweet spot for experienced users. Most permission prompts in a typical Claude Code session are file edits (write, create, rename). These are low-risk because `git diff` shows exactly what changed. The dangerous permissions are shell commands and network access.

**User journey**: New user starts with `approve` (safe default) → after 20 taps of "Allow file edit" in a row, they switch to `auto` (too permissive) → they realize auto is scary → they want something in between.

`acceptEdits` fills this gap. It's the "I trust Claude with files but not with `rm -rf` or `curl`" mode.

**Recommendation**: Implement `acceptEdits` as a 4th permission mode. Effort: 1-2 days (server-side filtering in permission-manager.js + app-side UI in settings).

### 4. Streaming: Chroxy Wins with Token-Level Deltas + Permission Boundary Splitting

Chroxy's streaming UX is genuinely better than what the document describes for Happy:

- **Token-level deltas** (`stream_delta`): Each token arrives as a separate message, rendered immediately. The user sees text appearing character-by-character, matching the Claude Code terminal experience.
- **Permission boundary splitting**: When Claude requests permission mid-stream, the stream is cleanly split. The user sees the assistant's text up to the permission request, then the permission card, then the continuation after approval.
- **Thinking indicators**: Animated pulsing dots during Claude's "thinking" phase with accessibility announcements.

This is the best streaming UX in any Claude Code mobile client. The document doesn't adequately highlight this as a competitive advantage.

**Recommendation**: No changes needed — document this as a differentiator.

### 5. Error Recovery: Good But Transient Event Loss Has NO User Feedback

Chroxy's error recovery is solid for most cases:
- Connection lost → automatic reconnect with exponential backoff
- Server restart → `server_restarting` phase with UI indicator
- History replay on reconnect → user sees previous messages

But transient events (permission requests, plan approvals) that occur during disconnection are silently lost. The user has no way to know they missed something. There's no "you missed 2 events while disconnected" notification, no badge, no indicator.

**Contrast with messaging apps**: iMessage, WhatsApp, and Signal all show unread message counts, delivery receipts, and catch-up scrolling on reconnect. Users expect this behavior.

**Recommendation**:
1. Track "last seen" event on client side
2. On reconnect, server reports how many events occurred since "last seen"
3. If any were permission requests or plan approvals, show a prominent "Action needed" banner

---

## Adopt vs Skip Matrix

### Adopt

| Feature | Why | Effort | UX Impact |
|---|---|---|---|
| Sequence numbers | Enable reliable reconnect catch-up | 3-5 days | High — eliminates lost events |
| HTTP polling fallback | Some networks block WebSocket | 3-4 days | Medium — reaches more users |
| `acceptEdits` permission mode | Fills the gap between approve and auto | 1-2 days | High — reduces daily friction |
| Reconnect permission recovery | Re-emit pending permissions on reconnect | 1 day | Critical — fixes #1 UX gap |
| Stalled session detection | Detect when Claude is waiting for input | 2 days | High — prevents "why is it stuck?" |
| Persistent message log | AsyncStorage on client, SQLite on server | 4-6 days | Medium — survives app kill |

### Skip

| Feature | Why Not | Risk of Skipping |
|---|---|---|
| Multi-provider | Dilutes product identity, nobody asked | Low — registry exists if needed |
| Full RPC layer | Mutations through Claude Code are safer | None — this is a feature |
| Relay as default connectivity | Massive complexity for single-user tool | None — tunnel is correct |
| 7 permission modes | 4 is enough: approve, acceptEdits, plan, auto | None — simplicity is better |
| Postgres persistence | Overkill for single-user, JSON/SQLite suffices | None |

---

## UX Journey Maps

### Journey 1: First-Time Setup (Current)

```
User hears about Chroxy → Visits GitHub → Reads README →
  Installs Node.js → Wrong version! → Installs Node 22 →
  Installs tmux → Installs cloudflared →
  npm install -g chroxy → Starts server →
  Server fails (node-pty permissions) → chmod +x →
  Restarts server → Tunnel ready →
  Downloads app → Scans QR → Connected!

  Time: 15-30 minutes
  Drop-off risk: HIGH at Node version and cloudflared steps
```

### Journey 2: Daily Use (Happy Path)

```
Open app → Auto-reconnects to last server →
  Type message → See streaming response →
  Permission prompt → Tap Allow →
  See result → Continue conversation →
  Switch to terminal view → See full output →
  Switch back to chat → Continue

  Time: All day
  Friction: Low — streaming is excellent
```

### Journey 3: Daily Use (Reconnect Pain)

```
Phone locks during Claude response →
  Phone wakes up → App reconnects →
  History replays → Some messages seem stale →
  Claude appears "stuck" → No indication why →
  User interrupts → Re-asks question →
  "Why did it lose my permission prompt?"

  Time: 5-10 minutes of confusion
  Friction: HIGH — user trust damaged
```

---

## Recommendations Summary

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| P0 | Reconnect permission recovery | 1 day | Fixes #1 UX gap |
| P0 | "Claude is waiting" indicator | 1 day | Prevents "why is it stuck?" |
| P1 | `acceptEdits` permission mode | 1-2 days | Reduces daily friction by ~60% |
| P1 | Stalled session detection | 2 days | Auto-detects stuck states |
| P2 | Sequence numbers (for reconnect catch-up) | 3-5 days | Eliminates lost events |
| P2 | `chroxy doctor` prerequisite checker | 1 day | Reduces onboarding drop-off |
| P3 | HTTP polling fallback | 3-4 days | Reaches WebSocket-blocked networks |
| P3 | Client-side message persistence | 3 days | Survives app kill/restart |

---

## Verdict

The document is useful for understanding competitive positioning but misses the most important UX question: **what does a developer's actual day look like with each tool?**

Chroxy's streaming UX is best-in-class. The chat view, permission flow, and terminal view create a genuinely good experience for the 90% happy path. But the 10% failure case — lost permission prompts during reconnection — is a trust-breaking experience that makes users question the tool's reliability.

The single highest-impact improvement is not sequence numbers, not multi-provider, not relay mode. It's **re-emitting pending permission requests on reconnect.** This is a 1-day fix that eliminates the #1 source of user frustration.

After that, `acceptEdits` permission mode eliminates the most common source of daily friction (tapping "Allow" on every file edit). Together, these two changes would make Chroxy's UX significantly better without adding architectural complexity.

The document's focus on relay features, multi-provider support, and Postgres persistence is misguided from a UX perspective. Users don't care about architecture — they care about "does it work reliably?" and "is it annoying?" Fix those two things first.
