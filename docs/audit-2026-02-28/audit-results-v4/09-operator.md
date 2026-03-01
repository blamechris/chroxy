# Operator Audit: Chroxy Desktop as Daily Driver

**Auditor perspective**: Power user / DevOps engineer running Chroxy Desktop 8 hours a day
**Rating**: 3.2 / 5

The foundation is solid and the architecture is sound, but the plan has significant gaps in the areas that separate a developer tool from a daily-driver IDE. The server infrastructure is surprisingly mature; the operator experience around it is not. Below is a systematic breakdown.

---

## 1. First-Run Experience

### What Happens Today

Walking through the code (`setup.rs:ensure_config`, `lib.rs:setup`, `node.rs`):

1. User installs Chroxy Desktop (Tauri `.dmg` or equivalent)
2. Opens the app -- tray icon appears
3. `ensure_config()` creates `~/.chroxy/config.json` with a random UUID token and port 8765
4. If `auto_start_server` is true (default), it tries to start the server
5. `resolve_node22()` searches Homebrew, nvm, and PATH for Node 22
6. `resolve_cli_js()` walks up 6 parent directories looking for the monorepo, then checks `CHROXY_SERVER_PATH`, then `which chroxy`

### What Goes Wrong

**The Node 22 cliff.** If the user doesn't have Node 22 installed, `resolve_node22()` returns an error string: `"Could not find Node.js 22. Install it via: brew install node@22 or use nvm: nvm install 22"`. This error surfaces as a native notification (via `send_notification`) and the server stays in `Error` state. The user sees a tray icon, clicks it, gets the fallback page -- and has no guidance beyond the notification that disappeared 5 seconds ago.

**The cli.js cliff.** In a release build (not monorepo dev), `resolve_cli_js()` will fail the monorepo walk, then try `CHROXY_SERVER_PATH` (unset), then `which chroxy` (not installed if they only installed the desktop app). The user gets: `"Could not find chroxy server. Set CHROXY_SERVER_PATH or run from the monorepo."` This is a dead end.

**No dependency check at startup.** The `doctor.js` checks (Node version, cloudflared, claude CLI, config, port) exist but are never run automatically. The user finds out about missing dependencies one at a time as things fail.

### Recommendation: First-Run Wizard

The desktop app needs a first-run sequence that runs before attempting to start the server:

```
Step 1: Dependency Check
  [ ] Node.js 22    -- found at /opt/homebrew/opt/node@22/bin/node
  [ ] cloudflared   -- not found (optional for remote access)
  [ ] claude CLI    -- found: claude v1.2.3

  Missing: cloudflared (optional)
  [Install cloudflared] [Skip -- I'll use Local Only mode]

Step 2: Configuration
  Port: [8765]
  Tunnel mode: (o) Quick Tunnel  ( ) Named Tunnel  ( ) Local Only

Step 3: Ready
  Your API token: abc123-def456-...  [Copy]
  [Start Server]
```

This should be implemented as a state in the fallback/main window, not a separate window. The existing `show_fallback` mechanism can serve this. Check whether Node and claude CLI are present before ever calling `server.start()`.

**Specific code changes needed:**

- `setup.rs`: Expand `ensure_config()` to return a struct indicating what's missing, not just whether config was created
- `lib.rs`: Before `handle_start`, run the equivalent of `doctor` checks via Tauri IPC
- `node.rs`: Return a structured error (enum with `NodeNotFound`, `WrongVersion(String)`) instead of a format string

---

## 2. Update Experience

### Current State: Nothing

There is no update mechanism. The `tauri.conf.json` has no `updater` plugin configured. The user has no way to know a new version exists unless they manually check GitHub.

For comparison:
- **Cursor**: Background check, notification badge, one-click update, auto-restart
- **VS Code**: Same pattern with release notes
- **Docker Desktop**: Notification with changelog

### Recommendation

Tauri v2 has a built-in updater plugin (`tauri-plugin-updater`). The implementation plan should include:

1. **Phase 0 addition**: Add `tauri-plugin-updater` with a GitHub Releases endpoint
2. **Check on launch**: Poll for updates on startup (with 30s delay to not block first paint)
3. **Tray menu item**: "Check for Updates..." between the settings group and Quit
4. **Non-intrusive notification**: "Chroxy 0.3.0 available -- [Update Now]" as a native notification
5. **Optional auto-update**: `DesktopSettings` gets an `auto_update: bool` field (default: true for patch versions, prompt for minor/major)

