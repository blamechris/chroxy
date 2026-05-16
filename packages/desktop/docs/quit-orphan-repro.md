# Quit-orphan repro (#3696)

When the Tauri shell exits, the spawned Node server child must be
gracefully terminated (SIGTERM) so port 8765 is released before the
next app launch.

These steps verify the fix end-to-end. Use them before merging any
change that touches `lib.rs` exit handling, `ServerManager::stop()`,
or `ServerManager::kill_child()`.

## Prerequisites

- macOS host (this is where the bug reproduces; Linux/Windows have the
  same spawn semantics but the AppleScript path is macOS-only).
- A built and installed `Chroxy.app` in `/Applications/`. Use
  `cargo tauri build` from `packages/desktop/` or download the latest
  release artifact. **Dev mode (`cargo tauri dev`) does NOT exercise
  the bundled app menu / AppleScript quit paths.**
- The server's auto-start setting enabled (so the child actually
  spawns on launch). Toggle via tray > "Auto-start Server".

## Before fix — confirm the bug reproduces

1. Quit any running Chroxy first: `osascript -e 'tell application "Chroxy" to quit'`
2. Confirm the port is free:
   ```bash
   lsof -i :8765
   ```
   Should print nothing. If something is still holding it, kill it
   manually with `pkill -TERM -f 'src/cli.js'` (NEVER `-9` — that
   wipes `session-state.json`, see CLAUDE.md memory note).
3. Launch the app: `open /Applications/Chroxy.app`
4. Wait ~3 seconds for the server child to come up, then confirm both
   processes are alive:
   ```bash
   pgrep -lf 'Chroxy.app|chroxy-desktop|src/cli.js'
   ```
   You should see two lines — the Tauri shell and the Node child.
5. Quit via each of these paths and re-check `lsof -i :8765` within
   ~5 seconds of the quit:
   - **Cmd+Q** with the app focused
   - **App menu > Quit Chroxy**
   - **Tray icon > Quit Chroxy**
   - **AppleScript:** `osascript -e 'tell application "Chroxy" to quit'`
   - **Window close (red traffic light)** while the dashboard window
     is open

   **Before the fix:** Cmd+Q, app-menu Quit, and AppleScript leave the
   Node child running (reparented to launchd / PID 1). `lsof -i :8765`
   keeps showing it. Re-launching the app fails with:
   ```
   [ERROR] [ws] Port 8765 is already in use — is another Chroxy instance running?
   ```
   The tray "Quit" path and window-close path already worked because
   they call `ServerManager::stop()` directly.

## After fix — all paths must release the port

Repeat step 5 above for every quit path. The expected behaviour:

- The Node child exits within ~5s of the quit (graceful SIGTERM gives
  the server time to flush `session-state.json`, drain the WS
  connections, and tear down the Cloudflare tunnel).
- `lsof -i :8765` returns nothing within the same window.
- Relaunching `/Applications/Chroxy.app` immediately succeeds without
  the port-in-use error.
- `~/.chroxy/session-state.json` was updated at quit-time (check
  `stat -f %m` mtime) — proving the SIGTERM-driven graceful shutdown
  ran and we did NOT escalate to SIGKILL.

## Why we use SIGTERM, not SIGKILL

The Node server registers a SIGTERM handler that flushes
`session-state.json` to disk before exiting. SIGKILL bypasses that
handler and wipes the state file, losing the user's open sessions on
the next launch (see CLAUDE.md memory note "SIGTERM not SIGKILL for
Chroxy"). `ServerManager::kill_child()` enforces this:

1. Send SIGTERM (`libc::kill(pid, SIGTERM)`).
2. Poll `try_wait()` every 100ms for up to 5 seconds.
3. Only if the child is still alive after 5s — escalate to
   `child.kill()` (SIGKILL). This is the last-resort safety net for
   a hung server.

If you observe SIGKILL escalation during a normal quit, that is a
server-side bug (#3697 tracks the underlying hang) — file a separate
issue, do NOT remove the SIGKILL fallback here.

## What the Rust-side fix actually does

`packages/desktop/src-tauri/src/lib.rs` registers a
`tauri::RunEvent::ExitRequested` handler on `.run(...)`. Every Tauri
exit path funnels through this event — Cmd+Q, app-menu Quit, tray
Quit, AppleScript, even `app_handle.exit(0)` — so we get a single
chokepoint to call `ServerManager::stop()`. The existing
window-close and tray-quit handlers still call `stop()` first; the
ExitRequested handler is the safety net that catches the macOS
quit paths that don't fire `WindowEvent::CloseRequested`.

`ServerManager::stop()` is idempotent — calling it twice is a no-op
(asserted by `server::tests::double_stop_is_safe_for_exit_handler`),
so the overlap is harmless.
