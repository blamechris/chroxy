# Operator's Audit: Chroxy Security Architecture

**Agent**: Operator -- Daily user who encounters every error state and UX frustration
**Overall Rating**: 3.2 / 5
**Date**: 2026-02-12

## Verdict

Chroxy is **usable but frustrating**. Core functionality works reliably, but silent failures dominate the experience. Error messages don't guide recovery, and edge cases break the app.

## Section UX Ratings

### 1. Connection Flow: 3.5/5
**Works**: QR scanning, health checks, auto-reconnect, exponential backoff
**Fails**:
- No progress indicator during 5s health check
- Server restart shows generic "Connecting..." not "Server is restarting..."
- Max 5 retries too low (19s total, Cloudflare needs 20-30s)
- No Retry button after exhausted retries

### 2. Error Messages: 2/5
**Works**: Auth failures show reason (`invalid_token`, `rate_limited`)
**Fails**:
- Generic "Connection Failed" doesn't distinguish: server down / tunnel not ready / token invalid / network unreachable
- Permission timeout (5 min) auto-denies **silently** - user has no idea why
- Session crash shows "crashed" but no actionable recovery
- Tunnel recovery never reaches app UI

### 3. Recovery: 2.5/5
**Works**: Auto-reconnect on disconnect, state serialization, respawn on crash
**Fails**:
- Permission timeout requires app restart (can't retry)
- Session crash leaves broken state (no restart button)
- Tunnel URL change requires manual reconnect (QR re-scan)
- Network handoff (WiFi → cellular) often fails (retry exhaustion)
- Multi-device input race (no warning when other device active)

### 4. Edge Cases: 2/5
**Works**: Stale socket detection, delta batching, race guards
**Fails**:
- Session switch mid-message breaks state
- Backgrounded app + permission = silent failure (push notification but no in-app indicator)
- Quick Tunnel URL change during session (stays connected to old tunnel)
- Message queue exhaustion (max 10, 11th silently dropped)
- Session creation during network blip (hangs forever, no timeout)

### 5. Accessibility: 3/5
**Works**: VoiceOver support, color contrast, touch targets
**Fails**:
- Permission buttons lack screen reader context
- Thinking indicator is visual-only (VoiceOver doesn't know Claude is working)
- Connection status is color-coded only (no text label)

### 6. Performance: 3.5/5
**Works**: Delta batching, terminal write batching, 30s ping interval
**Fails**:
- Excessive re-renders on multi-session switching (spread entire sessionStates map)
- Message queue drain floods server (no throttling)
- xterm.js full replay on every terminal view switch (2-3s on old devices)

## TOP 5 UX FAILURES

### 1. Permission Timeout Has No Warning 🔴 Critical
**Frequency**: Every tool permission
**Impact**: User backgrounds app → returns 6min later → "Permission denied" → no idea why

**Fix**: Send `permission_timeout_warning` at 4min 30s, show countdown notification

---

### 2. Session Crash Leaves Broken State 🔴 Critical
**Frequency**: ~1-2x/day
**Impact**: Claude crashes → app shows error → can't send messages → must create new session, lose context

**Fix**: Add "Restart Session" button, preserve history

---

### 3. Tunnel URL Change Requires Manual Reconnect 🟡 High
**Frequency**: ~1x/week (Quick Tunnel only)
**Impact**: Tunnel URL changes → old tunnel dies → connection drops → re-scan QR → lose all sessions

**Fix**: Handle `tunnel_url_changed` event, auto-reconnect to new URL

---

### 4. No Indication of Other Connected Devices 🟡 High
**Frequency**: Multi-device users
**Impact**: Phone types message → tablet types at same time → phone's message silently dropped

**Fix**: Show "3 devices connected", warn when another device becomes primary

---

### 5. Generic "Connection Failed" 🟡 High
**Frequency**: ~1x/day
**Impact**: User doesn't know if server is down / tunnel starting / token wrong / WiFi blocking

**Fix**: Parse health check failure reason, show specific error

---

## Concrete Recommendations

### P0 (Fix Immediately)
1. **Permission timeout warning** (ws-server.js:1659)
   - Emit event at 4min 30s
   - Show in-app countdown
   - Allow retry on timeout

2. **Session crash restart button** (connection.ts:778)
   - Detect `health: 'crashed'`
   - Show "Restart" and "Create New" options

3. **Connection status during health check** (connection.ts:1600)
   - Parse `{status: 'restarting'}`
   - Show "Server is restarting..." not "Connecting..."

### P1 (Fix This Week)
4. **Handle tunnel URL changes** (tunnel.js:249)
   - Auto-reconnect to new URL
   - Show "Server moved, reconnecting..." toast

5. **Show connected devices** (connection.ts:1345)
   - Display "3 devices connected" in settings
   - Warn when another device becomes primary

6. **Specific connection failure messages** (connection.ts:1636)
   - Parse HTTP status
   - Show actionable errors

### P2 (Fix This Month)
7. **Increase retry attempts** (10 instead of 5)
8. **Session creation timeout** (10s)
9. **Thinking indicator accessibility** label
10. **Optimize session state updates** (only spread modified session)

## Daily Use Pain Points

**Morning (First Connect):**
- ✅ QR scan works great
- ❌ Health check delay feels like freeze
- ❌ Retries exhaust too fast

**During Work:**
- ✅ Streaming responses smooth
- ❌ Permission timeout ruins flow
- ❌ Session crash requires new session
- ❌ Multi-device confusion

**Network Handoff:**
- ❌ Often fails to reconnect
- ❌ No auto-retry

**End of Day:**
- ✅ Graceful shutdown preserves sessions
- ❌ Quick Tunnel URL change loses state

## Overall Verdict: 3.2/5

**Usable but frustrating**. Power users develop workarounds, but casual users abandon after 2-3 permission timeouts. The technical foundation is solid — **the UX layer needs polish**.
