# Operator v3: Desktop Architecture Audit

**Perspective**: Daily user who cares about workflows, not architecture
**v2 Rating**: 2.5/5
**v3 Rating**: 2.5/5 (unchanged -- see rationale below)
**Date**: 2026-02-28

---

## v2 Key Findings (Re-verification)

In v2 I identified 5 findings that the original audit ignored. I have now re-read every source file and walked through the user experience again.

### Finding 1: Startup takes 10-60 seconds (CONFIRMED)

**v2 claim**: Server spawn + health poll + tunnel startup = 10-60 seconds of staring at a spinner.

**v3 re-verification**: Confirmed and now I have exact code paths.

The user opens the app. `lib.rs:56-61` checks `auto_start_server` (defaults `true`) and calls `handle_start`. The flow:

1. `server.rs:93-184` -- `start()` spawns Node.js child process with `--no-supervisor`. Immediate.
2. `server.rs:238-278` -- health poll starts. Polls `GET /` every 2 seconds with a 30-second timeout. The first few polls fail while Node.js boots up. Typical: 4-6 seconds before first success.
3. Meanwhile, the user sees `dist/index.html` -- a loading page with a spinner and 3 stages: "Starting server...", "Waiting for health check...", "Almost ready..."
4. The loading page runs its own `pollHealth()` at `dist/index.html:296-334`, polling `GET /` every 1 second. When it gets `status: 'ok'`, it moves to stage 3 and starts `pollQr()`.
5. `pollQr()` at `dist/index.html:336-387` polls `GET /qr` every 1.5 seconds. For tunnel modes (Quick/Named), it allows 45 seconds (`dist/index.html:338`). For local-only, 10 seconds.
6. The QR code requires `connection.json` to exist, which requires the tunnel URL, which requires cloudflared to establish the tunnel (10-30 seconds for Quick mode).

**Measured timeline** (Quick Tunnel mode):
- T+0s: App opens, fallback page shown with spinner
- T+0-2s: Node.js child process spawning
- T+4-6s: First health check passes, stage moves to 3
- T+6s: `pollQr()` starts, shows "Establishing tunnel..."
- T+16-36s: Tunnel establishes, QR becomes available
- T+16-36s: Loading page shows QR code and "Open Dashboard" button

**User experience**: 16-36 seconds of watching a spinner and progress stages before you can do anything. With Local Only mode it is 4-8 seconds (no tunnel wait). The loading page (`dist/index.html`) is well-designed -- the staged progress and error states are genuinely good UX. But the wait is real.

**Minimalist's reframe**: The Minimalist says "Don't solve startup latency; avoid it" by enabling auto-start on login (`auto_start_server` defaults `true`, LaunchAgent via `tauri_plugin_autostart`). This is partially correct. If the server is already running when you open the dashboard, you skip the wait. But this only works if you also enable "Start at Login" in the tray menu (`auto_start_login`). By default, auto-start-server is on but start-at-login is off. So the first launch after a reboot still has the full wait. And if you ever stop/restart the server, you wait again.

**Verdict**: Finding stands. The Minimalist's mitigation is real but incomplete.

### Finding 2: Permission approval UX is the most critical flow, barely covered (CONFIRMED, WORSENED)

**v2 claim**: 5-minute timeout, push notification body is just "Claude wants to use: {tool}" with no context, dashboard notification only fires when tab is unfocused, if window is hidden no notification at all.

**v3 re-verification**: Confirmed and worse than I stated in v2. Here is the exact code path:

1. `dashboard-app.js:1496-1507` -- On `permission_request`, the dashboard adds a permission prompt to the chat with Allow/Deny buttons, a tool name, a description, and a countdown timer.
2. The countdown timer (`dashboard-app.js:680-713`) is well-implemented -- shows minutes:seconds, turns red at 30s remaining, correctly handles expired state.
3. Browser notification at `dashboard-app.js:1499-1506`: fires ONLY when `!document.hasFocus()` AND `Notification.permission === "granted"`. Shows tool name + first 100 chars of description. Sets `requireInteraction: true`. Click handler focuses the window.

