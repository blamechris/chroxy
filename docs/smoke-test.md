# Chroxy Smoke Test Checklist

Manual E2E smoke tests for Chroxy. Run before merging any PR that touches server or app code.

See [qa-log.md](qa-log.md) for the QA audit log tracking when these tests were last run.

## File-to-Scope Mapping

Use this table to determine which test scopes to run based on files changed in a PR.

| Changed File(s) | Test Scopes |
|---|---|
| `ws-server.js` | Connection, Chat, Permissions, No-Auth |
| `cli-session.js` | Chat, Permissions, Model Switching |
| `server-cli.js`, `cli.js` | Connection, No-Auth, Shutdown |
| `tunnel.js`, `tunnel-check.js` | Connection |
| `permission-hook.sh` | Permissions |
| `models.js` | Model Switching |
| `connection.ts` | Connection, Chat, Permissions, Model Switching, Cost/Usage |
| `SessionScreen.tsx` | Chat, Permissions, Model Switching, Cost/Usage, Selection |
| `ConnectScreen.tsx` | Connection |
| PTY files (`server.js`, `pty-manager.js`, `output-parser.js`) | Terminal |

**Always run the Regression Baseline regardless of which files changed.**

---

## Prerequisites

| Requirement | How to verify |
|---|---|
| Node 22 installed | `node -v` via `/opt/homebrew/opt/node@22/bin/node` |
| cloudflared installed | `cloudflared --version` |
| tmux installed (PTY mode only) | `tmux -V` |
| Chroxy config exists | `npx chroxy config` |
| Phone with Expo Go | iOS or Android |

---

## Setup

Two terminals + phone with Expo Go.

```bash
# Terminal 1 — Server
cd /path/to/chroxy
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start

# Terminal 2 — App dev server
cd packages/app && npx expo start
```