The update should handle the Node.js server gracefully: stop sessions, update binaries, restart. The supervisor's drain mechanism (`restartChild` with `SIGUSR2`) is already designed for this -- the update flow should use it.

**Server package updates** are a separate concern from desktop app updates. Since the server ships as a Node.js package (resolved via `cli.js`), updates to server code need either:
- Bundling the server into the Tauri app's resources (recommended -- eliminates the `resolve_cli_js` problem entirely)
- Or a `chroxy update` CLI command that pulls the latest npm package

Bundling is strongly recommended. It makes the first-run experience trivial (no `CHROXY_SERVER_PATH` needed) and makes updates atomic.

---

## 3. Performance Budget

### Current Constraints

From `session-manager.js`:
- `maxSessions = 5` (hardcoded default)
- `_maxHistory = 500` messages per session ring buffer
- History entries truncated at 50KB per entry for serialization
- State persisted to `~/.chroxy/session-state.json` with 2s debounce

From `server.rs`:
- Log buffer: 100 lines in a `VecDeque` (very small)
- Health poll: every 5s (lightweight)

### What's Missing: No Memory Monitoring

There is zero memory tracking anywhere in the codebase. `grep` for RSS, heap, memory yields only a dashboard UI reference. This is a significant gap for a tool that will run 8 hours a day.

Each Claude Code session (via Agent SDK) spawns a child process. 5 concurrent sessions means 5 Node.js child processes plus the server process plus the Tauri process. On a 16GB MacBook:

### Proposed Performance Budget

| Component | Expected Memory | Notes |
|-----------|----------------|-------|
| Tauri shell (Rust) | ~30-50 MB | WebView + tray, lightweight |
| Node.js server | ~80-120 MB | Base server + WebSocket + session state |
| Per Claude SDK session | ~50-100 MB | Agent SDK child process |
| Per session history (500 msgs) | ~5-25 MB | Depends on message size; 50KB cap helps |
| Total (5 sessions) | ~450-750 MB | Acceptable on 16GB, tight on 8GB |

### Recommendations

1. **Add `process.memoryUsage()` to the health endpoint.** The server already has a health check at `GET /`. Include RSS and heap stats. Cost: 5 lines of code.

2. **Session memory guard.** Before creating session N, check available system memory. If RSS is above 1GB (configurable), warn the user. If above 2GB, refuse new sessions.

3. **Add `maxSessions` to config.** It's currently hardcoded at 5 in `SessionManager`. It should be in `CONFIG_SCHEMA` and configurable via `config.json`. Users on beefy machines want 10; users on 8GB laptops want 3.

4. **History pruning for idle sessions.** The 500-message ring buffer is per-session and never shrinks. For sessions idle > 1 hour, compact history to the last 50 messages and rely on JSONL replay for full history on reconnect. This is especially important for the IDE vision where 5+ sessions may sit idle with full buffers.

5. **CPU: fan noise prevention.** The biggest CPU concern is health polling. Currently: server.rs polls every 5s, supervisor heartbeats every 5 minutes. This is reasonable. But when streaming from 3 sessions simultaneously, the bottleneck is terminal rendering in xterm.js. The plan should include requestAnimationFrame throttling for terminal redraws -- rendering 3 terminals at 60fps is unnecessary; 15fps is visually indistinguishable for terminal output.

---

## 4. Configuration Recommendation

### Current Configuration Surface

The system has three config files:
- `~/.chroxy/config.json` -- server config (22 keys in `CONFIG_SCHEMA`)
- `~/.chroxy/desktop-settings.json` -- desktop-specific (8 fields)
- `~/.chroxy/session-state.json` -- serialized session state (not user-editable)

Plus environment variables for every config key, plus CLI flags.

### What Should Be Configurable (User-Facing)