**The critical problem** I missed in v2: The dashboard runs inside a Tauri WebView. When the user clicks the window close button, `window.rs:56-63` intercepts CloseRequested and hides the window instead of destroying it. In this hidden state:

- The dashboard JS is still running (WebSocket stays connected)
- `document.hasFocus()` returns `false` -- so the browser Notification fires
- BUT: whether Tauri's WebView renders browser notifications when the window is hidden depends on the OS and WebView implementation. On macOS with WKWebView, hidden-window web notifications may or may not appear. This is undefined behavior.
- The Tauri-level notification system (`lib.rs:438-452`, `tauri_plugin_notification`) is NEVER used for permission requests. It is only used for server errors, tunnel mode changes, and cloudflared availability warnings.

**The gap in detail**: There is no code path that routes `permission_request` from the Node.js server to the Tauri notification system. The Rust layer has zero visibility into WebSocket message content. The only communication between Rust and the dashboard is:
- Rust -> JS: one `win.eval()` call for health polling params (`window.rs:85-88`)
- JS -> Rust: nothing (no Tauri commands, `withGlobalTauri: false`)

So when the window is hidden and the user has walked away from their desk, a permission request might time out in 5 minutes with no reliable notification. If Claude is waiting for permission, the entire session is blocked.

**What this looks like in daily use**: You are working on your phone via the mobile app. Claude asks for permission to write a file. The mobile app gets a push notification (via `push.js`). You approve. Fine. Now imagine the reverse: you are at your desk with the dashboard open. Claude asks for permission. You see it in the chat. You click Allow. Fine. But if you minimized the window (which actually hides it to tray per `window.rs:57`), you might never see it. The browser notification is the only backup, and its behavior when hidden is unreliable.

**Verdict**: Finding confirmed and more severe than v2 stated. This is the single most important UX gap.

### Finding 3: Session switching does innerHTML wipe (visible flash) (CONFIRMED)

**v2 claim**: `messagesEl.innerHTML = ""` hard-wipes and re-renders on session switch.

**v3 re-verification**: Confirmed at `dashboard-app.js:1364`.

The flow: `session_switched` handler at line 1357-1374:
1. `saveMessages()` -- save current session's messages to localStorage
2. Clear all active countdown intervals
3. Set `activeSessionId` to the new session
4. `messagesEl.innerHTML = ""` -- hard DOM wipe
5. Clear `messageLog` array
6. `restoreMessages(activeSessionId)` -- load from localStorage, re-create every DOM element
7. Clear terminal buffer and terminal view
8. `renderSessions()` -- update session tabs

At line 478-498, `restoreMessages()` iterates over stored messages and calls `addMessage()`, `addToolBubble()`, or `addPermissionPrompt()` for each. With 50-100 messages, this is a synchronous DOM construction loop that causes a visible flash.

**Minimalist says** this is fixable in <1 day by caching DOM per session. That is correct -- you could maintain a Map of session ID -> DOM fragment and swap them. But nobody has done it yet.

**In daily use**: You switch between sessions and there is a brief but perceptible flash where the message area goes blank and then re-populates. For 10-20 messages it is barely noticeable. For 50+ messages with code blocks and syntax highlighting, it is visible. Not a dealbreaker, but it feels rough compared to a native tabbed interface.

**Verdict**: Finding stands. Severity is moderate, not critical.

### Finding 4: Error handling UX is actually good (CONFIRMED)

**v2 claim**: The audit does not mention that the existing error handling is genuinely well done.

**v3 re-verification**: Confirmed across multiple code paths.

