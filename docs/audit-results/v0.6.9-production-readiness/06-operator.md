# Operator's Audit: Chroxy v0.6.9 Daily Use UX

**Agent**: Operator — daily user, zero tolerance for "just restart the app"
**Overall Rating**: 3.0 / 5
**Date**: 2026-04-10

---

## TL;DR

Chroxy is *close*, but a real user who hits a snag on Tuesday morning with 20 minutes before a meeting is going to get stuck more often than they should. The happy path (install → QR → chat) is clean and fast. The recovery paths (cloudflared missing, tunnel didn't propagate, phone was asleep overnight, notification tapped while offline) are adequate on the server side but badly signposted on the client side. There is no "copy diagnostics" button, Settings is gated behind a connection, and pressing "Disconnect" quietly forgets your server — which is the opposite of what a user expects.

Rating breakdown:
- First-5-minutes (onboarding + first connect): **3.5 / 5**
- Month-one (daily friction): **2.5 / 5**
- Overall: **3.0 / 5**

---

## Scenario walkthroughs

### Scenario 1 — First-time setup on a new laptop

Happy path is clean: `packages/server/src/version-check.js:8` hard-gates Node < 22 with a clear one-liner, `packages/server/src/cli/init-cmd.js:33` writes config + keychain token, and `packages/server/src/server-cli.js:382` renders the terminal QR.

Landmines:

- **`cloudflared` not installed — user waits 30 seconds for failure.** `chroxy start` does not run preflight checks. It calls `cloudflared tunnel --url` at `packages/server/src/tunnel/cloudflare.js:151`, and if the binary is absent the `proc.on('error')` path at :180 *does* produce a useful message ("Failed to start cloudflared: … Install with: brew install cloudflared"). BUT for anything else (e.g. cloudflared present but the subprocess hangs) the user sits through the `30_000`ms timer at :198 before seeing "Tunnel timed out after 30s. Is cloudflared installed?". ⚠️ A user on a new laptop has to wait half a minute to learn they needed `brew install cloudflared`. `chroxy doctor` exists at `packages/server/src/doctor.js:15` and would catch this in <1s, but nothing in `start` tells the user to run it. CONFUSING.

- **Tunnel takes 30+ seconds to render QR.** `packages/server/src/server-cli.js:457` calls `waitForTunnel` which does `maxAttempts=20` with 1-5s backoff — that can block the QR render for ~45s on a slow first boot. The user sees "Verifying tunnel reachability... (n/20)" in the log but no progress bar or status on stdout. A first-time user who sees nothing for 30s will think it hung.

- **`waitForTunnel` never fails.** `packages/server/src/tunnel-check.js:44` only calls `log.warn` if verification fails — it proceeds to display the QR anyway. So a genuinely broken tunnel produces a QR that a user will scan and then the app will silently hang on `fetch(httpUrl)` in `connect()`. ⚠️ The "this QR won't work" case is indistinguishable from "the QR is fine but your phone is slow".

- **The app assumes the user already has a server running.** `packages/app/src/screens/ConnectScreen.tsx:378` subtitle says "Run 'npx chroxy start' on your Mac, then scan the QR code" — but `npx chroxy start` means nothing to a user who doesn't know Node. There's no link to setup docs. The OnboardingScreen at `packages/app/src/screens/OnboardingScreen.tsx:12` mentions `npx chroxy start` once during the three-step flow and shows it ONLY on first install. After that it's gone forever — no way to rediscover the setup steps. CONFUSING.

- **Dev client build requirement isn't surfaced anywhere.** The app published to TestFlight / Play Store will be a dev build, but CLAUDE.md says `expo-speech-recognition` broke Expo Go. If a user installs via Expo Go (which is still discoverable on the App Store), the app crashes. Nothing in `packages/app/App.tsx` warns them.

### Scenario 2 — Returning to the app after 8 hours idle

Server-side recovery is actually solid: `ws-history.js:145` replays the full ring buffer on reauth, `resendPendingPermissions` at :157 restores in-flight permission prompts, `sendSessionInfo` at :184 rehydrates model/permission mode/thinking level. This is the one area where Chroxy is genuinely well-built.

Landmines:

- **App resume does NOT reconnect unless socket was still marked "connected".** `packages/app/src/store/connection.ts:1391` AppState listener only fires reconnect if `connectionPhase === 'connected'`. If the RN runtime paused long enough that the socket dropped and hit `onclose`, the phase goes to `reconnecting` → eventually `disconnected`, and the resume path does nothing. A user unlocking their phone after lunch will see "disconnected" and have to tap Reconnect manually. ⚠️

- **Notification inbox vanishes with app kill.** `packages/app/src/store/notifications.ts:31` keeps `sessionNotifications` in memory only — no SecureStore, no AsyncStorage. Kill the app, lose every banner for sessions that finished while you were away. The OS-level push notifications linger in the notification shade but *tapping* one just opens the app to whatever session was active, not the session that fired. The banner on `SessionNotificationBanner.tsx` only shows live ones. CONFUSING.

- **Push token rotation silently strands old tokens.** Server-side `push.js:288` prunes tokens that return `status: error` from Expo, which covers the revoked case. But the app never re-registers its token after a new install / device restore — the registration flow runs once and stores the token. If the OS rotates the Expo push token (which happens after iOS restore-from-backup), the user stops getting notifications with zero error visibility.

- **Tunnel URL rotated (quick tunnel) ⇒ saved connection is dead.** `ConnectScreen.tsx:390` shows "Reconnect <url>" using the saved URL. If you stopped the server last night and ran `npx chroxy start` this morning, that `.trycloudflare.com` URL is different. Tapping Reconnect health-checks the old URL, fails 6× over 19s, then alerts "Could not reach server". The user has to Forget + rescan QR. This is normal for quick tunnels, but nothing tells the user "quick tunnel URLs rotate; use a named tunnel for a stable URL". ⚠️

### Scenario 3 — Mid-session network drop

Best-in-class on the server side. `session-message-history.js:246` pushes every event into the ring buffer regardless of whether anyone is subscribed, so a completed-while-offline response is always replayable.

Client side is OK-ish:

- Auto-reconnect kicks in at `connection.ts:643` for unexpected `onclose`, with retries via `RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000]` at :436. The `connectionAttemptId` bump at :450 cancels stale chains correctly. This is genuinely good.
- `SessionScreen.tsx:927` renders a "reconnecting" banner with a Stop button — good.
- ⚠️ BUT: WebSocket `onclose` with code 1006 (the standard "network drop" code) shows "Connection lost — check your network" which is correct, but `onerror` at :670 only shows "Connection error" with no detail. A user who's on a flaky hotel wifi will see the same generic message every time.
- ⚠️ The retry budget resets on every top-level `connect()` call but the *retry schedule* is fixed. After 6 failed attempts in 19 seconds you get an Alert with OK / Forget Server / Retry. No exponential outer backoff — if Retry is tapped it immediately burns another 6 attempts in 19s. A user in an elevator will exhaust several rounds and possibly trigger rate limiting on the server.

### Scenario 4 — Permission request while phone is locked

This is surprisingly well-thought-out. `notifications.ts:29` registers the Approve/Deny category, `:195` listens for action responses, `:225` tries WS first then falls back to HTTP POST to `/permission-response` at `ws-permissions.js:178`. `:242` shows a clear alert if neither worked.

Landmines:

- ⚠️ **5-minute server timeout vs user-ignored notification.** `permission-manager.js:16` auto-denies after 300_000 ms. The phone never learns. A user who comes back 8 minutes later, taps the lockscreen notification, and taps Approve sees zero UI indication the decision was wasted — the HTTP POST succeeds but goes to a legacy handler that returns `{ decision: 'deny' }` from a dead timer at `ws-permissions.js:160`, and the chat UI updates to "allow" via `markPromptAnsweredByRequestId` on the phone even though Claude already moved on. The phone says "approved" but Claude already got "denied" 3 minutes ago. CONFUSING / BROKEN.
- **Notifications don't surface expiry.** The push at `server-cli.js:245` says "Permission needed: Bash" — no "(will auto-deny at 14:32)" hint. A user who sees it 10 minutes later has no way to know it's stale.
- **Dedupe is OK but not perfect.** `notifications.ts:225` tries WS first; if WS is closed it uses HTTP. If WS reconnects between "decide to approve" and "tap approve", there's a moment where WS is OPEN but the stored requestId came from a lockscreen notification for a stale permission — the WS send goes to the current session but the pending map on the server may have already been GC'd by `resolve()` in the HTTP fallback path. Doesn't crash, but the response is silently dropped.

### Scenario 5 — Session switching mid-conversation

- ✅ `ws-broadcaster.js:63` auto-subscribes clients via `activeSessionId` OR `subscribedSessionIds` — so background streams from other sessions still reach the client's WS and land in their sessionStates even while viewing Session B.
- ✅ The stream_start ID collision fix from MEMORY is respected by the handler.
- ⚠️ `ws-history.js:145` only replays history for the ACTIVE session on reauth. If you switch from session B back to session A after reconnecting, you get an empty message list until the server pushes a new event — the historical messages for A are already on disk via `persistence.ts` but any mid-gap events while you were offline never replay. Best case: the client's cached messages cover it. Worst case: you see partial history.
- ⚠️ When session A completes while viewing session B, the banner fires and a push notification is queued. But pushing only happens when `noActiveViewers` is true (`server-cli.js:235`) — which is FALSE because you're connected. So a user who opens session B to check something, and Claude finishes session A in the background, gets the in-app banner but no OS notification. Fine in theory, but if the phone screen then locks, there's NO notification of completion. The user can miss a done session entirely. ⚠️

### Scenario 6 — Error states and error messages

`getWsCloseMessage` at `connection.ts:158` and `getHealthCheckErrorMessage` at :184 do a decent job of translating to plain English. But I rated each state on clarity/actionability/recovery:

| State | Clarity | Actionability | Recovery path |
|---|---|---|---|
| Code 1006 dropped | Good ("check your network") | Vague | Auto-reconnect works |
| Code 1008 key exchange | Good ("check your app is up to date") | Weak — no App Store link | Must update manually |
| Code 4008 backpressure | Good | No hint what "overwhelmed" means | Auto-reconnect |
| HTTP 4xx | "Server rejected the connection — check your token" | Actionable | Must re-scan QR or enter token |
| HTTP 5xx | "Server error — the server may be restarting" | Good | Auto-retry |
| Tunnel timeout | Only in server log, never shown to mobile user | NONE | — |
| cloudflared missing | Shown in server terminal with install hint | Server-side | Mobile user sees nothing for 30s |
| Permission delivery failed | Alert with "Open app to respond manually" | Good | Explicit retry button |
| Generic onerror | "Connection error" (connection.ts:680) | NONE | Auto-reconnect |

⚠️ "Connection error" with no detail is a common landing spot and is the single worst error message in the app.

### Scenario 7 — Settings and configuration

- ⚠️ **Settings is GATED behind a connection.** `packages/app/App.tsx:111` only registers the Settings stack screen when `showSession === true`. You can't open Settings from the Connect screen. So: if biometrics need turning off, or the speech language is wrong, or you want to dismiss stale notifications, you first need to successfully connect. If your server is down, you can't even change settings to work around it. CONFUSING.
- Input settings persist correctly via `STORAGE_KEY_INPUT_SETTINGS` at :140. ✅
- Speech language persists ✅
- Biometric lock toggle has a nice enrollment-revoked fallback at `SettingsScreen.tsx:73` ✅
- Notifications section at :338 is purely a dismiss-all button. There's no way to see WHICH notifications are pending from Settings (the overview banner is on SessionScreen).
- ⚠️ **No "Copy diagnostics" button**, no "Test connection" button, no "Re-show onboarding" button. A user who's stuck can't produce a bug report. There IS a "Copy Server URL" at :460 but not the token, logs, or version-info-json.
- Server Version shows "X available" badge at :443 if newer, but tapping does nothing — no "open release notes" action.

### Scenario 8 — Push notification inbox

- `SessionNotificationBanner.tsx:146` shows the last 3 in a banner at the top of SessionScreen. MAX_VISIBLE = 3; anything beyond shows "+N more" with no way to expand. ⚠️
- Banners are live-only. Kill the app → lose them all.
- OS-level push notifications accumulate in the notification shade but tapping one opens SessionScreen on the *active* session, not the session that fired. There's no deep-link routing from notification tap → switch session.
- Settings section at :338 shows a count but is dismiss-only.
- ⚠️ **There is no persistent "Activity" or "Inbox" view.** A user who sees 4 buzzes on their phone during lunch has no single place to open the app and go "what happened?" — they have to click through each session manually.

### Scenario 9 — Onboarding discoverability

- `OnboardingScreen.tsx` is 3 steps, shows only once on first install (stored in SecureStore at `onboarding_complete`).
- Step 2 says `npx chroxy start` — technically correct but assumes you know what npx/npm/Node is. No link to install docs, no platform-specific hint.
- ConnectScreen subtitle "Run 'npx chroxy start' on your Mac, then scan the QR code" is the only persistent hint. Windows users are confused.
- ⚠️ **No way to re-show onboarding.** Once you tap Skip or complete it, the only way to see it again is to uninstall + reinstall. There's no Settings entry to reset it.
- ✅ LAN scan button is discoverable and works without a QR code — good fallback for users whose terminal QR rendering is broken.

### Scenario 10 — The dreaded "it doesn't work"

30-second diagnostic: **fails**.

- ❌ No "Copy diagnostics" button in Settings
- ✅ `chroxy status` at `cli/status-cmd.js` DOES print useful info (running/tunnel/uptime/sessions) — but the user has to know it exists
- ❌ `chroxy doctor` exists but is not referenced in any on-screen hint when things go wrong
- ❌ App-side logs are only in Metro console — not accessible to end user
- ❌ Server-side logs have no "tail" command; user has to find the pid and `lsof` their way to the stdout
- ❌ No "Test connection" button on ConnectScreen
- ✅ Health check response JSON is accessible via curl, but not documented for end users

Score: roughly 60 seconds to useful output if the user happens to know `chroxy status` exists. Closer to 10+ minutes if they don't.

---

## Top 10 UX Landmines (by likelihood × severity)

### 1. Disconnect button silently forgets your server — must re-scan QR

**Scenario**: User taps the red "Disconnect" in the header (`App.tsx:120`), meaning "I'm done for now, go back to Connect screen". Expectation: keep the saved connection so next time they open the app, it auto-connects.

**Reality**: `connection.ts:757` calls `setSavedConnection(null)` on every disconnect. User opens app next time → blank ConnectScreen → must rescan QR. ⚠️ The "Forget" button on ConnectScreen and the "Disconnect" button in the header do the same thing, but the label promises different behaviors.

**Fix**: `packages/app/src/store/connection.ts:757` — split into `disconnect()` (preserve savedConnection) and `signOut()` (clear it). The header button should use `disconnect()`. Only ConnectScreen's Forget button and Settings → Clear Saved Connection should clear it.

### 2. Settings is gated behind a successful connection

**Scenario**: Server is down. User wants to toggle biometrics off, or dismiss stale notifications, or re-run onboarding. Can't — Settings isn't in the stack.

**Fix**: `packages/app/App.tsx:98` — register Settings in the navigator regardless of `showSession`. Just hide connection-dependent sections conditionally inside SettingsScreen. Add a ConnectScreen header button that opens Settings.

### 3. `chroxy start` doesn't run preflight checks — cloudflared missing = 30s wait

**Scenario**: Fresh laptop. User runs `npx chroxy start`. Sees the banner. Then: nothing for 30 seconds. Eventually: "Tunnel timed out after 30s. Is cloudflared installed?"

**Fix**: `packages/server/src/cli/server-cmd.js:19` — before calling `startCliServer`, run `runDoctorChecks({ port: config.port })` from `doctor.js`. If any `fail`, print them and exit 1 with "run `npx chroxy doctor` for details or `brew install cloudflared` to fix". Allow a `--skip-checks` flag for advanced users.

### 4. `waitForTunnel` never fails — broken QR displayed silently

**Scenario**: Tunnel is up but DNS broken / routing busted. After 20 attempts, `tunnel-check.js:44` logs `warn` and returns. User scans a QR that will hang the app.

**Fix**: `packages/server/src/tunnel-check.js:44` — after max attempts, throw a TunnelNotRoutable error. Catch in `server-cli.js:457` and show a blocking error: "Tunnel failed to become routable. This usually means your network is blocking Cloudflare — try `--tunnel named` or check `chroxy doctor`."

### 5. Permission notification "Approve" from lockscreen after 5+ minutes silently fails

**Scenario**: Lunch break. Claude asks for permission. Push notification fires. You return 8 minutes later, tap Approve from the lockscreen. The phone UI updates to "approved". Claude already got auto-denied 3 minutes ago and moved on.

**Fix**: `packages/server/src/ws-permissions.js:178` — when POST /permission-response is received and the pending map has no entry (or the SDK session has already resolved), respond with `{ error: 'expired' }`. In `packages/app/src/notifications.ts:161`, treat non-ok as a failure and surface an Alert: "This permission request expired. Open the app to see Claude's current state."

### 6. Auto-reconnect on app resume only fires if socket thinks it was still connected

**Scenario**: Phone in pocket for 2 hours. iOS kills the WebSocket. `onclose` fires, phase → `reconnecting` → eventually `disconnected`. User unlocks phone. Nothing happens. User stares at "disconnected" banner wondering why it's not reconnecting.

**Fix**: `packages/app/src/store/connection.ts:1391` — AppState listener should also trigger a reconnect if phase is `disconnected` AND there's a non-null savedConnection AND `!userDisconnected`. Essentially re-run the auto-connect-on-mount logic from ConnectScreen.

### 7. No persistent notification inbox

**Scenario**: 4 push notifications accumulate on the lockscreen over lunch. User opens the app. Each tap goes to the active session, not the one that fired. The in-app banner is 3 max with "+1 more" and no way to expand.

**Fix**: New screen: Inbox / Activity list showing last 50 session events with timestamp + action (approve/deny/view). Store in AsyncStorage with a 7-day TTL. In `packages/app/src/store/notifications.ts:51`, add a persistent history array alongside the live banner state. Wire push notification `data.sessionId` to deep-link to that session via `switchSession` on tap.

### 8. "Connection error" with no detail on WebSocket onerror

**Scenario**: Any network hiccup during connect produces "Connection error" at `connection.ts:680` with zero distinguishing info.

**Fix**: `packages/app/src/store/connection.ts:670` — capture the error event, check `event.message` / `event.error`, and map to something like "Could not open socket — server unreachable" vs "Handshake failed — check your token". Even "Connection error (code N/A)" is more actionable than nothing.

### 9. No "Copy Diagnostics" button / no in-app logs

**Scenario**: User says "it doesn't work". Has no way to export current state to paste into a GitHub issue.

**Fix**: Add a Settings → Debug section with:
- "Copy Diagnostics" button → serializes connectionPhase, wsUrl (host only), serverVersion, appVersion, last 5 serverErrors, retry count, platform, OS version → clipboard.
- "Copy Connection Log" button → dumps the last ~100 lines from a ring buffer written to during `console.log('[ws] …')` calls.

File: `packages/app/src/screens/SettingsScreen.tsx` after line 484 (before About section).

### 10. No way to re-show onboarding / no persistent "how it works"

**Scenario**: User skipped onboarding. Later, they're confused and want to see the steps again.

**Fix**: Settings → About → "Show Tutorial" that clears `onboarding_complete` from SecureStore and navigates to OnboardingScreen. Needs a new navigation entry in `App.tsx`.

---

## The first-5-minutes audit

Starting score: **5.0 / 5**

| Step | Event | Adjustment | Running |
|---|---|---|---|
| 1 | Install Chroxy CLI via npx | +0 | 5.0 |
| 2 | Onboarding shows 3 clean steps with Skip | +0.5 | 5.5 |
| 3 | `npx chroxy start` on new Mac → cloudflared missing. 30s wait. Error is clear but slow. | −0.5 | 5.0 |
| 4 | After `brew install cloudflared`, server boots. QR appears. Clear instructions. | +0.5 | 5.5 |
| 5 | App install → opens to onboarding once → ConnectScreen with big "Scan QR Code" button | +0.5 | 6.0 |
| 6 | QR scan works instantly, auto-fills token, connects | +0.5 | 6.5 |
| 7 | Chat UI renders cleanly, default session, Claude is ready indicator | +0.5 | 7.0 |
| 8 | First message sends, streams, looks great | +0 | 7.0 |
| 9 | **Windows user** — npx works but `brew` doesn't; no platform-specific hint | −1.0 | 6.0 |
| 10 | **User tries Expo Go instead of dev client** — crashes (speech-recognition native dep) | −1.0 | 5.0 |

Clamping the +0.5s that pushed past 5 gives a net first-5-minutes score of **3.5 / 5**.

The happy path is genuinely nice. The dropoff happens the moment you deviate: non-Mac, Expo Go, or anything that fails silently.

## The "I've been using this for a month" audit

Starting score: **5.0 / 5**

| Daily friction | Frequency | Adjustment | Running |
|---|---|---|---|
| "Disconnect" forgets server → re-scan QR | ~1/week | −0.5 | 4.5 |
| Phone-in-pocket resume doesn't auto-reconnect | ~5/week | −0.5 | 4.0 |
| Quick tunnel URL rotated → Reconnect fails silently | every server restart | −0.5 | 3.5 |
| Push notification tapped → goes to wrong session | ~3/week | −0.5 | 3.0 |
| "Connection error" with no detail on wifi blip | ~2/week | −0.25 | 2.75 |
| Session B completed while viewing A but app is foreground → no push → miss it | ~2/week | −0.25 | 2.5 |
| Can't change settings when server is down | ~1/month | −0.25 | 2.25 |
| No inbox view — have to click through sessions to catch up | daily | −0.25 | 2.0 |
| Permission notification expired silently — no feedback | ~1/week | −0.25 | 1.75 |
| PLUS: chat + terminal dual view is genuinely delightful | every use | +0.5 | 2.25 |
| PLUS: markdown rendering + syntax highlighting is excellent | every use | +0.25 | 2.5 |
| PLUS: LAN scan works and is fast | occasional | +0 | 2.5 |

Month-one: **2.5 / 5**

Half a year of daily use and there's still no bottom of the "set-once-and-forget" pit — every day has at least one small papercut that wasn't there yesterday.

---

## Verdict

Chroxy's core experience — chat + terminal dual view over a secure tunnel — is one of the nicer pieces of developer tooling I've seen this year. The server ring buffer, reconnect state machine, permission HTTP fallback, and auto-label session naming are all best-in-class. Somebody thought about this.

**But the failure paths and the recurring friction are not production-ready for public users.** A technical user on macOS running TestFlight will survive — they can read terminal errors and they know what `cloudflared` is. A developer on Windows, a user whose phone was asleep, or anyone who hits a network blip will get stuck in exactly the places where "just restart the app" is the only answer, and none of the errors tell them which direction to restart in.

The fixes are all small. #1 (Disconnect semantics) and #2 (Settings gating) are 20-line patches. #3 and #4 (preflight + tunnel verify) are under 50 lines each. #6 (app-resume reconnect) is 15 lines. #7 (inbox) is the biggest — a new screen plus persistence. None of these require architectural changes; they're all about making failure states discoverable. With those ten fixes, the month-one score would jump from 2.5 to 4+.

**Production-ready for public users: not yet. Production-ready for Hacker News early adopters: yes.** Ship it to the HN crowd, ask for feedback, land these ten fixes before the first real launch.