| Setting | Default | Where | Notes |
|---------|---------|-------|-------|
| Port | 8765 | config.json | Rarely changed |
| Tunnel mode | quick | desktop-settings | Already in tray menu |
| Auto-start server | true | desktop-settings | Already in tray menu |
| Start at login | false | desktop-settings | Already in tray menu |
| Model | (system default) | config.json | Should be in Settings UI |
| Max sessions | 5 | config.json | New: needs to be configurable |
| Session timeout | none | config.json | Exists but not exposed in UI |
| Cost budget | none | config.json | Exists but not exposed in UI |
| Notifications | true | desktop-settings | Exists |
| Theme | system | desktop-settings | New: dark/light/system |

### What Should Be Convention-Over-Configuration (Not Exposed)

| Setting | Convention | Rationale |
|---------|-----------|-----------|
| API token | Auto-generated UUID | Users should never need to see or edit this |
| Log directory | `~/.chroxy/logs/` | Standard location, no reason to change |
| State file | `~/.chroxy/session-state.json` | Internal implementation detail |
| Max history | 500 | Internal ring buffer size |
| Health poll interval | 5s | Internal timing |
| WebSocket max payload | 10MB | Protocol detail |
| PID file location | `~/.chroxy/supervisor.pid` | Internal |

### What's Wrong Today

The `config.json` mixes operator concerns (port, tunnel) with developer concerns (transforms, maxToolInput, maxPayload). The desktop app should expose a Settings panel (Phase 3) that shows only the user-facing settings above, while power users can still edit `config.json` directly.

The `desktop-settings.json` is created with `fs::write` (world-readable). The same permission issue flagged for `config.json` in Phase 0 applies here. Use `0o600` permissions.

---

## 5. Troubleshooting

### Current Diagnostic Tools

1. **`chroxy doctor`** (`doctor.js`): Checks Node version, cloudflared, claude CLI, config validation, node_modules, port availability. Returns pass/warn/fail for each. Good foundation.

2. **Logger** (`logger.js`): File logging with 5MB rotation and 3 retained files. Writes to `~/.chroxy/logs/chroxy.log`. Has debug/info/warn/error levels. Runtime level switching.

3. **Server log buffer** (`server.rs`): 100-line ring buffer capturing stdout/stderr from the Node process. Only accessible programmatically -- not exposed to the user.

4. **Supervisor metrics**: Uptime, restart count, consecutive restarts, last exit reason, last backoff. Logged in heartbeat every 5 minutes.

5. **Standby server**: Returns `{"status":"restarting", "restartEtaMs": ..., "metrics": {...}}` when child is down. Smart -- the app can show "restarting in 3s" instead of "connection lost."

### What's Missing

**No "View Logs" menu item.** The user has no way to access logs from the desktop app. They'd need to know to look in `~/.chroxy/logs/` and use `tail -f`. This is a showstopper for non-CLI users.

**No "Run Doctor" from the app.** The doctor command is CLI-only (`npx chroxy doctor`). The desktop app should be able to run diagnostics and show results.

**No error correlation.** When something goes wrong, the user sees a notification like "Server Error" with a message. There's no way to get more context, see what happened before the error, or find related log entries.

**No server.rs log persistence.** The 100-line buffer in `server.rs` is in-memory only. If the Tauri app crashes, the server logs are lost. The server's own file logger captures its output, but only if `initFileLogging` was called -- and in the Tauri-managed mode (`--no-supervisor`), the server runs without the supervisor, so file logging may not be initialized.

### Troubleshooting Playbook Outline

The plan should include a troubleshooting section in the Settings/Help UI:

```
Diagnostics (accessible from tray menu: Help > Diagnostics)

1. System Check (equivalent to `chroxy doctor`)
   - Node.js version and path
   - cloudflared status
   - claude CLI version
   - Config file validation
   - Port availability
   - Disk space for logs/state

2. Server Status
   - Current status (Running/Stopped/Error/Starting)
   - Uptime
   - Active sessions (count, memory)
   - Tunnel status and URL
   - Last 50 log lines (from the server.rs ring buffer)

3. Connection Test
   - WebSocket connectivity (localhost)
   - Tunnel reachability (if enabled)
   - Authentication test

4. Export Diagnostics
   - Bundle: last 3 log files + config (sanitized) + doctor results + system info
   - Copy to clipboard or save as .zip
   - For bug reports

5. Common Issues
   - "Server won't start" -> Check Node 22, check port conflicts
   - "Tunnel not working" -> Check cloudflared, try Local Only mode
   - "Sessions disconnecting" -> Check session timeout, check network
   - "High memory usage" -> Reduce max sessions, check for zombie processes
```