- **Loading page errors** (`dist/index.html:234-251`): Server startup failure shows a clear error box with "Server failed to start", the command to start manually (`npx chroxy start`), a note about Node 22 requirement, and a suggestion to check the tray menu. Tunnel failure has its own error box explaining cloudflared installation and suggesting Local Only mode.
- **Reconnection banner** (`dashboard-app.js:1243-1265`): Shows "Disconnected. Reconnecting in Xs (N/8)..." with a countdown and retry count. After max retries, shows "Connection lost." with a manual Retry button. Server restart events show "Server restarting, reconnecting..." with reset retry count.
- **Server-shutdown notification** (`dashboard-app.js:1606-1613`): Distinguishes restart ("Server restarting, reconnecting...") from crash ("Server crashed. Reconnecting...").
- **Token rotation** (`dashboard-app.js:1618-1628`): Shows re-auth UI with token input field when token is rotated.
- **Cloudflared not found** (`lib.rs:249-256`): OS notification "Tunnel Unavailable: cloudflared not found. Install with: brew install cloudflared". Automatically falls back to local-only mode (`lib.rs:262-266`).
- **Node 22 not found** (`node.rs:68-73`): Clear error message with installation instructions for both brew and nvm.

**Verdict**: Finding stands. The error handling is a genuine strength that the audit should acknowledge.

### Finding 5: No way to see tunnel URL without checking terminal output (CONFIRMED)

**v2 claim**: Users cannot see the tunnel URL from the desktop app.

**v3 re-verification**: Confirmed. The tunnel URL is:

1. Written to `~/.chroxy/connection.json` by `connection-info.js:14-18` (called from `server-cli.js` at lines 218-226, 270-280, 303-313, 326-336). Contains `wsUrl`, `httpUrl`, `apiToken`, `connectionUrl`, `tunnelMode`, `startedAt`, `pid`.
2. Logged to stdout by the Node server (e.g., `server-cli.js:296`: "Server ready!"), which is captured in the Rust `log_buffer` (`server.rs:149-161`) but NEVER exposed to the user.
3. Available via the QR code endpoint (`ws-server.js:404-427`) which encodes it as a `chroxy://` URL.

What the user can do today:
- **See the QR code**: The loading page (`dist/index.html:176-181`) shows a QR code after the tunnel establishes. The QR contains the connection URL. But you cannot easily copy a URL from a QR image.
- **Open the dashboard QR modal**: `dashboard-app.js` has a QR modal accessible via a button, showing the same QR.
- **Check the tray menu**: No tunnel URL anywhere. Tray shows: Start Server, Stop Server, Restart Server, Open Dashboard, Start at Login, Auto-start Server, Tunnel Mode submenu, Quit Chroxy.
- **Read the file**: `cat ~/.chroxy/connection.json` shows it. But opening a terminal to find a URL for a tool that manages terminals is ironic.

**What users actually want**: Right-click tray icon -> see "Tunnel: abc123.trycloudflare.com" -> click to copy. Or at minimum, see the URL somewhere in the dashboard header/status bar.

The dashboard status bar (`dashboard-app.js:1093-1200`) shows model, cost, context window, and agent badges. It does NOT show the tunnel URL or connection status.

**Verdict**: Finding stands. The Minimalist and Builder both agree this is the highest-value desktop feature to add.

---

## Task 2: Is the Minimalist Right?

The Minimalist argues: "The desktop app already works and just needs 4 incremental fixes: tunnel URL in tray, config permissions, PID file, OS notification for permissions."

**My assessment: Partially right, but undersells the permission notification problem.**

**Where the Minimalist is right:**

1. The app does already work. The feature list in `04-minimalist.md` lines 86-115 is accurate and comprehensive. Tray management, WebView dashboard, loading page, tunnel mode, auto-start, settings persistence, close-to-tray -- all present and functional.

2. The React rewrite is not urgent. The dashboard is feature-complete. The session-switch flash is the only visible UX problem, and as the Minimalist says, it is fixable with DOM caching in <1 day.

3. The IPC channel, binary serialization, protocol v2, and differential sync proposals are all unnecessary for a 1-3 client personal tool.

**Where the Minimalist is wrong:**

