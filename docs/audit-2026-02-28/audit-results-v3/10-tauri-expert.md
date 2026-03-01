# Tauri Expert v3: Desktop Architecture Audit

**Perspective**: Domain expert in Tauri framework and Rust desktop apps
**v2 Rating**: 3.5/5
**v3 Rating**: 3.5/5 (unchanged -- see rationale at end)
**Date**: 2026-02-28

---

## Task 1: Re-verification of v2 Findings

I re-read every Rust source file, `tauri.conf.json`, `Cargo.toml`, `dist/index.html`, and the server-side `dashboard.js` that renders the dashboard HTML. Here is the re-verification of each v2 finding against the actual code.

### Finding 1: `withGlobalTauri: false` means WebView cannot access Tauri APIs

**Re-verified: CORRECT.**

`tauri.conf.json:9`:
```json
"withGlobalTauri": false
```

This setting controls whether Tauri injects `window.__TAURI__` into all WebView pages. With `false`, JavaScript running in the WebView has no access to `window.__TAURI__.core.invoke()`, `window.__TAURI__.event.listen()`, or any other Tauri JS API. This applies to both:

- The **fallback/loading page** (`dist/index.html`) -- loaded via `WebviewUrl` from the bundled frontend dist.
- The **dashboard** (`http://localhost:{port}/dashboard`) -- loaded as an external URL via `WebviewUrl::External`.

Even if `withGlobalTauri` were `true`, the dashboard would still be blocked by CSP. The CSP in `tauri.conf.json:11-12` is:
```
default-src 'self' http://localhost:*; connect-src ws://localhost:* http://localhost:*; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'
```

The `script-src 'self' 'unsafe-inline'` allows inline scripts but does not include `'unsafe-eval'` or any Tauri-specific scheme. The `default-src 'self'` means the Tauri JS IPC bridge (which uses a custom protocol scheme `ipc://localhost` or `https://ipc.localhost` depending on platform) would be blocked unless explicitly allowed.

**Bottom line**: The WebView is a pure browser environment. No Tauri API surface is exposed to any page loaded in it.

### Finding 2: `win.eval()` is an anti-pattern -- should use `app.emit()` events

**Re-verified with nuance: TECHNICALLY CORRECT but see Task 2 for the Minimalist's counterargument.**

The single `win.eval()` call is at `window.rs:85-88`:
```rust
let _ = win.eval(&format!(
    "if (typeof window.__startPolling === 'function') {{ window.__startPolling({}, '{}', '{}'); }}",
    p, escaped, tm
));
```

In Tauri v2, `Webview::eval()` is the equivalent of calling `webview.evaluateJavaScript()` on the underlying platform WebView (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). It is a one-way fire-and-forget string injection with no return value and no error propagation beyond platform-level failures.

The Tauri-idiomatic alternatives are:
1. **`app.emit("event-name", payload)`** (Tauri v2) -- emits a global event that any page with `window.__TAURI__.event.listen()` can receive. Requires `withGlobalTauri: true` or explicit JS-side Tauri API import.
2. **`webview.emit_to("label", "event-name", payload)`** -- emits to a specific webview by label. Same requirement.
3. **`#[tauri::command]`** -- for request/response patterns (not applicable here since the flow is Rust-pushes-to-JS).