---

## 6. Multi-Machine Support

### Current State

The vision document mentions "Connect to Chroxy servers on multiple dev machines" as a Phase 4 feature. The tunnel system already enables this: each machine runs its own server with its own tunnel URL. The mobile app can connect to any tunnel URL.

### Gaps for the Desktop App

The desktop app currently manages exactly one server -- the one it spawns locally. For multi-machine support:

1. **Saved connections.** `desktop-settings.json` should support a list of remote servers: `[{ name: "Work Desktop", url: "wss://...", token: "..." }]`. The sidebar would show local + remote servers.

2. **Config sync.** Users will want their preferences (model, shortcuts, theme) consistent across machines. Options: manual (edit config.json on each), or sync via a shared config service. Recommendation: defer sync, just make `config.json` portable. Document "copy `~/.chroxy/config.json` to your other machine."

3. **Offline considerations.** See next section.

---

## 7. Offline Behavior

### What Works Offline Today

- Tauri app launches (it's a local binary)
- Server starts (Node.js, local)
- WebSocket on localhost works
- Session creation works (Claude Code needs API access, but the _server_ doesn't crash)
- Dashboard loads (served from local server)

### What Breaks Offline

- **Tunnel fails.** Cloudflare Quick Tunnel requires internet. The supervisor's `start()` awaits `_waitForTunnel(httpUrl)` which will timeout after ~30s. This blocks the entire startup flow.
- **Claude Code sessions fail.** The Agent SDK needs Anthropic's API. Sessions will error on first message.
- **Session resume fails if JSONL files reference remote resources.** (Unlikely, but worth noting.)

### Graceful Degradation Plan

1. **Tunnel failure should not block server startup.** Currently in `supervisor.js`, tunnel start is step 1 and awaited before the child starts. The server should start in local-only mode if the tunnel fails, with a status indicator showing "Tunnel: offline (retrying)". The tunnel should reconnect in the background.

2. **Claude Code API failures should be surfaced clearly.** When the Agent SDK can't reach the API, the session should show "API unreachable -- check your internet connection" rather than a cryptic error or infinite spinner.

3. **The desktop app should detect network state.** Tauri can check navigator.onLine. Show a subtle "Offline" badge in the status bar. When connectivity returns, automatically retry tunnel and notify the user.

4. **Quick Tunnel URL changes on reconnect.** After an internet outage, Quick Tunnel will get a new URL. The mobile app will lose its connection. The supervisor already handles `tunnel_recovered` events and displays a new QR code. This is good -- but should also push a notification to reconnect mobile clients.

---

## 8. Resource Management

### Disk Usage

- **Logs:** 5MB max per file, 3 rotated files = 20MB max. Reasonable.
- **Session state:** `session-state.json` with 500 messages * 5 sessions * 50KB max per entry = theoretically up to 125MB. In practice much less, but the 50KB truncation limit per entry is generous. 10KB would be safer.
- **JSONL conversation files:** These live in `~/.claude/projects/` and are managed by Claude Code, not Chroxy. But Chroxy reads them for history replay. Large conversations can produce multi-MB JSONL files. Chroxy should not attempt to load these entirely into memory.
- **Config/settings:** Negligible (<1KB each).

### Process Cleanup

The `ServerManager::drop()` calls `self.stop()` which sends SIGTERM then SIGKILL after 5s. Good. But there's no cleanup of orphaned child processes if Tauri crashes without calling drop (SIGKILL on Tauri, power loss, etc.).

**Recommendation:** On startup, check for a stale PID file (`~/.chroxy/supervisor.pid`). If the PID is still running, either attach to it or kill it. The supervisor already writes this file (`supervisor.js` line 225). The desktop app should read it on launch. Currently `server.rs` doesn't check for stale processes at all.

### Session Cleanup

- Session timeout exists (`sessionTimeout` config) but is not set by default. This means sessions accumulate indefinitely until the server restarts or the user manually destroys them.
- Cost budget exists but is also not set by default.
- State file TTL is 24 hours -- sessions older than that won't be restored. Good.

**Recommendation:** Default session timeout should be 4 hours for the desktop app. Users running the IDE all day will have active sessions; genuinely idle ones should be cleaned up. The desktop `DesktopSettings` should include a `defaultSessionTimeout` field that's passed to the server.

---

## 9. Quality-of-Life Features

These are the difference between "functional tool" and "tool I love using every day":

### Must-Have for Daily Driver (Phase 3)

1. **Keyboard shortcuts with visual hints.** Cmd+1-9 for tabs is in the plan. Also need: Cmd+T (new session), Cmd+W (close tab), Cmd+K (clear terminal), Cmd+Shift+P (command palette). Show shortcut hints in menus and tooltips.

2. **Session status in tray tooltip.** Currently tooltip is just "Chroxy". Should be: "Chroxy -- 3 sessions (2 active, 1 idle) -- $0.42 spent". This gives a glance-able summary without opening the window.

3. **Sound for permission requests.** When a session needs permission approval and the window is in the background, a subtle sound (configurable, off by default) brings attention without a full notification.

4. **"Copy tunnel URL" in tray menu.** Quick access to share the URL for mobile connection. Currently requires opening the dashboard.

5. **Session cost in tab title.** Tab shows "Fix tunnel recovery -- $0.12" so you can see spend per session at a glance. The `cost_update` event already provides this data.

6. **Startup time optimization.** The current flow is: launch Tauri -> resolve Node -> resolve cli.js -> spawn server -> health poll (2s intervals, up to 30s timeout) -> show dashboard. Target: under 3 seconds from click to usable dashboard. Cache the Node path in `desktop-settings.json` (already has `node_path` field but it's not populated by the resolution logic).

### Nice-to-Have (Phase 4+)

7. **Session templates.** "Start a new session in chroxy with model opus-4, dangerously skip permissions, and send this initial prompt: 'Resume. Read CLAUDE.md and check git status.'" Save as a template, one-click launch.

8. **Global hotkey.** Cmd+Shift+C (configurable) to show/focus Chroxy from anywhere. Tauri supports global shortcuts via `tauri-plugin-global-shortcut`.

9. **Activity log timeline.** A compact timeline view showing: session started, 3 messages exchanged, permission requested, tool executed, session idle. Useful for "what did my agents do while I was at lunch?"

10. **Drag-and-drop repo addition.** Drag a folder from Finder onto the sidebar to add it as a repo.

---

## 10. Summary of Critical Gaps

| Gap | Severity | Effort | Phase |
|-----|----------|--------|-------|
| No update mechanism | High | 2-3 days | 0 |
| First-run fails silently on missing Node/server | High | 1-2 days | 0 |
| No "View Logs" in desktop app | Medium | 1 day | 1 |
| No memory monitoring or limits | Medium | 1 day | 1 |
| `maxSessions` not configurable | Low | 30 min | 0 |
| `desktop-settings.json` world-readable | Medium | 15 min | 0 |
| Tunnel failure blocks server startup | Medium | 2-3 hours | 0 |
| No stale process cleanup on startup | Medium | 1-2 hours | 0 |
| No default session timeout | Low | 15 min | 1 |
| Node path not cached after resolution | Low | 30 min | 1 |
| Server not bundled with desktop app | High | 1-2 days | 1 |

### Why 3.2/5

**What earns points:**
- The supervisor architecture is production-grade: standby health server, backoff, drain, deploy rollback
- Config precedence (CLI > env > file > default) is correct and well-implemented
- The doctor command exists and checks the right things
- Log rotation exists with sensible defaults
- Session state persistence survives restarts with 24h TTL
- Cost budget tracking with warning thresholds
- The convention-over-configuration principle is stated and mostly followed

**What costs points:**
- The first-run experience has two hard cliffs (Node 22, cli.js resolution) with no recovery UI
- Zero update mechanism
- Zero memory awareness
- Diagnostic tools exist but are CLI-only, not integrated into the desktop UI
- Tunnel failure blocks everything instead of degrading gracefully
- The desktop app doesn't bundle or manage the server it depends on -- this is the fundamental operator problem

The gap between "the pieces exist" and "the pieces work together for a daily driver" is about 2-3 weeks of focused work, mostly in Phases 0 and 1. The roadmap correctly identifies Phase 3 as the "daily driver moment" -- but some of these items (update mechanism, first-run wizard, bundled server) need to land earlier or the user never gets to Phase 3.