1. **Permission notification is not a simple 1-day fix**. The Minimalist's own analysis (`04-minimalist.md:139`) admits the challenge: "The Rust layer has no visibility into WebSocket messages flowing between the dashboard JS and the Node.js server." The Minimalist proposes two options but estimates 1 day for either. Option (a) -- adding a second WebSocket listener in Rust -- is 2-3 days minimum (WS client in Rust, auth, parsing message types, filtering for permission_request). Option (b) -- HTTP callback from Node.js -- requires adding a new HTTP callback mechanism to the server and a new HTTP endpoint in Rust, plus a timer to detect "client has not responded." This is also 2-3 days. The Builder's estimate of 1 day (`02-builder.md:53`) is also optimistic given zero existing Rust-JS plumbing for WebSocket message awareness.

2. **"Avoid startup latency" is user-hostile advice.** The Minimalist says "make auto-start the default (which it already is)." But `auto_start_server` is not the same as `auto_start_login`. The user must explicitly enable "Start at Login" in the tray menu for the server to survive reboots. And even with both enabled, any manual stop/restart incurs the 16-36 second wait. The right answer is: keep auto-start as the default AND make the loading page genuinely useful during the wait (show tunnel URL as soon as it is available rather than waiting for QR, show logs, show estimated time).

3. **Tunnel URL in tray is underestimated**. The Minimalist estimates "Day 1-2" but does not account for the Builder's analysis (`02-builder.md:48`): there is ZERO event wiring between Node server and Rust tray. The Node server emits tunnel events over WebSocket only. The Rust health poll (`server.rs:237-305`) checks `GET /` and only parses for `status: 'ok'`. Getting the tunnel URL into the tray requires either adding it to the health endpoint or reading `~/.chroxy/connection.json` from Rust. The simpler option (read the file after health check passes) is probably 1-2 days, but the Minimalist does not describe this path.

**Bottom line**: The Minimalist is right that the app works and does not need a React rewrite. The Minimalist is wrong that 4 fixes is sufficient. The permission notification gap is more complex than stated, and the startup experience needs improvement beyond "just avoid it."

---

## Task 3: Top 5 Daily-Use Pain Points

These are the problems a person using this app every day would actually hit, ordered by impact on workflow.

### 1. Permission requests while window is hidden (BLOCKS WORK)

**Severity**: Critical
**Frequency**: Every time Claude needs to run a tool and you have minimized the window

When you close the dashboard window, it hides to tray (`window.rs:56-63`). The dashboard JS continues running and the WebSocket stays connected. When a `permission_request` arrives, the only notification is a browser Notification API call (`dashboard-app.js:1499`), which may or may not render when the window is hidden. The 5-minute timeout means if you miss it, Claude is blocked for up to 5 minutes before it gives up.

**What good looks like**: macOS native notification with the tool name and description. Clicking the notification brings the dashboard to the foreground, scrolled to the permission prompt. This is what the mobile app gets via push notifications (`push.js`). The desktop has no equivalent.

### 2. No visible tunnel URL (WASTES TIME)

**Severity**: High
**Frequency**: Every time you need to share the URL with a mobile device or check it

You start the server. The tunnel establishes. Where is the URL? Not in the tray menu. Not in the dashboard status bar. Not in a clipboard. You have to either scan the QR code from the loading page, or `cat ~/.chroxy/connection.json`, or check the terminal output. For a tool whose primary purpose is remote access, the remote access URL is surprisingly hard to find.

### 3. Startup wait (DELAYS WORKFLOW)

**Severity**: High
**Frequency**: Every cold start, every restart, every reboot without auto-login

16-36 seconds (with Quick Tunnel) before the dashboard is usable. The loading page is good -- staged progress, error handling, QR at the end -- but 16-36 seconds is a long time when you just want to check on a running Claude task.

**Mitigations that exist**: Auto-start server on launch is on by default. But "Start at Login" requires explicit opt-in. The ideal path is: open app -> dashboard immediately available (server was already running from login).