The anti-pattern concern is valid in general because `eval()`:
- Requires manual string escaping (the code does escape `\`, `'`, `\n`, `\r` but not `\0`, `\u2028`, `\u2029`)
- Has no type safety (payload shape is not validated)
- Fails silently if the function does not exist (the `if (typeof ...)` guard mitigates this)
- Cannot return data to the Rust side

However, I address in Task 2 whether this matters for this specific use case.

### Finding 3: Tauri IPC is always JSON via serde_json (no raw bytes)

**Re-verified: CORRECT.**

Tauri v2's IPC mechanism works as follows:
- `#[tauri::command]` functions serialize/deserialize all arguments and return values via `serde_json`.
- `app.emit()` / `webview.emit()` serialize the payload via `serde_json::to_value()`.
- `Vec<u8>` is serialized as a JSON array of numbers (e.g., `[72, 101, 108, 108, 111]`), not base64. I correct my v2 statement -- it is worse than base64 for large payloads because each byte becomes 1-3 JSON characters plus comma separators.
- There is no raw byte channel in Tauri's IPC. The `tauri::ipc::Channel` (new in Tauri v2) is a streaming IPC mechanism but it still uses JSON serialization.

The audit document's claim of "skip JSON serialization for terminal data (pass raw bytes)" is impossible without going outside Tauri's IPC entirely (e.g., a separate local socket or shared file).

### Finding 4: No shared memory exists in Tauri (WebView is a separate process)

**Re-verified: CORRECT with platform nuance.**

On macOS, WKWebView runs in a separate process (Web Content process). On Windows, WebView2 (Chromium-based) also runs in a separate process. On Linux with WebKitGTK, the rendering may be in-process for some configurations but the JavaScript execution context is still isolated.

There is no Tauri API for shared memory between the Rust process and the WebView's JavaScript context. The only data transfer mechanisms are:
1. IPC (JSON-serialized commands and events)
2. `eval()` (string injection)
3. HTTP requests to a local server
4. File system (write from Rust, read from JS via `fetch` or XHR)

The audit's "direct memory sharing for large payloads" proposal is not implementable within Tauri's architecture.

### Finding 5: Zero `#[tauri::command]` handlers -- no command bridge exists

**Re-verified: CORRECT.**

Grepped all `.rs` files in `src-tauri/src/` -- zero occurrences of `#[tauri::command]`. The `tauri::Builder` in `lib.rs:38-87` has no `.invoke_handler()` call. The WebView has no way to call into Rust even if `withGlobalTauri` were enabled, because there are no commands registered to invoke.

All Rust-to-JS communication is through the single `win.eval()` call. All JS-to-server communication is through HTTP `fetch()` (health polling, QR endpoint) and WebSocket (dashboard).

---

## Task 2: Is the Minimalist Right About `win.eval()`?

The Minimalist's argument (from `04-minimalist.md:65`):

> There is exactly ONE `win.eval()` call that triggers health polling on the loading page. This page is a standalone HTML file in `dist/index.html`. Replacing this single eval with an event system requires: enabling `withGlobalTauri`, adding a Tauri event listener to the fallback page, importing Tauri JS API. Net result: same behavior, more code, new dependency. The current eval is safe (it calls a known function with port/token values that the Rust code already controls).

**My assessment: The Minimalist is substantially right for the current codebase, but wrong about the long-term trajectory.**

### Where the Minimalist is right

1. **The eval is safe in isolation.** The `window.__startPolling(port, token, tunnelMode)` call passes:
   - `port`: a `u16` integer -- no injection risk
   - `token`: a UUID v4 string, escaped against `\`, `'`, `\n`, `\r` -- low injection risk (UUIDs are hex + hyphens)
   - `tunnelMode`: one of `"quick"`, `"named"`, `"none"` -- hardcoded set, no injection risk

2. **The target page is controlled.** `dist/index.html` is bundled with the Tauri app. It is not a third-party page. The `__startPolling` function is a known contract.

3. **The replacement cost is real.** Switching to `app.emit()` events requires:
   - Set `withGlobalTauri: true` in `tauri.conf.json`
   - Add `<script>` to `dist/index.html` that calls `window.__TAURI__.event.listen('start-polling', ...)`
   - Change `window.rs` to call `win.emit("start-polling", payload)` instead of `win.eval()`
   - Add `serde::Serialize` to the payload struct
   - Test that the event listener fires correctly on all platforms

   This is about 2-4 hours of work, not the 1 day estimated in the v2 master. But it is still 2-4 hours for identical behavior.

4. **The eval will not proliferate.** The dashboard is an external URL. You cannot `eval()` into it after navigation (well, you can, but it would be injecting into a full application context -- nobody would do this). New desktop features that need Rust-to-JS communication will inherently require the event bridge, regardless of whether this single eval is migrated.

### Where the Minimalist is wrong

1. **`withGlobalTauri` will be needed anyway.** The v2 master's Short-term item "Permission notification when window hidden" requires the Rust layer to know when a permission request arrives. The Minimalist proposes two workarounds: a second WebSocket listener in Rust, or a local HTTP callback from Node. Both are more complex than simply enabling `withGlobalTauri` and having the dashboard JS emit events to Tauri when permission requests arrive. Once `withGlobalTauri` is enabled for the dashboard (which requires CSP changes for the external URL), migrating the single eval is trivial incremental work.

2. **The escaping is incomplete.** The current escape handles `\`, `'`, `\n`, `\r`. It does not handle:
   - Null bytes (`\0`)
   - Line/paragraph separators (`\u2028`, `\u2029`) which are valid in JSON strings but act as line terminators in JavaScript
   - Backtick (`` ` ``) -- not relevant since the template uses single quotes

   These are theoretical risks since the token is a UUID v4, but they indicate the fragility of string-based IPC compared to structured event payloads.

3. **It sets a precedent.** Other developers seeing `eval()` in the codebase will reach for it when adding features. A clean event-based pattern from the start prevents this.

### My verdict

**Do not prioritize replacing `win.eval()` as a standalone task. But when `withGlobalTauri` is enabled for any reason (which will happen when desktop-specific features are added), migrate the eval as part of that work. Cost at that point: 30 minutes, not 1 day.**

The v2 master's Short-term list should reframe this from:

> Replace `win.eval()` with `app.emit()` events (1 day)

To:

> Enable `withGlobalTauri` and migrate `win.eval()` to events (bundle with first feature requiring Tauri JS API, incremental cost: 30 min)

---

## Task 3: Correct Tauri Architecture for the Desktop App

### 3a: Should the dashboard be served by Node (current) or bundled in Tauri (Vite)?

**Answer: Keep it served by Node. Here is why.**

The current architecture:
```
Tauri WebView → http://localhost:{port}/dashboard → Node serves HTML/JS/CSS
                                                  → Dashboard JS ← WebSocket → Node server
```

A bundled Vite architecture would be:
```
Tauri WebView → tauri://localhost/index.html → Vite-built React app
                                             → React app ← Tauri IPC → Rust
                                             → Rust ← stdio/socket → Node server
```

Arguments for Node-served (current):

1. **The dashboard and Node server are a unit.** The dashboard JS speaks the exact WebSocket protocol that the Node server implements. Versioning them together (same git commit, same deployment) eliminates protocol version mismatches. If the dashboard is bundled in Tauri, a server update could change the protocol while the bundled UI is still on the old version.

2. **The mobile app, web browser, and desktop all use the same dashboard.** The Node-served dashboard is accessible from any WebView, any browser, and the Tauri app. Bundling it in Tauri creates a desktop-only fork that must be maintained separately.

3. **Hot reload for free.** In dev, changes to `dashboard-app.js` are picked up on page refresh. No Vite HMR setup needed.

4. **No Rust-to-Node IPC bridge needed.** The bundled approach requires the React app to talk to Node through Rust (via Tauri commands + stdio/socket IPC). The current approach lets JS talk directly to Node over WebSocket. One hop vs. three.

Arguments for bundled Vite:

1. **Tauri-native features** (window management, file dialogs, system tray interaction) require Tauri JS APIs, which work best with a bundled frontend.
2. **Offline capability** -- the bundled UI works even when the Node server is down.
3. **Performance** -- no network round-trip for initial page load.

**My recommendation**: Keep Node-served for the dashboard. Use the bundled `dist/` frontend only for the loading/fallback page (as currently implemented). If Tauri-native features are needed in the dashboard (e.g., native file picker for repo selection), add them as `#[tauri::command]` handlers that the dashboard JS can call via `fetch('http://localhost:{port}/tauri-proxy/...')` -- the Node server proxies to a local Tauri command socket. This avoids forking the dashboard while still enabling native features.

However, there is one scenario where a bundled dashboard becomes necessary: if the project wants to ship a standalone desktop app without requiring Node.js. In that case, bundling is the only option. But that is a fundamental architecture change (the entire server would need to be rewritten or embedded), not a dashboard question.

### 3b: Should the WebView talk to Node via WebSocket (current) or via Tauri IPC?

**Answer: Keep WebSocket for all data flow. Use Tauri IPC only for desktop-native capabilities.**

The correct separation of concerns:

| Communication path | Use case | Mechanism |
|---|---|---|
| Dashboard JS <-> Node server | All session data, messages, streaming, auth | WebSocket (existing) |
| Dashboard JS -> Rust | Desktop-native features: copy to clipboard, file dialogs, window management | `invoke()` via `#[tauri::command]` |
| Rust -> Dashboard JS | Desktop notifications, tray state sync, permission alerts | `app.emit()` events |
| Rust -> Node server | Process management, health checks | Child process stdio + HTTP (existing) |

Rationale: WebSocket is the transport that works for all clients (mobile, browser, desktop). The desktop should not have a special snowflake data path. Tauri IPC should be used exclusively for things that only a native desktop app can do.

### 3c: What Tauri plugins should be added?

Current plugins in `Cargo.toml`:
- `tauri-plugin-shell` (v2) -- for `shell.open()` (opening URLs in default browser)
- `tauri-plugin-autostart` (v2) -- for macOS LaunchAgent auto-start
- `tauri-plugin-notification` (v2) -- for OS notifications

**Recommended additions:**

| Plugin | Priority | Rationale |
|---|---|---|
| `tauri-plugin-single-instance` | **High** | Prevents multiple Chroxy instances. Currently, launching a second instance spawns a second Node server that fails on port conflict. The single-instance plugin detects the running instance and focuses its window instead. ~30 lines of code to integrate. |
| `tauri-plugin-updater` | **Medium** | OTA updates for the desktop app. Without this, users must manually download new versions. Pairs with the existing `bundle.macOS.signingIdentity` signing config. Requires a release server (GitHub Releases works). |
| `tauri-plugin-clipboard-manager` | **Medium** | Copy tunnel URL to clipboard from tray menu. Currently no clipboard access exists. The Minimalist's "Copy URL" tray action (from their 1-week plan) needs this. |
| `tauri-plugin-log` | **Low** | Structured logging with rotation. Currently uses `eprintln!` for errors. Not urgent but useful for debugging user-reported issues. |
| `tauri-plugin-process` | **Low** | Process info (PID, restart). Already handled manually via `libc::kill()` and `child.kill()`. The plugin would be cleaner but is not a functional gap. |

**Not recommended:**
- `tauri-plugin-store` -- Already have a custom `DesktopSettings` persistence to JSON. The plugin adds no value.
- `tauri-plugin-fs` -- No need for the WebView to access the filesystem through Tauri. File operations go through the Node server.
- `tauri-plugin-dialog` -- No dialog-heavy workflows exist currently. Add when needed.

---

## Task 4: Minimum Tauri-Side Work for v2 Master's Short-term Items

The v2 master's Short-term list (Weeks 1-4) has 7 items. Here is what each requires from the Tauri/Rust side specifically.

### 1. Surface tunnel status in tray menu (1-2 days)

**Tauri work required:**
- Add a `MenuItem` for tunnel URL display in `lib.rs` tray setup (static text, updated dynamically)
- Add `tauri-plugin-clipboard-manager` to copy URL on click
- Parse tunnel URL from server stdout (already captured in `server.rs:150-162` log buffer) or add a `GET /tunnel-info` endpoint to the Node server and poll it after health check passes
- Update the menu item when tunnel state changes (monitor server stdout for tunnel URL patterns)

**Estimated Rust changes**: ~80-100 lines in `lib.rs` + `server.rs`, plus `Cargo.toml` dependency.

### 2. Add tunnel restart to tray menu (1 day)

**Tauri work required:**
- Add a "Restart Tunnel" `MenuItem` to the tray menu
- The handler needs to send a signal or HTTP request to the Node server to restart just the tunnel, not the entire server process
- This requires a new server-side endpoint (e.g., `POST /api/tunnel/restart` with token auth), not a Tauri change per se
- Alternatively, expose a `SIGUSR1` handler in the Node server that triggers tunnel restart, and send `libc::kill(child.id(), libc::SIGUSR1)` from Rust

**Estimated Rust changes**: ~20 lines in `lib.rs` for the menu item + handler. The real work is on the Node server side.

### 3. Fix `_broadcastToSession` to actually filter (1-2 days)

**Tauri work required: None.** This is a Node server bug in `ws-server.js`. No Rust changes.

### 4. Add orphan process detection on startup (1-2 days)

**Tauri work required:**
- Write a PID file when the server child process starts (`server.rs`, after `child = cmd.spawn()`)
- On startup, check for stale PID file, verify process is alive via `libc::kill(pid, 0)`
- Clean up stale PID file if process is dead
- Show notification or tray menu state if process is already running

**Estimated Rust changes**: ~40-60 lines in `server.rs` for PID file management.

### 5. Add re-entry guard to tunnel recovery (30 min)

**Tauri work required: None.** This is a Node server change in `tunnel/base.js`. No Rust changes.

### 6. Permission notification when window hidden (1-2 days)

**Tauri work required (two approaches):**

**Approach A (Minimal Rust, recommended):** Add a polling endpoint to the Node server: `GET /api/pending-permissions`. The Rust health monitor (already polling every 5s in `server.rs:279-304`) adds a permission check. If permissions are pending and the dashboard window is hidden (`win.is_visible() == false`), fire an OS notification via `tauri_plugin_notification`. Clicking the notification shows the dashboard window.

- Rust changes: ~30 lines in the health poll loop + notification logic
- Node changes: 1 new HTTP endpoint (~20 lines)

**Approach B (Full Tauri events):** Enable `withGlobalTauri: true`. Add a Tauri event listener in the dashboard JS. When a `permission_request` WebSocket message arrives, the dashboard JS calls `window.__TAURI__.event.emit('permission-pending', { tool, sessionId })`. Rust listens for this event and fires an OS notification if the window is hidden.

- Requires: `withGlobalTauri: true`, CSP changes for external URL, Tauri JS API in dashboard, event listener in Rust
- More "correct" architecturally but significantly more integration work
- Also requires the `win.eval()` migration (incremental, as discussed in Task 2)

**Recommendation**: Start with Approach A. It works with zero changes to the Tauri/WebView architecture. Migrate to Approach B when/if `withGlobalTauri` is enabled for other features.

### 7. Replace `win.eval()` with `app.emit()` events (1 day)

**Tauri work required (if done standalone):**
- Set `withGlobalTauri: true` in `tauri.conf.json`
- Update CSP to allow Tauri IPC scheme
- Add event listener in `dist/index.html`: `window.__TAURI__.event.listen('start-polling', (event) => { ... })`
- Change `window.rs:85-88` from `win.eval(...)` to `win.emit("start-polling", StartPollingPayload { port, token, tunnel_mode })`
- Add `#[derive(serde::Serialize)]` struct for the payload

**My recommendation per Task 2**: Bundle this with the first feature that requires `withGlobalTauri`. Do not do it standalone.

### Summary: Minimum Tauri-side work for Short-term items

| Item | Rust lines | New deps | Blocked by Node work? |
|---|---|---|---|
| Tunnel status in tray | ~80-100 | `tauri-plugin-clipboard-manager` | Yes (need tunnel URL source) |
| Tunnel restart in tray | ~20 | None | Yes (need server endpoint) |
| Orphan PID detection | ~40-60 | None | No |
| Permission notification | ~30 | None | Yes (need permissions endpoint) |
| **Total new Rust** | **~170-210 lines** | **1 plugin** | |

The `win.eval()` replacement and `_broadcastToSession` fix require zero Tauri-side work.

---

## Task 5: Section Ratings and Top 5 Findings

### Section Ratings

| Section | v2 Rating | v3 Rating | Rationale |
|---------|-----------|-----------|-----------|
| Message Sync | 3 | 3 | Accurate pipeline description. IPC/shared-memory recommendations remain impossible in Tauri. Differential sync is useful for mobile but irrelevant for desktop. |
| Repo/Session | 4 | 4 | Solid inventory. Session lifecycle and provider registry descriptions are reference-quality. Recommendations are generic but not wrong. |
| Tunnel | 4 | 4 | Best section. Actionable, accurate, well-structured. Minor: tunnel-check.js does not exist (per Skeptic), but the described behavior is real. |
| WebSocket | 3 | 3 | Message catalog is useful reference. "Binary serialization" and "message prioritization" recommendations are wasted effort for 1-2 clients. Schema validation concern is unfounded. |
| Data Flow | 4 | 4 | Excellent architecture diagram. Reconnection flow matches code. The single most valuable artifact in the audit for onboarding new developers. |
| Proposed Protocol | 2 | 2 | IPC channel is technically impossible as described. Differential sync has merit for mobile only. Multi-session subscription lacks any UI. Protocol v2 versioning is unnecessary in a monorepo. |

### Top 5 Findings

#### 1. `tauri-plugin-single-instance` is the highest-value missing plugin (NEW in v3)

The current app has no protection against multiple instances. Launching Chroxy twice causes:
- Two tray icons
- Second server spawn fails on port 8765 (EADDRINUSE)
- Confusing UX with two competing process managers

`tauri-plugin-single-instance` solves this in ~15 lines of code:

```rust
.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
    // Focus existing window instead of launching a new instance
    if let Some(win) = app.get_webview_window("dashboard") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}))
```

This should be in the Immediate priority list, not deferred.

#### 2. The Node-served dashboard is the correct architecture -- do not bundle it in Tauri

The audit's implicit assumption is that the "new desktop app" should have a bundled Vite/React frontend. This would create a desktop-only fork of the dashboard that must be maintained separately from the web/mobile-accessible version. The current architecture -- Node serves dashboard HTML, Tauri wraps it in a WebView -- is how Clash Verge (Tauri + external API), Docker Desktop (Electron + external Docker daemon), and similar tools work. The WebView is a thin frame around a web app that talks to its own backend. This is correct.

#### 3. The permission notification problem has a clean Tauri solution that does not require `withGlobalTauri`

The v2 master identified "permission notification when window hidden" as a Short-term item. The Minimalist proposed two complex workarounds (second WebSocket listener in Rust, or HTTP callback). The clean solution is simpler: the Rust health poll (already running every 5s) checks a `GET /api/pending-permissions` endpoint. If permissions are pending and the dashboard window is hidden, fire an OS notification. Zero changes to the Tauri/WebView architecture. Zero new dependencies. ~30 lines of Rust + ~20 lines of Node.

#### 4. The `win.eval()` is acceptable today but has a natural migration point

The Minimalist is right that replacing it as a standalone task is unnecessary churn. I am right that it is an anti-pattern that will need to be migrated eventually. The resolution: do not prioritize it, but migrate it when `withGlobalTauri` is enabled for the first desktop-native feature that requires it. At that point the marginal cost is 30 minutes, not 1 day.

#### 5. The `setup.rs` config permissions bug is the only critical Tauri-side security issue

`setup.rs:34`:
```rust
if let Err(e) = fs::write(&path, json_str) {
```

`std::fs::write()` creates files with the process umask, typically 0o644 (world-readable). The file contains the API token. Fix:

```rust
use std::os::unix::fs::OpenOptionsExt;
use std::io::Write;

let mut file = std::fs::OpenOptions::new()
    .write(true)
    .create(true)
    .truncate(true)
    .mode(0o600)
    .open(&path)
    .map_err(|e| /* ... */)?;
file.write_all(json_str.as_bytes()).map_err(|e| /* ... */)?;
```

Similarly, `settings.rs:84` has the same issue:
```rust
fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))
```

`desktop-settings.json` does not contain the token, but it does contain the tunnel mode and window position. Less critical, but should also use 0o600 for consistency with the Node side's `writeFileRestricted()` pattern.

---

## Overall Rating: 3.5/5 (unchanged from v2)

### Why unchanged

The audit document's strengths and weaknesses look the same through a Tauri lens in v3 as they did in v2:

**Strengths (unchanged)**:
- The data flow diagram accurately represents the Tauri/Node/WebView boundaries
- The appendix correctly catalogs all Rust source files and their purposes
- The tunnel section's recommendations are directly actionable in Tauri

**Weaknesses (unchanged)**:
- The IPC channel proposal remains technically impossible as described (JSON-only IPC, no shared memory)
- The "bundled Vite" assumption is implicit but wrong for this architecture
- The proposed protocol section has no awareness of Tauri's capabilities or limitations
- Zero mention of `tauri-plugin-single-instance` (the highest-value quick win)

**What improved in v2 master (acknowledged)**:
- The master correctly deferred "shared-memory terminal buffers"
- The master correctly identified the `win.eval()` migration as low-priority
- The master's short-term priorities align well with what is actually achievable in Tauri

**What the v3 Minimalist adds (acknowledged)**:
- The Minimalist is correct that the `win.eval()` replacement is not worth a standalone task
- The Minimalist is correct that the dashboard React rewrite is not a Tauri concern
- The Minimalist's 1-week plan is the most practical set of Tauri improvements proposed by any agent

The audit remains a strong codebase inventory and a weak Tauri implementation guide. It accurately describes what exists but its recommendations for the Tauri layer range from correct (tunnel status in tray) to impossible (shared memory IPC). A 3.5 reflects: good reference material, partially correct recommendations, significant gaps in Tauri-specific knowledge.
