# Operator's Audit: Chroxy v0.6.8 Full Codebase

**Agent**: Operator — UX walkthrough, daily experience, error states, accessibility.
**Overall Rating**: 3.2 / 5
**Date**: 2026-04-05

---

## Section Ratings

### Onboarding Flow — 2/5

The onboarding experience is the first impression and it's rough. New users must:
1. Install `cloudflared` via Homebrew (not documented inline — user must find `docs/`)
2. Run `npx chroxy start` (requires Node 22 — silently fails on Node 18 with a cryptic error)
3. Scan a QR code from the terminal
4. Get an error if they open the QR too fast (tunnel URL not yet routable — the tunnel-check loop helps but isn't visible to users)
5. Enter the URL or token manually if QR scan fails

The token/URL distinction confuses new users. The QR code encodes a URL with an embedded token (`chroxy://hostname?token=...`). The "manual entry" screen asks for a URL. First-time users often enter just the hostname, without the token, and get a generic auth error with no explanation.

**Evidence**: `packages/app/src/screens/ConnectScreen.tsx` — manual entry validation error message is "Invalid URL format" (line ~180), which doesn't tell users they need the token parameter.

### Permission Expiry UX — 2/5

When a pending permission request expires (timeout), the server silently moves on. The app receives a state update but displays no notification to the user that a permission was auto-denied. From the user's perspective, Claude Code just seems to have gotten stuck. The SessionTimeoutBanner handles session timeouts, but not individual permission timeouts.

**Evidence**: `packages/server/src/session-timeout-manager.js` — emits `permission_timeout`; `packages/app/src/store/message-handler.ts` — `permission_timeout` handler updates state but shows no toast/banner.

### Error Messages — 3/5

Most error messages in the app are functional but lack actionable steps. Examples:
- "Connection failed" — no indication if this is a network issue, a server issue, or an auth issue
- "Session not found" — no suggestion to check if the server is running
- "Encryption negotiation failed" — completely opaque to non-technical users

The desktop dashboard is better: it shows a ReconnectBanner with a "Retry" button. The mobile app shows a spinner that eventually gives up.

### Session Creation UX — 4/5

The `CreateSessionModal` is well-designed. Directory browsing works, the combobox for paths is functional, and the form validates cleanly. The `DirectoryBrowser` component is particularly good — it handles long paths gracefully and shows a clear hierarchy.

### Settings Discoverability — 3/5

The Settings screen on mobile has many options (model selection, permission rules, session rules, biometric lock, push notifications) but no search or grouping. Users who want to change the model have to scroll past biometric and notification settings. A minimal grouping (Session / Security / Notifications) would help.

### Reconnection Experience — 4/5

The `ConnectionPhase` state machine handles reconnection well. The `ReconnectBanner` in the desktop dashboard is clear. The mobile app shows a reconnecting state. The `server_restarting` phase (supervisor restart) gives appropriate feedback. This is one of the better UX flows in the app.

---

## Top 5 Findings

1. **Onboarding token confusion** (`ConnectScreen.tsx`): Users entering just a hostname (no token) get "Invalid URL format" instead of a helpful message. Fix: parse the entered value; if it's a valid hostname with no token, show: "Include your token: `chroxy://HOSTNAME?token=YOUR_TOKEN`". Effort: ~30 min.

2. **Permission expiry silent** (`message-handler.ts`, `session-timeout-manager.js`): Users don't know a permission was auto-denied. Fix: show a dismissible toast: "Permission request for [tool] expired — Claude Code continued without approval." Effort: ~1 hour.

3. **"Connection failed" error lacks context** (mobile app connection flow): Error message doesn't distinguish network vs auth vs server issues. Fix: map error codes to specific messages with suggested actions. Effort: ~2 hours.

4. **Settings screen ungrouped** (`SettingsScreen.tsx`): 10+ settings with no visual grouping. Fix: add section headers (Session, Security, Notifications). Effort: ~1 hour.

5. **Node 22 requirement not surfaced on startup** (`packages/server/src/cli.js`): Running on Node 18 produces a cryptic module error, not "Node 22 required." Fix: add a Node version check at the top of `cli.js` with a clear error message. Effort: ~15 min.

---

## Daily Experience Walkthrough

**Happy path (experienced user)**:
1. `npx chroxy start` → tunnel URL appears → QR shown
2. Open mobile app → scan QR → connected in ~3s
3. Create session → type message → response appears in chat
4. Switch to terminal view → full PTY available
5. Disconnect → reconnect → chat history preserved

This is smooth. The happy path is well-optimized.

**First-time user path**:
1. `npx chroxy start` → fails silently on Node 18 (no error)
2. Upgrade to Node 22 → start again
3. Scan QR too fast → "connection failed" (tunnel not routable yet)
4. Wait and retry → works
5. On first message, permission prompt appears → user doesn't respond in time → expires silently
6. Claude Code continues → user confused why it "skipped" the permission

Steps 1, 3, 5 are all silent failures. A first-time user hits three confusing moments before sending their first message.

---

## Concrete Recommendations

1. In `cli.js`, add: `if (!process.versions.node.startsWith('22')) { console.error('Node 22 required. Current: ' + process.version); process.exit(1) }`.
2. In `ConnectScreen.tsx`, parse manual entry: if valid hostname with no token, show targeted help text.
3. In `message-handler.ts`, handle `permission_timeout` by dispatching a toast notification.
4. In error handling for connection failures, map WS close codes and HTTP status codes to user-readable messages with suggested next steps.
5. Add section headers to `SettingsScreen.tsx`: group settings into 3-4 logical sections.

---

## Overall Verdict

The core daily experience for established users is excellent — connection, chat, terminal, reconnection all work smoothly. The problems are concentrated in first-time use (onboarding confusion, Node version silent failure) and edge cases (permission expiry, connection error messages). Fixing the five findings above would meaningfully reduce first-time user friction without touching any core logic. The desktop dashboard is slightly ahead of the mobile app in UX polish.

**Overall Rating: 3.2 / 5**
