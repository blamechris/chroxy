# Operator UX Audit: Chroxy Self-Update Loop

**Agent**: Operator -- mobile-first UX designer and daily power user
**Overall Rating**: 2.6 / 5
**Date**: 2026-02-09

---

## Executive Summary

The existing app is well-built for chatting with Claude remotely. Components are clean, patterns consistent, mobile UX basics solid. However, the self-update loop introduces a fundamentally new interaction paradigm (the app must survive its own server dying) and the current codebase is not ready for it. The navigation model (binary `isConnected` switching) is the most critical structural flaw.

---

## Section-by-Section Ratings

| Section | Rating | Summary |
|---------|:------:|---------|
| Happy Path Walkthrough | 3/5 | Chat UI excellent. Reconnection bounces user to ConnectScreen (hostile). |
| Error State UX | 2/5 | Minimal. No deploy failure UI. No rollback notification. Stale lock = dead end. |
| Reconnection Experience | 2/5 | "Reconnecting..." banner is generic. No phase distinction. No progress. |
| Version Awareness | 2/5 | `serverVersion` stored but never displayed anywhere in UI. |
| First-Time Setup | 3/5 | Named Tunnel CLI is reasonable for devs. No guidance on WHEN to set up. |
| Cognitive Load | 3/5 | Architecture hides complexity well. "npx chroxy deploy" trigger is a gap. |
| Missing UX Patterns | 2/5 | No deploy trigger button, no rollback button, no progress bars, no push notifications. |
| Accessibility | 3/5 | Good baseline. Missing `accessibilityLiveRegion` on banners. Permission buttons undersized. |

---

## Happy Path Walkthrough

Walking through the self-update loop on my phone:

1. **Open app** -- ConnectScreen. No auto-connect. Must tap "Reconnect" every time.
2. **Send instruction** -- Clean chat UI with collapsible tool groups. Excellent.
3. **Claude modifies files** -- ActivityGroup shows "Working... (3 tools)". Good.
4. **Server restarts** -- WebSocket closes. **BAM -- dumped to ConnectScreen.** All visual context lost. This is the #1 UX break.
5. **Reconnection** -- If same URL (Named Tunnel), messages preserved via `isReconnect`. If Quick Tunnel, URL changed, reconnect fails entirely. Dead end without SSH.
6. **Continue working** -- After the screen-flash, back to normal. Jarring but functional.

---

## The Navigation Guard Problem

The root cause of bad restart UX: `App.tsx` line 30 uses `isConnected` as a hard gate. When WebSocket closes → `isConnected = false` → SessionScreen unmounts → all React local state destroyed (scroll position, input text, expanded settings, modal state) → user sees ConnectScreen flash → reconnect → back to SessionScreen (fresh mount).

The architecture's `connectionPhase` enum is the correct fix. Keep SessionScreen mounted during transient disconnections. Only show ConnectScreen for `initial`, `failed`, `disconnected`.

---

## Top 5 UX Improvements (Priority Order)

### 1. Replace navigation guard with `connectionPhase` enum (CRITICAL)
Keep user on SessionScreen during `server_updating`, `reconnecting`, `slow_polling`, `dormant`. This transforms restart from "app crash" to "brief pause."

### 2. Never clear `savedConnection` on retry exhaustion
Lines 505-507 of `connection.ts` permanently destroy saved credentials after 5 failed retries. With Named Tunnels (permanent URL), this forces unnecessary QR re-scan. Only clear on explicit user action or auth failure.

### 3. Add restart/update phase banner with progress
Differentiate "Server restarting... (validating)" from "Connection lost. Retrying in 3s..." based on close code 4000 vs 1006.

### 4. Add auto-connect on app launch for saved connections
After `loadSavedConnection()` returns saved credentials, auto-call `connect()`. Show "Connecting to [url]..." state. Eliminates one tap on every app open.

### 5. Add in-app deploy trigger and version confirmation
Deploy button in expanded SettingsBar. After deploy: "Server updated to abc1234" success banner. After failure: persistent error banner with rollback option.

---

## Missing Interaction Patterns

- No deploy trigger from app (must type command or SSH)
- No undo/rollback button
- No deploy progress bar (7 phases invisible)
- No toast/notification for background events
- No push notifications
- No message queue indicator
- No confirmation before disconnect (accidental tap risk)
- No haptic feedback for permission prompts and state changes
- No dark/light mode toggle for outdoor use