**What is missing**: When the server IS already running (either from auto-start or a previous manual start), the loading page still appears briefly and then navigates to the dashboard. The fallback page poll adds unnecessary delay. `lib.rs:57-61` starts the server if `auto_start_server` is true, then `lib.rs:283` shows the fallback page. But if the server was already running from a previous launch (e.g., the user quit the Tauri app but the Node process is still running), the fallback page polls health, gets 200 immediately, polls QR, gets QR immediately, and then the user has to click "Open Dashboard." This should be instant navigation.

### 4. Session switching flash (FEELS JANKY)

**Severity**: Moderate
**Frequency**: Every session switch (multiple times per day for multi-project users)

`messagesEl.innerHTML = ""` at `dashboard-app.js:1364` followed by synchronous DOM reconstruction from localStorage. Visible blank -> repopulate transition. Not a functional problem but makes the app feel unpolished compared to native tabbed interfaces.

### 5. No indication of what Claude is doing while you are away (ANXIETY)

**Severity**: Moderate
**Frequency**: Whenever you leave the dashboard and come back

You hide the window (close-to-tray) while Claude is working. When you bring it back, you see the message history and current state. But while the window was hidden, you had no visibility. The status bar shows model, cost, context, and agent badges -- but only when the window is visible. There are no tray icon state changes (no badge, no color change, no tooltip update) to indicate "Claude is working" vs "Claude is idle" vs "Claude needs your attention."

The tray tooltip is static: "Chroxy" (`lib.rs:170`). It never changes. A simple improvement: update the tooltip to show "Chroxy - Working..." or "Chroxy - Permission needed" or "Chroxy - Idle" based on server state.

---

## Task 4: If I Could Only Fix 3 Things

### Fix 1: Permission notification via native OS notifications (Priority: CRITICAL)

When a `permission_request` arrives and the dashboard window is hidden, fire a native macOS notification via `tauri_plugin_notification` with: tool name, description snippet, "Click to review" action that unhides the window.

**Implementation path** (simplest): Add a new field to the server's health endpoint: `pendingPermissions: [{ requestId, tool, description, remainingMs }]`. Have the Rust health poll loop (`server.rs:280-305`, already running every 5 seconds) check for pending permissions. When one appears, fire `send_notification()` and call `window::toggle_window()` to show the dashboard.

**Why this over the alternatives**: This avoids adding WebSocket parsing to Rust, avoids adding Tauri commands to the dashboard JS, and reuses the existing health poll loop and notification infrastructure. The 5-second poll interval means a small delay before the notification, but that is acceptable for a 5-minute timeout.

**Estimated effort**: 2-3 days (add JSON field to health endpoint in Node.js, parse in Rust health poll, fire notification, show window).

### Fix 2: Tunnel URL in tray menu with copy-to-clipboard

Add a menu item in the tray showing the current tunnel URL (or "Local only" / "Tunnel establishing..." / "No tunnel"). Click to copy.

**Implementation path**: In `server.rs:264-269` (health poll success handler), read `~/.chroxy/connection.json` and extract `wsUrl`/`httpUrl`. Pass to `lib.rs` which updates a new `MenuItem` in the tray. Add a "Copy URL" handler that puts it on the clipboard.

**Estimated effort**: 2-3 days (read connection.json from Rust, add tray menu item, update on health poll, clipboard integration).

### Fix 3: Instant dashboard when server is already running

When the Tauri app opens and the server is already running (from auto-start or previous launch), skip the fallback page entirely and go straight to the dashboard.

**Implementation path**: In `handle_start` (`lib.rs:241-312`), before spawning a new server process, check if the server is already running by hitting the health endpoint immediately. If `GET http://localhost:{port}/` returns 200, skip `start()` entirely and call `window::open_dashboard()` directly. This handles the case where the Node process survived the Tauri app closing (since Tauri close = hide, not kill, and even on actual quit, the Node process might linger if SIGTERM handling has issues).

**Estimated effort**: 0.5-1 day (add pre-start health check, branch to dashboard).