Open Expo Go on phone, scan the Expo dev server QR code (not the Chroxy QR — that's for connecting inside the app).

---

## Regression Baseline (~2 min)

Run on every PR. Covers the critical happy path.

- [ ] Server starts without errors — banner prints, tunnel URL appears, QR code displays
- [ ] App opens ConnectScreen with "Scan QR Code" button
- [ ] Scan Chroxy QR code from server terminal — app connects, shows SessionScreen
- [ ] Model chips visible in status bar (Haiku, Sonnet, Opus, Opus 4.6)
- [ ] Send "Say hello in one sentence" — "You" bubble appears instantly, then Claude streams a response
- [ ] Cost and duration appear in status bar (e.g., "$0.0042 · 1.2s · 5.3k tokens")
- [ ] Tap disconnect (X button) — returns to ConnectScreen
- [ ] "Reconnect" button appears with saved URL — tap it, reconnects successfully
- [ ] Ctrl+C server — clean shutdown, no errors or orphan processes

**If any baseline test fails, stop. Fix before proceeding.**

---

## Connection

Test when: `ws-server.js`, `server-cli.js`, `cli.js`, `tunnel.js`, `tunnel-check.js`, `connection.ts`, `ConnectScreen.tsx`

### QR Code Flow
- [ ] Scan valid Chroxy QR code → connects, shows SessionScreen
- [ ] Scan non-Chroxy QR code → "Invalid QR Code" alert with "Try Again" button
- [ ] Tap "Cancel" during scanning → returns to ConnectScreen

### Manual Connection
- [ ] Expand "Enter manually" → URL and Token fields appear
- [ ] Enter URL + token → tap Connect → connects successfully
- [ ] Empty URL field → connects to `ws://localhost:8765` (default)
- [ ] URL field shows placeholder: "ws://localhost:8765 (default)"
- [ ] Enter only `localhost:8765` (no protocol) → auto-prefixes `wss://`

### Token Validation
- [ ] Remote URL + empty token → "Missing Token" alert
- [ ] Remote URL + whitespace-only token (spaces) → "Missing Token" alert
- [ ] Localhost URL + empty token → connects without error (--no-auth flow)
- [ ] Token label shows "(optional for localhost)" when URL is localhost
- [ ] Wrong token → "Auth Failed" alert

### Reconnection
- [ ] After connecting, tap X to disconnect → ConnectScreen shows "Reconnect" + saved URL
- [ ] Tap "Reconnect" → reconnects, chat history preserved from previous session
- [ ] Tap "Forget" → saved connection removed, "Reconnect" button disappears
- [ ] Kill tunnel process while connected → "Reconnecting..." banner appears → auto-reconnects
- [ ] Kill server while connected → "Reconnecting..." banner → retries then fails gracefully

### Auth Timeout
- [ ] Connect but send no auth within 10s → server disconnects client (check server logs: no crash)

---

## Chat

Test when: `ws-server.js`, `cli-session.js`, `connection.ts`, `SessionScreen.tsx`

### Sending Messages
- [ ] Type message + tap send (blue arrow) → "You" bubble appears immediately
- [ ] "Thinking..." indicator shows while waiting for response
- [ ] Thinking indicator disappears when response starts streaming
- [ ] Empty input + tap send → nothing happens (no empty messages sent)
- [ ] While streaming, send button becomes red interrupt button (square icon)

### Receiving Responses
- [ ] Response streams token-by-token (visible letter by letter, not all at once)
- [ ] Long response (ask: "List the 50 US states") → streams correctly, auto-scrolls
- [ ] Response shows "Claude" label with green sender name
- [ ] After response completes, send button reappears (blue arrow)

### Tool Use
- [ ] Ask Claude to create a file: "Create /tmp/chroxy-test.txt with 'hello'"
- [ ] Tool bubble appears with purple "Tool: Bash" (or Write) label
- [ ] Tool bubble is collapsed by default, showing preview text
- [ ] Tap tool bubble → expands to show full tool input
- [ ] Tap again → collapses back

### Interrupt
- [ ] Start a long response (ask for 50 items list)
- [ ] Tap red interrupt button (square) during streaming → response stops
- [ ] After interrupt, send button reappears → send another message → works normally

### Conversation Memory
- [ ] Send: "My name is TestUser123"
- [ ] Send: "What's my name?" → Claude responds with "TestUser123" (session memory works)

### Rapid Fire
- [ ] Wait for Claude to finish one response, then quickly send 3 messages back-to-back
- [ ] All "You" bubbles appear, responses come sequentially (no dropped messages)

---

## Permissions

Test when: `ws-server.js`, `cli-session.js`, `permission-hook.sh`, `connection.ts`, `SessionScreen.tsx`

### Hook Registration
- [ ] On server start, check `~/.claude/settings.json` → `hooks.PreToolUse` contains entry with `"_chroxy": true`
- [ ] On server shutdown (Ctrl+C), check again → `_chroxy` entry removed

### Permission Prompts (Approve Mode)
- [ ] Ask Claude to do something that requires a tool (e.g., "Create /tmp/chroxy-perm.txt with hello")
- [ ] Amber "Action Required" card appears with tool name and description
- [ ] Card has three buttons: Allow, Deny, Always Allow
- [ ] Tap **Allow** → Claude proceeds, tool executes, result appears
- [ ] Trigger another tool → tap **Deny** → Claude reports denial, does not execute
- [ ] Trigger another tool → tap **Always Allow** → tool executes (subsequent same-tool calls may auto-approve)

### Permission Timeout
- [ ] Trigger a permission prompt → do NOT respond for 5 minutes
- [ ] After timeout, hook falls through to Claude's default behavior (check server logs)

### Permission Modes
_Requires permission mode UI (if implemented). Otherwise test via server restart with env vars._

---

## Model Switching

Test when: `models.js`, `cli-session.js`, `connection.ts`, `SessionScreen.tsx`

- [ ] After connecting, status bar shows model chips: **Haiku**, **Sonnet**, **Opus**, **Opus 4.6**
- [ ] Active model is highlighted (blue background + border)
- [ ] Tap a different model chip → chip highlights, server logs "Model changed to..."
- [ ] Send a message → check server logs for model name (confirms new model is active)
- [ ] Model persists across messages (don't need to re-select each time)

---

## Cost and Usage Display

Test when: `connection.ts`, `SessionScreen.tsx`

- [ ] After first response, cost appears in status bar (e.g., "$0.0042")
- [ ] Duration appears next to cost (e.g., "· 1.2s")
- [ ] Token count appears (e.g., "· 5.3k tokens")
- [ ] Values update after each response (not stuck on first values)
- [ ] Before any response, cost/duration area is empty (no $0.0000)

---

## No-Auth Mode

Test when: `cli.js`, `server-cli.js`, `ws-server.js`, `permission-hook.sh`, `ConnectScreen.tsx`

### Server Startup
```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start --no-auth
```
- [ ] Warning prints: "WARNING: Running without authentication (--no-auth)"
- [ ] Warning prints: "Server bound to localhost only. Do NOT expose to network."
- [ ] No tunnel is started (no cloudflared process, no QR code)
- [ ] Shows: "Connect: ws://localhost:PORT"
- [ ] Server logs: "listening on 127.0.0.1:PORT"

### Connection Without Token
- [ ] In app, manually enter `ws://localhost:8765` with empty token → connects successfully
- [ ] Server logs: "auto-authenticated (--no-auth)"
- [ ] Chat works normally (send message, get response)

### Flag Validation
```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start --terminal --no-auth
```
- [ ] Error: "--no-auth is only supported in CLI headless mode (remove --terminal)." → exits

---

## Message Selection

Test when: `SessionScreen.tsx`

- [ ] Have a conversation with 3+ messages visible
- [ ] Long-press a message → selection bar appears ("1 selected"), message gets blue border
- [ ] Tap another message → adds to selection ("2 selected")
- [ ] Tap selected message → deselects it
- [ ] Tap "Copy" → copies selected messages to clipboard, alert confirms, selection clears
- [ ] Long-press + select 2 messages → tap "Export" → share sheet appears with JSON
- [ ] Tap X in selection bar → clears all selections

---

## Input Modes

Test when: `SessionScreen.tsx`

- [ ] Default: Enter key sends message (return arrow icon visible left of input)
- [ ] Tap return arrow icon → switches to paragraph icon (¶), Enter now inserts newline
- [ ] Type multiline text with Enter → text area grows (up to max height)
- [ ] Tap paragraph icon → switches back to return arrow, Enter sends again
- [ ] Setting persists within the session

---

## Terminal (PTY Mode Only)

Test when: `server.js`, `pty-manager.js`, `output-parser.js`

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start --terminal
```

- [ ] After connecting, both "Chat" and "Terminal" tabs visible in header
- [ ] Terminal tab shows tmux session output (green monospace text on black)
- [ ] Chat tab shows parsed messages from output parser
- [ ] Toggle between Chat and Terminal → both views update correctly
- [ ] Type in terminal mode → keystrokes appear in tmux
- [ ] Special key bar visible (Enter, ^C, Tab, Escape, Up, Down, Clear)
- [ ] Tap "Clear" → terminal buffer cleared
- [ ] In CLI mode, Terminal tab is hidden (only Chat tab visible)

---

## Shutdown and Cleanup

- [ ] Ctrl+C server → "[SIGINT] Shutting down..." message
- [ ] Server exits cleanly (no hanging processes: `ps aux | grep claude | grep -v grep`)
- [ ] `~/.claude/settings.json` — `_chroxy` hook entry removed
- [ ] No orphaned cloudflared processes: `ps aux | grep cloudflared | grep -v grep`
- [ ] Restart server → starts cleanly, new tunnel URL, new QR code

---

## Edge Cases

### Network Resilience
- [ ] Toggle phone airplane mode for 5s, then turn off → app auto-reconnects
- [ ] Server process respawns if Claude crashes (check server logs for "scheduling respawn")

### Large Payloads
- [ ] Ask Claude for a very long response (500+ words) → streams without truncation
- [ ] Terminal buffer doesn't grow unbounded (capped at 50k chars)

### Keyboard Handling (Android)
- [ ] Keyboard appears → input area moves above keyboard + autocomplete bar
- [ ] No overlap between keyboard suggestions and input field
- [ ] Scroll to see all messages while keyboard is open

### Keyboard Handling (iOS)
- [ ] Keyboard appears smoothly (animated transition)
- [ ] Safe area respected at bottom when keyboard is hidden

---

## Post-Test Cleanup

```bash
# Remove test files
rm -f /tmp/chroxy-test.txt /tmp/chroxy-perm.txt /tmp/chroxy-perm-test.txt

# Verify no orphan processes
ps aux | grep -E "cloudflared|chroxy" | grep -v grep

# Check settings are clean
cat ~/.claude/settings.json | grep chroxy  # should return nothing
```
