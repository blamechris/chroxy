# Operator's Audit: Chroxy Daily User Experience

**Agent**: Operator -- Product-minded engineer who uses the app daily
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-21

---

## Daily Workflow Walkthrough

### Launch

Open the app. Three scenarios:

1. **First launch:** ConnectScreen with QR scan button, LAN scan, manual entry. No guidance on what to do first. You need to already know to run `npx chroxy start` on your machine.

2. **Returning with saved connection (server up):** Auto-connect kicks in immediately. Spinner shows "Connecting to [url]..." with a Cancel button. If the server is up, you are in the session within 2-3 seconds. This is smooth.

3. **Returning with saved connection (server down):** Auto-connect spinner runs for ~19 seconds (full 6-attempt retry chain: 1s + 2s + 3s + 5s + 8s delays) before falling back to ConnectScreen. This feels broken. The user stares at a spinner with no feedback about what is happening.

### Auto-Connect -- Correction from Prior Claims

Previous audit notes claimed auto-connect was "not implemented" or "partial." **This is incorrect.** Auto-connect is fully implemented at `ConnectScreen.tsx:79-98`:

```typescript
// Load saved connection and auto-connect on mount
useEffect(() => {
  let mounted = true;
  loadSavedConnection().then(() => {
    if (!mounted) return;
    const saved = useConnectionStore.getState().savedConnection;
    if (saved) {
      setAutoConnecting(true);
      connect(saved.url, saved.token, { silent: true });
    }
  });
  return () => { mounted = false; };
}, []);
```

The connection is saved to SecureStore on successful connect and loaded on mount. The fallback at lines 93-98 drops back to ConnectScreen if connection phase returns to `disconnected`.

**What IS missing:** timeout tuning for the auto-connect path and visual feedback during the retry process.

### Session Interaction

Once connected, the experience is good:
- Messages send and stream back in real-time
- Permission prompts appear with rich detail (file paths, tool names, descriptions)
- Tool use is shown as collapsible bubbles with tap-to-expand detail modal
- Thinking indicator (3 pulsing dots) shows Claude is working
- Markdown renders well with inline code highlighting and blockquotes
- Scroll-to-top/bottom buttons help with long conversations

### Disconnect and Reconnect

- **Network drop:** Auto-reconnect works well. ConnectionPhase transitions to `reconnecting`, retries, and replays history on success. Chat history is preserved.
- **Server restart (named tunnel):** Phase transitions to `server_restarting`, supervisor handles restart, client reconnects automatically. Smooth.
- **User-initiated disconnect:** Clears `savedConnection` and `lastConnectedUrl`. Next launch shows ConnectScreen fresh. **Problem:** There is no confirmation dialog. Tapping the wrong thing loses your saved connection.

---

## Friction Points

### 1. 19-Second Spinner on Failed Auto-Connect
When the server is not running, the auto-connect spinner blocks the UI for ~19 seconds. Users will think the app is frozen. A 3-second fast-fail for auto-connect would be much better, with the full retry chain reserved for reconnection scenarios.

### 2. Accidental Disconnect Clears savedConnection
`connection.ts:2339` sets `savedConnection: null` on disconnect. If you accidentally hit disconnect, you need to re-scan the QR code or re-enter the URL. There should be a confirmation dialog, or `savedConnection` should persist through disconnects (only cleared on explicit "Forget Server" action).

### 3. Chat/Terminal Toggle is Undifferentiated
The dual-view chat/terminal toggle works, but there is no visual cue about which view has new content. If Claude is streaming output and you are in terminal view, you miss it in chat view and vice versa. A badge or indicator on the inactive tab would help.

### 4. No Queued Message Feedback
If you type a message while Claude is still responding, there is no indication that your message is queued. It just sits in the input field. A "waiting to send..." indicator would reduce anxiety.

---

## Error States

### Good
- Reconnection infrastructure is excellent. `ConnectionPhase` state machine handles all transitions cleanly.
- `server_error` WS message forwards server-side errors to the app for display.
- Tunnel crash recovery is automatic.

### Needs Work
- Error messages are terse. "Connection failed" does not tell you if the server is down, the tunnel is broken, or the token is wrong.
- Auth failure (`auth_fail`) shows "Authentication failed" with no guidance. Should suggest re-scanning QR code.
- Rate limiting (`rate_limited`) shows a generic error. Should tell the user to wait.

---

## Permission UX

### What Works Well
Permission prompts render rich detail: the tool name, file paths affected, and a description of the operation. The approve/deny buttons are clear. Plan mode approval with the PlanApprovalCard is intuitive.

### What Is Missing

1. **acceptEdits mode.** This is the most common permission mode for daily Claude Code use -- auto-approve file edits but prompt for everything else. It does not exist in Chroxy. Users must choose between "approve everything" (auto), "approve nothing" (approve), or "plan mode." The middle ground is missing.

2. **"Always Allow" is unclear.** The `bypassAll` mode is labeled in the codebase but its UX presentation in the permission mode picker needs review. Does the user understand what "bypass all" means? Should it be "Auto-approve all"?

---

## Accessibility

### Present
- Thinking indicator has a11y announcements (`accessibilityLiveRegion`)
- Buttons have accessibility labels
- Color scheme is high-contrast dark theme

### Missing
- No Dynamic Type support. Font sizes are hardcoded. Users with vision impairments cannot scale text.
- Some color contrast ratios may not meet WCAG AA (specifically lighter gray text on dark backgrounds in the settings bar and status displays).
- Terminal view via WebView is a black box for accessibility -- screen readers cannot read xterm.js content.
- Tab roles for chat/terminal toggle are not set. VoiceOver users do not know these are tabs.

---

## Phone-on-the-Go Scenario

Using Chroxy while walking or on transit:

- **Heartbeat works.** The WebSocket ping/pong keeps the connection alive through brief signal drops.
- **Rapid reconnects cause jank.** If you enter/exit a tunnel or elevator, the reconnection attempts fire rapidly. The UI flickers between `reconnecting` and `connected` states. A debounce on the connection status display would help.
- **One-handed use is possible.** The input bar is at the bottom, send button is thumb-reachable. The settings bar at the top is harder to reach but used less frequently.
- **Landscape is not supported.** Issue #618 tracks this. Portrait-only is fine for phone but limits tablet use.

---

## Top 5 Recommendations

1. **Add disconnect confirmation dialog.** A simple "Disconnect from server?" modal before clearing `savedConnection`. Prevents accidental loss of saved connection credentials.

2. **Implement acceptEdits permission mode.** The most common Claude Code workflow uses this mode. Without it, Chroxy forces users into extremes (full manual approval or full bypass).

3. **Add queued message feedback.** When the user sends a message while Claude is responding, show "Message queued..." or similar in the input area. Reduces "did my message go through?" anxiety.

4. **Reduce auto-connect timeout.** Change the auto-connect path to 1 attempt with a 3-second timeout. If it fails, immediately show ConnectScreen. Reserve the full 6-attempt retry for reconnection (where the server was previously reachable).

5. **Separate disconnect from forget.** Two actions: "Disconnect" (drops connection but preserves `savedConnection` for next launch) and "Forget Server" (clears everything). Currently disconnect does both, which is destructive.