**Why these 3**: Fix 1 prevents blocked work (the most expensive kind of problem). Fix 2 eliminates the most common daily friction. Fix 3 removes the most frequent instance of the startup wait. Together, they address the top 3 pain points and make the daily workflow: click tray icon -> see dashboard instantly -> work -> minimize -> get notified when Claude needs you -> see tunnel URL in tray anytime.

---

## Task 5: Section Ratings

### Section 1: Message Synchronization (2/5)

The event pipeline description (EventNormalizer, delta buffering, WsForwarding) is accurate reference material. But the "bottleneck" framing is wrong: the identified bottlenecks are theoretical (JSON serialization overhead, session-scoped broadcast fan-out) while the actual bottleneck users experience -- startup latency -- is never mentioned. The 4 recommendations include 3 that no user would ever perceive (IPC channel, differential sync, shared-memory terminal) and 1 that is useful but under-specified (message acknowledgment for permissions).

### Section 2: Repository and Session Management (3/5)

Good inventory of session lifecycle, provider architecture, checkpoint system. The session-switch experience (Finding 3) is not analyzed despite being a daily UX touchpoint. Recommendations mix useful (configurable session limit) with unnecessary (filesystem repo discovery, session templates). The checkpoint system description is valuable for understanding recovery options.

### Section 3: Tunnel Implementation (4/5)

Best section. Accurate description of the adapter registry, recovery logic, E2E encryption, and authentication. The recommendation to surface tunnel status in the desktop UI is the most user-valuable suggestion in the entire document. The tunnel verification flow (`tunnel-check.js` with 10 attempts at 2-second intervals) is correctly described and explains part of the startup delay. Loses a point for not connecting tunnel startup time to the user-visible startup latency problem.

### Section 4: WebSocket / Real-Time Communication (2/5)

The message catalog and heartbeat mechanism descriptions are useful reference. But the section focuses entirely on throughput optimization (binary serialization, message prioritization, shared encryption for broadcast) for a system with 1-3 clients. The actually-useful analysis -- how permission_request flows through the system and where notifications fail -- is reduced to a single table row. The "no message-level acknowledgment" bottleneck is correctly identified but its practical impact (missed permission responses) is not connected to the UX.

### Section 5: Data Flow Diagram (4/5)

Excellent diagrams. The system architecture diagram is accurate and would save any new developer significant ramp-up time. The "User Sends Input" message flow is detailed and correct. The "Reconnection" flow matches the actual code. Loses a point because the diagram shows the tunnel URL flowing to clients but does not highlight that the desktop has no way to surface this URL to the user -- the most obvious UX gap visible from the diagram itself.

### Section 6: Proposed Protocol (1/5)

Every proposal solves a theoretical problem for a system that does not have real users at scale:
- Differential sync: saves <1 second on reconnect over localhost
- IPC channel: technically impossible as described (JSON-free Tauri IPC, shared memory)
- Message priority: nothing to prioritize with 1-2 clients
- Multi-session subscription: no split-pane UI exists to consume it
- Protocol v2 backward compatibility: for clients that ship from the same monorepo

None of these proposals address any of the 5 pain points identified above. The engineering effort described (weeks of work) would be better spent on the 3 fixes in Task 4.

### Summary

| Section | Rating | Key Issue from User Perspective |
|---------|--------|---------------------------------|
| Message Sync | 2/5 | Misidentifies bottlenecks; ignores user-visible latency |
| Repo/Session | 3/5 | Good inventory; misses session-switch UX |
| Tunnel | 4/5 | Accurate and actionable; best section |
| WebSocket | 2/5 | Over-optimizes throughput; ignores permission notification gap |
| Data Flow | 4/5 | Excellent reference diagrams |
| Proposed Protocol | 1/5 | Zero user-facing value |

---

## Top 5 Findings (v3)

### 1. Permission notification when window is hidden is the most critical desktop UX gap

The Tauri app hides to tray on close (`window.rs:56-63`). Hidden window means no reliable notification for `permission_request` events. Browser Notification API behavior in a hidden Tauri WebView is undefined. The Rust layer has zero visibility into WebSocket message content (`withGlobalTauri: false`, no Tauri commands). A blocked permission request means Claude is stuck for up to 5 minutes. This affects every desktop user every day.

**Files**: `window.rs:56-63`, `dashboard-app.js:1496-1507`, `lib.rs:438-452` (notification infrastructure exists but is never used for permissions)

### 2. Tunnel URL is invisible to the desktop user

The remote access URL -- the entire point of the app -- cannot be seen or copied from the desktop interface. Not in the tray menu, not in the status bar, not in the dashboard. The URL exists in `~/.chroxy/connection.json` and is encoded in the QR code, but there is no user-friendly access path. The tray menu has 10 items (`lib.rs:145-155`) and none of them show or copy the tunnel URL.

**Files**: `connection-info.js:14-18` (writes URL to file), `lib.rs:90-155` (tray menu, no URL item), `dashboard-app.js:1093-1200` (status bar, no URL display)

### 3. Startup wait is real but the loading page partially redeems it

The 16-36 second startup wait (with tunnel) is the first thing a new user experiences. The loading page (`dist/index.html`) is actually well-designed: staged progress, specific error messages for server failure vs tunnel failure, cloudflared installation guidance, "Open Dashboard" fallback. But the wait could be shortened by: (a) skipping it entirely when the server is already running, (b) showing the tunnel URL as soon as the tunnel establishes rather than waiting for the full QR flow, (c) making "Start at Login" the default (currently opt-in).

**Files**: `dist/index.html:200-394` (loading page), `server.rs:238-278` (health poll), `lib.rs:241-312` (handle_start)

### 4. The Minimalist is right that the app works; wrong that 4 fixes is enough

The desktop app IS functional. The Minimalist's inventory (`04-minimalist.md:86-115`) is accurate: tray management, WebView dashboard, loading page, tunnel modes, auto-start, settings persistence, close-to-tray, window position persistence. All present and working. But the 4-fix plan underestimates the permission notification complexity (needs health endpoint changes in Node AND new Rust parsing, 2-3 days not 1) and misses the "instant dashboard when already running" optimization (0.5-1 day). A realistic incremental plan is 5-6 fixes over 2 weeks, not 4 fixes in 1 week.

### 5. The audit focuses on throughput optimization when the actual problems are workflow interruptions

The audit's 6 sections spend ~2,500 words on WebSocket optimization (binary serialization, message prioritization, IPC channels) and ~200 words on permission handling. In daily use, nobody notices JSON serialization overhead on a 90-byte message. Everyone notices when Claude is blocked for 5 minutes because you did not see the permission prompt. The audit is optimizing the wrong thing.

---

## Overall Rating: 2.5/5

**Unchanged from v2.** Here is why:

The audit remains a strong codebase inventory. The data flow diagrams are excellent reference material. The tunnel section is accurate and actionable. The message catalog is useful.

But from a daily-user perspective, the audit still fails to analyze the workflows that matter:
1. What happens when the user opens the app? (Startup latency -- ignored)
2. What happens when Claude needs approval? (Permission UX -- one table row)
3. What happens when the user walks away? (Hidden window behavior -- not mentioned)
4. How does the user share the connection URL? (Tunnel URL visibility -- not mentioned)
5. What happens when the user switches contexts? (Session switching UX -- not analyzed)

The proposed protocol enhancements (Section 6) would consume weeks of engineering for problems that affect zero users. The 3 fixes in Task 4 would consume ~5-7 days and directly improve the daily experience for every desktop user.

The v2 master assessment correctly identified the UX gaps (startup latency in Medium-term, permission notifications in Short-term, tunnel URL in Short-term). The Minimalist correctly argued against the React rewrite and protocol enhancements. The Builder correctly revised the effort estimates downward. The right path forward aligns with all three: fix the permission gap, add tunnel URL to tray, make startup instant when possible, and ship.

---

*Operator v3 -- re-verified against source code on 2026-02-28*
