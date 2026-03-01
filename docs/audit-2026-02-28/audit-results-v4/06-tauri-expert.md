# Tauri Expert Audit: Chroxy Desktop IDE Architecture

**Auditor perspective**: Tauri v2 expert, shipped production desktop apps
**Scope**: Tauri layer architecture for the CLI Agent IDE vision
**Date**: 2026-03-01

---

## Rating: 3.0 / 5

The current Tauri implementation is a competent tray-app wrapper: it manages a Node.js child process, polls health, opens a dashboard WebView, and handles settings. This is solid Phase 0 work. However, the gap between "tray wrapper" and "IDE shell" is significant, and the plan as written underestimates several Tauri-specific concerns. The architecture's decision to keep all application data on WebSocket (Tauri IPC for native-only features) is the correct call, but the implementation needs deliberate work on window management, plugin selection, build pipeline, CSP hardening, and update delivery.

**What earns points:**
- Correct architectural separation: server is the brain, Tauri is the shell
- WebSocket-first communication avoids IPC complexity and keeps mobile/desktop in sync
- Server process management (start/stop/restart/health polling) is production-quality
- Settings persistence, autostart, and tray menu are well-implemented
- `Drop` impl on `ServerManager` ensures cleanup

**What costs points:**
- No `tauri-plugin-single-instance` (acknowledged in Phase 0 but not implemented)
- No update mechanism planned anywhere in the roadmap
- CSP is too loose for production
- `withGlobalTauri: false` is correct now but needs to flip for IDE features
- No Tauri commands defined -- zero `#[tauri::command]` functions, meaning the React migration has no IPC bridge ready
- Window management uses label-based toggling that will not scale to the IDE layout
- No `tauri-plugin-global-shortcut` for keyboard shortcuts (Phase 3 lists them but has no Tauri infrastructure)
- Build pipeline (Vite + Tauri) is not configured -- `package.json` has bare `cargo tauri dev/build` with no frontend build step

---

## 1. Window Management Architecture Recommendation

### Current State

The app uses two windows:
- `main` (fallback/loading page, from `dist/index.html`)
- `dashboard` (created dynamically, loads `http://localhost:{port}/dashboard`)

Window toggling is handled via `window::toggle_window()` and `window::open_dashboard()`. The dashboard window intercepts close events to hide instead of destroy.

### Problem

The IDE vision requires a single, persistent main window with:
- A sidebar (repo tree, session list, status)
- A tab bar (multiple terminal sessions)
- A main pane (terminal, welcome screen, or future panels)
- A status bar

This is fundamentally a **single-window application** with internal UI routing, not a multi-window application. The current two-window approach (fallback + dashboard) creates unnecessary complexity and will fight the IDE layout.

### Recommendation: Single Window, React Router

**One window. One WebView. React handles all layout.**

```
tauri.conf.json windows:
[
  {
    "label": "main",
    "title": "Chroxy",
    "width": 1200,
    "height": 800,
    "minWidth": 800,
    "minHeight": 500,
    "visible": true,
    "center": true,
    "decorations": true,
    "transparent": false
  }
]
```

The single window loads the React app. The React app has an internal router:
- **Loading state**: shown while server starts (replaces the current `dist/index.html` fallback)
- **IDE state**: sidebar + tabs + terminal (replaces the dashboard)
- **Error state**: shown when server fails to start

This eliminates:
- The `show_fallback` / `open_dashboard` / `toggle_window` state machine
- The `dist/index.html` static file entirely (React renders the loading screen)
- Window label confusion between "main" and "dashboard"
- The `win.eval()` hack for injecting port/token into the fallback page

The React app receives server state (port, token, status) via Tauri events emitted from Rust, not via `eval()`.

### Multi-Window: Not Now, Maybe Phase 4

Split-pane is listed in Phase 3. This should be implemented as **split panes within the single window** (React layout), not as separate Tauri windows. Tauri multi-window has real costs:
- Each window is a separate WebView process (memory overhead)
- Shared state between windows requires IPC or external coordination
- macOS and Windows handle multi-window focus differently
- xterm.js instances would need separate WebSocket subscriptions per window

If "tear off a tab into a separate window" is ever wanted (Phase 4+), Tauri v2 supports `WebviewWindowBuilder::new()` at runtime with `core:webview:allow-create-webview-window` permission. But defer this.

---

## 2. Tauri Configuration Recommendations

### 2.1 CSP Hardening

**Current CSP** (in `tauri.conf.json`):
```
default-src 'self' http://localhost:*;
connect-src ws://localhost:* http://localhost:*;
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline'
```

**Problems:**
- `http://localhost:*` in `default-src` is overbroad -- allows loading frames, objects, media from any localhost port
- `'unsafe-inline'` in `script-src` defeats most XSS protections
- Missing `font-src` directive (xterm.js may load fonts)
- Missing `img-src` directive (QR codes, future avatar/project icons)
- Missing `wss://` in `connect-src` (if tunnel URLs are ever loaded directly)
- No `frame-src` restriction

**Recommended CSP:**
```json
{
  "security": {
    "csp": {
      "default-src": "'self'",
      "script-src": "'self' 'unsafe-inline'",
      "style-src": "'self' 'unsafe-inline'",
      "connect-src": "'self' ws://localhost:* wss://localhost:* http://localhost:* https://localhost:*",
      "img-src": "'self' data: blob: http://localhost:*",
      "font-src": "'self' data:",
      "frame-src": "'none'",
      "object-src": "'none'",
      "base-uri": "'self'"
    },
    "dev_csp": {
      "default-src": "'self'",
      "script-src": "'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src": "'self' 'unsafe-inline'",
      "connect-src": "'self' ws://localhost:* wss://localhost:* http://localhost:* https://localhost:*",
      "img-src": "'self' data: blob: http://localhost:*",
      "font-src": "'self' data:",
      "frame-src": "'none'",
      "object-src": "'none'",
      "base-uri": "'self'"
    }
  }
}
```

Note: `'unsafe-eval'` is added only to `dev_csp` because Vite HMR requires it. The production build must not include it. Tauri v2 supports the object format for CSP which is cleaner than a single string.

The `'unsafe-inline'` in `script-src` is unfortunate but necessary if the dashboard JS uses inline scripts. Once the React migration is complete and all JS is bundled, this should be replaced with nonce-based CSP (Tauri auto-injects nonces at compile time for bundled assets).

### 2.2 `withGlobalTauri`

**Current**: `false`

This needs to become `true` once Tauri commands are introduced (Phase 1+). With `withGlobalTauri: true`, the React app can import from `@tauri-apps/api` and call `invoke()` to execute Rust commands without needing to inject `__TAURI__` manually.

However, since the dashboard is loaded from `http://localhost:{port}/dashboard` (an external URL from Tauri's perspective), there is an important nuance: **`withGlobalTauri` only injects the Tauri API into locally-served pages (`tauri://` protocol), not external URLs**. If the React app is served by the Node.js server over HTTP, `window.__TAURI__` will NOT be available.

**This is a critical architecture decision.** Two options:

**Option A (Recommended): Serve the React app from Tauri's frontend dist**
- Build React app with Vite, output to `packages/desktop/dist/`
- Tauri serves it via `tauri://localhost` (the default)
- React app connects to the Node.js server via WebSocket at `ws://localhost:{port}`
- Full Tauri IPC available via `@tauri-apps/api`
- `withGlobalTauri: true` works

**Option B: Keep loading from `http://localhost:{port}/dashboard`**
- React app served by Node.js server
- No Tauri IPC available (no clipboard, no file dialogs, no global shortcuts)
- Would need a JS-to-WS bridge for native features (defeats the purpose)
- Only viable if zero native features are needed

**Option A is clearly correct for the IDE vision.** The React app ships with Tauri. It connects to the server over WebSocket for session data, but it lives in Tauri's WebView with full IPC access for native features (clipboard, notifications, file dialogs, global shortcuts).

Update `tauri.conf.json`:
```json
{
  "build": {
    "frontendDist": "../dist",
    "beforeDevCommand": "cd ../.. && npm run dashboard:dev",
    "beforeBuildCommand": "cd ../.. && npm run dashboard:build"
  },
  "app": {
    "withGlobalTauri": true
  }
}
```

### 2.3 Window Configuration

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Chroxy",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 500,
        "visible": true,
        "center": true,
        "decorations": true,
        "titleBarStyle": "Overlay"
      }
    ]
  }
}
```

Notes:
- `minWidth`/`minHeight` prevent the sidebar from being crushed
- `titleBarStyle: "Overlay"` on macOS gives the native traffic-light buttons overlaid on the content, allowing the sidebar to extend to the top of the window (VS Code / Cursor style). On Windows/Linux this is ignored and standard decorations are used.
- `visible: true` because the single window should show immediately (it renders the React loading state)

### 2.4 Capabilities

**Current** (`capabilities/default.json`):
```json
{
  "identifier": "default",
  "windows": ["main", "dashboard"],
  "permissions": [
    "core:default",
    "shell:allow-open",
    "autostart:default",
    "notification:default"
  ]
}
```

**Recommended** (expanded for IDE features):
```json
{
  "identifier": "default",
  "description": "Default capabilities for Chroxy IDE",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-title",
    "core:window:allow-set-focus",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-close",
    "shell:allow-open",
    "autostart:default",
    "notification:default",
    "notification:allow-request-permission",
    "notification:allow-is-permission-granted",
    "clipboard-manager:allow-write-text",
    "clipboard-manager:allow-read-text",
    "dialog:allow-open",
    "dialog:allow-save",
    "dialog:allow-message",
    "dialog:allow-ask",
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister",
    "global-shortcut:allow-is-registered",
    "store:default"
  ]
}
```

Note: Only add permissions as features land. Start minimal, expand per phase.

---

## 3. Plugin Recommendations

### 3.1 Required Immediately (Phase 0)

#### `tauri-plugin-single-instance`

Prevents multiple app instances from running simultaneously. Critical for data integrity since `ServerManager` spawns a child Node.js process -- two instances would fight over the same port.

**Cargo.toml:**
```toml
tauri-plugin-single-instance = "2"
```

**lib.rs:**
```rust
use tauri_plugin_single_instance::init as single_instance_init;

tauri::Builder::default()
    .plugin(single_instance_init(|app, _args, _cwd| {
        // Focus the existing window when a second instance is attempted
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }))
    // ... other plugins
```

**Important:** Register this plugin FIRST (before other plugins) in the builder chain. Tauri v2 runs plugins in registration order, and single-instance must intercept early.

**Platform note:** On macOS, single-instance is the default OS behavior (LSUIElement apps only get one instance). The plugin is primarily needed for Windows and Linux.

### 3.2 Required for Phase 1 (React Migration)

#### `tauri-plugin-process`

Required by the updater plugin and useful for programmatic restart/exit:

```toml
tauri-plugin-process = "2"
```

```rust
.plugin(tauri_plugin_process::init())
```

### 3.3 Required for Phase 2-3 (IDE Features)

#### `tauri-plugin-clipboard-manager`

For "copy code block", "copy session ID", "copy tunnel URL" actions:

```toml
tauri-plugin-clipboard-manager = "2"
```

```rust
.plugin(tauri_plugin_clipboard_manager::init())
```

JavaScript usage:
```typescript
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager'
await writeText(codeBlock)
```

#### `tauri-plugin-dialog`

For "Add Repository" folder picker and future "Export session" save dialog:

```toml
tauri-plugin-dialog = "2"
```

```rust
.plugin(tauri_plugin_dialog::init())
```

JavaScript usage:
```typescript
import { open } from '@tauri-apps/plugin-dialog'
const selected = await open({
  directory: true,
  title: 'Select Repository',
  defaultPath: homeDir,
})
```

This is essential for Phase 2's "Add Repo manually" feature. Without the dialog plugin, folder selection would require a custom file browser or manual path entry.

#### `tauri-plugin-global-shortcut`

For keyboard shortcuts (Phase 3):

```toml
tauri-plugin-global-shortcut = "2"
```

```rust
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

.plugin(
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                // Emit to frontend for React to handle
                let _ = app.emit("shortcut-pressed", shortcut.into_string());
            }
        })
        .build()
)
```

**Gotcha:** Global shortcuts intercept system-wide, even when the app is not focused. For IDE-like shortcuts (Cmd+1-9 for tabs, Cmd+N new session), you likely want **app-scoped** shortcuts, not global ones. Tauri v2's accelerator menu items are better for this -- define them in the window menu, not via global shortcut plugin. Reserve global shortcuts for "focus Chroxy from anywhere" (e.g., Cmd+Shift+C).

Better approach for tab switching:
```rust
// In window/menu setup
let menu = MenuBuilder::new(app)
    .item(&MenuItem::with_id("tab-1", "Tab 1").accelerator("CmdOrCtrl+1"))
    .item(&MenuItem::with_id("tab-2", "Tab 2").accelerator("CmdOrCtrl+2"))
    // ...
    .build()?;
```

Then handle `on_menu_event` to emit tab-switch events to the frontend.

#### `tauri-plugin-store`

Consider replacing the custom `DesktopSettings` file I/O with `tauri-plugin-store`. Benefits:
- Automatic save on change
- Observable from JavaScript (React can react to setting changes)
- Thread-safe by design
- Handles the `~/.chroxy/` path resolution

```toml
tauri-plugin-store = "2"
```

However, since settings are currently managed in Rust and work correctly, this is optional. The custom implementation is fine -- the store plugin is more useful if the React frontend needs direct read/write access to settings without going through Tauri commands.

### 3.4 Required for Phase 3+ (Distribution)

#### `tauri-plugin-updater`

**This is conspicuously absent from the entire roadmap.** An IDE-class desktop app needs an update mechanism. Without it, users must manually download and replace the app for every update.

```toml
tauri-plugin-updater = { version = "2", target = 'cfg(any(target_os = "macos", windows, target_os = "linux"))' }
```

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

The updater requires:
1. **Signing keys**: `tauri signer generate -w ~/.tauri/chroxy.key`
2. **An update endpoint**: Static JSON on GitHub Releases, S3, or a dynamic server
3. **Build pipeline**: CI generates signed installers + `latest.json` manifest

**Recommended approach for Chroxy:** Use GitHub Releases with `tauri-action` in CI. The `latest.json` file is auto-generated and hosted alongside release assets. The app checks for updates on launch (configurable).

JavaScript (check for updates in React):
```typescript
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

const update = await check()
if (update?.available) {
  await update.downloadAndInstall()
  await relaunch()
}
```

**Add this to Phase 3 at minimum.** Shipping without auto-update is acceptable for early adopters but not for daily-driver status.

---

## 4. Build Pipeline Integration (Vite + Tauri)

### Current State

The `package.json` has:
```json
{
  "scripts": {
    "dev": "cargo tauri dev",
    "build": "cargo tauri build"
  }
}
```

There is no Vite configuration. The frontend is a static `dist/index.html`. The dashboard is served by the Node.js server (a separate 2000-line vanilla JS file in `packages/server/src/dashboard.js`).

### Target State

The React app replaces both:
1. The `dist/index.html` fallback (loading/QR screen)
2. The `dashboard.js` vanilla JS app (session interaction)

The React app is built with Vite and output to `packages/desktop/dist/`. Tauri bundles it via `frontendDist: "../dist"`.

### Recommended Setup

**File structure:**
```
packages/desktop/
  src/                    # React app source
    main.tsx
    App.tsx
    components/
      Sidebar.tsx
      TabBar.tsx
      TerminalPane.tsx
      WelcomeScreen.tsx
      LoadingScreen.tsx
      StatusBar.tsx
    hooks/
      useWebSocket.ts
      useServerStatus.ts
      useTauriEvents.ts
    store/
      sessions.ts
      repos.ts
      settings.ts
  dist/                   # Vite build output (gitignored)
  index.html              # Vite entry point
  vite.config.ts
  tsconfig.json
  package.json
  src-tauri/              # Rust (unchanged location)
```

**`vite.config.ts`:**
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port for dev
  server: {
    port: 1420,
    strictPort: true,
  },
  // Tauri expects the output in ../dist relative to tauri.conf.json
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Tauri uses Chromium on Windows and WebKit on macOS.
    // Target modern browsers only.
    target: ['es2021', 'chrome100', 'safari14'],
  },
  // Env variable prefix for Tauri
  envPrefix: ['VITE_', 'TAURI_'],
})
```

**`tauri.conf.json` build section:**
```json
{
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  }
}
```

**`package.json` scripts:**
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri:dev": "cargo tauri dev",
    "tauri:build": "cargo tauri build"
  }
}
```

**How it works:**
1. `cargo tauri dev` runs `beforeDevCommand` (starts Vite dev server on port 1420)
2. Tauri opens a WebView pointing to `http://localhost:1420` (the `devUrl`)
3. Vite provides HMR -- React changes hot-reload instantly in the Tauri window
4. `cargo tauri build` runs `beforeBuildCommand` (builds React app to `dist/`)
5. Tauri bundles `dist/` into the final binary

**Critical gotcha:** The React app running inside Tauri connects to the Node.js server via WebSocket at `ws://localhost:{port}`. The server port is dynamic (from config). The React app needs to discover this port. Two options:

1. **Tauri command** (recommended): Define a `#[tauri::command]` that returns the server port/token from `ServerManager` state. React calls `invoke('get_server_info')` on mount.

2. **Tauri event**: Rust emits a `server-ready` event with port/token when health check passes. React listens via `listen('server-ready', ...)`.

Option 1 is simpler for initial load. Option 2 is needed anyway for status updates. Use both.

**Example Tauri commands (add to `lib.rs`):**
```rust
#[tauri::command]
fn get_server_info(
    state: tauri::State<'_, Mutex<ServerManager>>,
) -> Result<serde_json::Value, String> {
    let mgr = lock_or_recover(&state);
    Ok(serde_json::json!({
        "port": mgr.port(),
        "token": mgr.token(),
        "status": mgr.status().label(),
        "tunnelMode": mgr.tunnel_mode(),
    }))
}

#[tauri::command]
fn start_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<ServerManager>>,
) -> Result<(), String> {
    // ... existing handle_start logic, refactored
    Ok(())
}

// Register in builder:
.invoke_handler(tauri::generate_handler![
    get_server_info,
    start_server,
    // ... more commands
])
```

### Relationship to the Node.js Server Dashboard

The vision document says "The React app is served by the Node.js server at `/dashboard`, same as today." This works for the mobile app (which needs a URL to load in a WebView), but for the desktop app, **the React app should be bundled with Tauri, not served by the Node server.**

Reasons:
1. Tauri IPC (`invoke()`, events, plugins) only works on pages served via `tauri://` protocol
2. The desktop app should work even before the server starts (show loading screen, settings)
3. Bundling eliminates the HTTP request and makes startup instant
4. The CSP is simpler and more secure for local assets

The mobile app can still load the same React app from the server's `/dashboard` endpoint. This means the React app code is shared, but the build output goes to two places:
- `packages/desktop/dist/` (for Tauri bundling)
- `packages/server/src/dashboard/dist/` (for HTTP serving to mobile/browser)

This is a single Vite build with two output targets, easily handled by a build script.

---

## 5. Platform-Specific Considerations

### 5.1 macOS

**Current strengths:**
- `MacosLauncher::LaunchAgent` for autostart is correct
- Tray icon with `iconAsTemplate: true` works for dark/light menu bar
- Signing and notarization config present in `tauri.conf.json`

**Recommendations:**
- **`titleBarStyle: "Overlay"`**: Gives the IDE a native feel with traffic lights overlaid on the sidebar. The React app needs ~28px padding-top on the left side to avoid overlapping the buttons.
- **App activation**: macOS apps can be "activated" (brought to front) without any visible windows. The current close-to-hide behavior on the dashboard window is correct but should apply to the main window too.
- **Dock icon**: Consider hiding the dock icon when minimized to tray (`LSUIElement` in Info.plist). Tauri v2 doesn't expose this directly; you'd need to set it in the bundle config or use a custom plugin. Most IDE apps keep the dock icon visible.

### 5.2 Windows

**Current issues:**
- `libc::kill(child.id() as i32, libc::SIGTERM)` in `server.rs` -- **this will not compile on Windows.** The `libc` crate's `kill` and `SIGTERM` are Unix-only. You need `#[cfg(unix)]` / `#[cfg(windows)]` guards.

**Fix:**
```rust
pub fn stop(&mut self) {
    *lock_or_recover(&self.health_running) = false;

    if let Some(ref mut child) = self.child {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => {}
            Ok(None) => {
                #[cfg(unix)]
                {
                    unsafe {
                        libc::kill(child.id() as i32, libc::SIGTERM);
                    }
                }
                #[cfg(windows)]
                {
                    // On Windows, there is no SIGTERM equivalent for child processes.
                    // Use kill() which sends TerminateProcess.
                    let _ = child.kill();
                }

                let start = Instant::now();
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) => {
                            if start.elapsed() > Duration::from_secs(5) {
                                let _ = child.kill();
                                let _ = child.wait();
                                break;
                            }
                            thread::sleep(Duration::from_millis(100));
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    }

    self.child = None;
    *lock_or_recover(&self.status) = ServerStatus::Stopped;
}
```

**Other Windows concerns:**
- `which` command does not exist on Windows. Use `where` instead, or use the `which` Rust crate.
- Homebrew paths (`/opt/homebrew/...`) do not exist on Windows. Node.js resolution needs Windows-specific paths (Program Files, nvm-windows, fnm).
- WebView2 is required on Windows. It ships with Windows 11 but may need the evergreen bootstrapper for Windows 10.
- The updater plugin on Windows will auto-exit the app during install (Windows installer limitation) -- users should be warned.

### 5.3 Linux

**Considerations:**
- WebKitGTK is required. On Ubuntu: `sudo apt install libwebkit2gtk-4.1-dev`
- Tray icon support varies by desktop environment. GNOME removed system tray; users need extensions like `AppIndicator`. Tauri v2 uses `libappindicator3` on Linux.
- Consider providing both `.deb` and `.AppImage` formats.
- `#[cfg(target_os = "linux")]` may be needed for tray behavior differences.

### 5.4 Cross-Platform Node.js Resolution

The `node.rs` module is macOS-specific (Homebrew paths, nvm paths). For cross-platform support:

```rust
pub fn resolve_node22() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/opt/node@22/bin/node"));
        candidates.push(PathBuf::from("/usr/local/opt/node@22/bin/node"));
    }

    #[cfg(target_os = "windows")]
    {
        // nvm-windows
        if let Ok(nvm_home) = std::env::var("NVM_HOME") {
            let nvm_dir = PathBuf::from(&nvm_home);
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let name = entry.file_name();
                    if name.to_string_lossy().starts_with("v22.") {
                        candidates.push(entry.path().join("node.exe"));
                    }
                }
            }
        }
        // Standard install
        candidates.push(PathBuf::from("C:\\Program Files\\nodejs\\node.exe"));
    }

    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr/local/bin/node"));
        candidates.push(PathBuf::from("/usr/bin/node"));
    }

    // nvm (Unix)
    #[cfg(unix)]
    if let Some(home) = dirs::home_dir() {
        // ... existing nvm logic
    }

    // ... rest of resolution
}
```

Also, `check_cloudflared()` uses `which` which is Unix-only. Use `which` crate or conditional compilation:

```rust
pub fn check_cloudflared() -> bool {
    #[cfg(unix)]
    let cmd = "which";
    #[cfg(windows)]
    let cmd = "where";

    Command::new(cmd)
        .arg("cloudflared")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
```

---

## 6. Performance: Multiple xterm.js Instances

### The Challenge

The IDE vision has multiple terminal tabs, each running an xterm.js instance. All instances live in the same WebView. This is a known performance concern.

### Analysis

- **xterm.js with WebGL renderer**: Each instance creates a WebGL context. Most browsers/WebViews limit the number of active WebGL contexts (typically 8-16). With 5 concurrent sessions, this is fine. Beyond that, contexts may be lost.
- **xterm.js with canvas renderer**: Falls back to Canvas2D. No context limit, but slower rendering for large output volumes.
- **Memory**: Each xterm.js instance holds a scrollback buffer. Default 1000 lines per instance. With 5 sessions, this is ~5000 lines in memory -- negligible.
- **DOM nodes**: Each terminal creates a complex DOM tree. Inactive tabs should be hidden (`display: none`) but kept in DOM for instant switching. Do NOT unmount/remount -- that destroys scrollback.

### Recommendations

1. **Use the WebGL renderer** (`@xterm/addon-webgl`) for the active tab only. Use canvas or no renderer for background tabs.
2. **Lazy-initialize terminals**: Only create the xterm.js instance when a tab is first opened, not for all sessions upfront.
3. **Cap concurrent terminals**: The server already limits to 5 concurrent sessions. This is a reasonable cap for xterm.js instances too.
4. **Virtualize scrollback**: For very long sessions, consider the `@xterm/addon-serialize` to serialize/restore terminal state, allowing background terminals to release memory.
5. **Monitor WebView memory**: Tauri v2 does not expose WebView memory metrics directly, but Chrome DevTools (available in dev builds) can profile memory per terminal.

### GPU Acceleration

- **macOS (WebKit)**: GPU acceleration is on by default for WebGL content. No Tauri configuration needed.
- **Windows (WebView2/Chromium)**: GPU acceleration is on by default. Can be forced with `--enable-gpu-rasterization` but this is rarely needed.
- **Linux (WebKitGTK)**: GPU acceleration depends on the graphics driver. Mesa/Vulkan users are usually fine. Some older systems may need `WEBKIT_DISABLE_COMPOSITING_MODE=0`.

No Tauri-level GPU configuration exists. It is handled by the underlying WebView engine.

---

## 7. Tauri v2 Features to Leverage

### 7.1 Event System

Tauri v2's event system (`app.emit()` / `listen()`) is the right bridge between Rust server management and React UI.

**Pattern:**
```rust
// Rust: emit server status changes
app.emit("server-status", serde_json::json!({
    "status": "running",
    "port": 8765,
    "tunnel_url": "https://abc.trycloudflare.com"
})).ok();
```

```typescript
// React: listen for status changes
import { listen } from '@tauri-apps/api/event'

useEffect(() => {
  const unlisten = listen('server-status', (event) => {
    setServerStatus(event.payload)
  })
  return () => { unlisten.then(fn => fn()) }
}, [])
```

Use events for:
- Server status changes (starting/running/error/stopped)
- Tunnel URL availability
- Health check results
- Notification forwarding (permission requests from background sessions)

### 7.2 Menu API

Tauri v2's menu API supports:
- **Application menu** (macOS menu bar, Windows/Linux alt-menu): Add standard Edit menu (undo/redo/cut/copy/paste) for free. Terminal apps need paste support.
- **Accelerators**: Keyboard shortcuts bound to menu items. Better than global shortcuts for in-app actions.
- **Dynamic menus**: Update menu items at runtime (enable/disable, change text, add/remove items).

The current tray menu is well-implemented. For the IDE, also create an application menu:

```rust
let edit_menu = SubmenuBuilder::new(app, "Edit")
    .undo()
    .redo()
    .separator()
    .cut()
    .copy()
    .paste()
    .select_all()
    .build()?;

let session_menu = SubmenuBuilder::new(app, "Session")
    .item(&MenuItem::with_id("new-session", "New Session").accelerator("CmdOrCtrl+N"))
    .item(&MenuItem::with_id("close-tab", "Close Tab").accelerator("CmdOrCtrl+W"))
    .separator()
    .item(&MenuItem::with_id("tab-1", "Tab 1").accelerator("CmdOrCtrl+1"))
    // ... up to 9
    .build()?;
```

### 7.3 Tray Updates

The current tray implementation is good. For the IDE, consider updating the tray tooltip dynamically to show active session count:

```rust
if let Some(tray) = app.tray_by_id("main") {
    let _ = tray.set_tooltip(Some(&format!("Chroxy - {} active sessions", count)));
}
```

### 7.4 IPC Channel (New in v2)

Tauri v2 introduced `tauri::ipc::Channel` for streaming data from Rust to JavaScript. This is more efficient than repeated `emit()` calls for high-frequency updates.

Potential use: streaming server logs from the Rust `log_buffer` to a log panel in the React UI:

```rust
#[tauri::command]
fn stream_logs(channel: tauri::ipc::Channel<String>) -> Result<(), String> {
    // Send log lines through the channel
    channel.send("log line".to_string()).ok();
    Ok(())
}
```

This is a Phase 4 feature but worth knowing about.

---

## 8. Tauri Gotchas -- Things That Will Trip Up Implementation

### 8.1 External URL vs. Local Assets

**The #1 gotcha.** If the WebView loads `http://localhost:{port}/dashboard`, Tauri IPC does not work. The React app MUST be served from Tauri's built-in asset server (`tauri://localhost` or the `frontendDist` path) for `invoke()`, `emit()`, and plugin APIs to function. See Section 2.2 above.

### 8.2 CSP Blocks WebSocket on Production Builds

Tauri injects CSP headers at compile time. If the CSP does not include `ws://localhost:*` in `connect-src`, the WebSocket connection to the Node.js server will be silently blocked in production builds (it works in dev because `dev_csp` may be more permissive). Test the production build, not just dev.

### 8.3 Window Close vs. Hide

The current implementation hides the dashboard on close instead of destroying it. This is correct for a tray app. But the event handler is registered via `.on_window_event()` on the window builder, and there is a subtle bug: if the window IS destroyed (e.g., by Tauri internally), the event handler holds a stale `AppHandle` clone that may panic.

Use the builder-level `on_window_event` on `tauri::Builder` (which the code already does for resize/move) rather than per-window event handlers. Or use the window-level handler but guard against the window being gone:

```rust
win.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        // Use try_state to avoid panic if app is shutting down
        if let Some(w) = app_handle.get_webview_window(DASHBOARD_LABEL) {
            let _ = w.hide();
        }
    }
});
```

This code is already safe (uses `get_webview_window` which returns `Option`), but be aware of the pattern.

### 8.4 Mutex Poisoning Recovery

The `lock_or_recover` helper is a good pattern for tray apps where panicking is worse than proceeding with potentially stale state. However, for the IDE, consider whether recovering from a poisoned mutex is safe. If a thread panicked while mutating `ServerManager`, the internal state may be inconsistent. At minimum, log when recovery happens:

```rust
pub(crate) fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| {
        eprintln!("[warn] Mutex was poisoned, recovering. A thread panicked.");
        e.into_inner()
    })
}
```

For production, consider using `parking_lot::Mutex` which never poisons and is faster.

### 8.5 `cargo tauri dev` Hot Reload

During development, `cargo tauri dev` watches the Rust source and recompiles on change, which restarts the entire app (including the Node.js server child process). This is slow. The Vite dev server provides instant hot reload for React changes without restarting Rust.

**Optimization:** Only change Rust code when modifying Tauri commands, server management, or plugin setup. All UI work happens in React with Vite HMR. This means most development iterations are sub-second.

### 8.6 Bundle Size

Tauri binaries are small (~5-10MB) compared to Electron (~100MB+). However, the Node.js server is bundled separately (it runs as a child process, not inside the Tauri binary). The total install includes:
- Tauri binary (~8MB)
- Node.js 22 runtime (not bundled -- expected to be pre-installed)
- `packages/server/` source (small, ~200KB)

The dependency on an external Node.js installation is a UX friction point. Consider:
- Bundling a Node.js binary in the Tauri app's resources (`tauri.conf.json > bundle > resources`)
- Or documenting the requirement clearly in the install flow
- Or using `pkg` / `bun` to compile the server to a standalone binary (future consideration)

### 8.7 macOS Code Signing for Child Processes

On macOS with Gatekeeper, unsigned child processes spawned by a signed app may be blocked. If the Tauri app is signed and notarized but spawns an unsigned `node` binary, macOS may quarantine it.

**Mitigation:** The Node.js binary installed via Homebrew/nvm is typically not quarantined. But if you bundle Node.js in the app resources, it needs to be ad-hoc signed or included in the app's signature.

### 8.8 Tauri v2 Permissions Model

Tauri v2 replaced v1's `allowlist` with a fine-grained ACL system. Every Tauri command and plugin action requires explicit permission in `capabilities/*.json`. If you add a new `#[tauri::command]` and forget to add its permission, the call will silently fail (returns an error, not a crash). This is a common source of "it works in dev but not in production" bugs.

**Best practice:** After adding any new command, immediately add its permission to the capability file and test in a release build.

### 8.9 WebView Dev Tools

In development, enable WebView dev tools for debugging:

```json
{
  "app": {
    "security": {
      "devtools": true
    }
  }
}
```

This is already available in debug builds by default but explicitly enabling it ensures it works. Right-click > Inspect Element will open Chrome DevTools (Windows) or Web Inspector (macOS).

### 8.10 File Permissions on Settings

The vision document's Phase 0 lists "Fix `config.json` permissions (0o600)" and "Fix `settings.json` permissions (0o600)." The current `settings.rs` uses `std::fs::write()` which creates files with default permissions (0o644 on Unix). Fix:

```rust
#[cfg(unix)]
{
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
}
```

Apply this in both `DesktopSettings::save()` and `setup::ensure_config()`.

---

## 9. Summary: Plugin Dependency Matrix by Phase

| Phase | Plugin | Cargo Feature | Purpose |
|-------|--------|--------------|---------|
| 0 | `tauri-plugin-single-instance` | - | Prevent dual-launch |
| 0 | `tauri-plugin-notification` | - | Already present |
| 0 | `tauri-plugin-autostart` | - | Already present |
| 0 | `tauri-plugin-shell` | - | Already present |
| 1 | `tauri-plugin-process` | - | App restart/exit for updater |
| 2 | `tauri-plugin-dialog` | - | Folder picker for Add Repo |
| 2 | `tauri-plugin-clipboard-manager` | - | Copy code blocks |
| 3 | `tauri-plugin-global-shortcut` | - | Focus app from anywhere |
| 3 | `tauri-plugin-updater` | - | Auto-update delivery |
| 4 | `tauri-plugin-store` | - | Optional: replace custom settings |

---

## 10. Final Recommendations (Priority Order)

1. **Add `tauri-plugin-single-instance` now.** This is a 30-minute task that prevents a class of bugs.

2. **Plan the Vite + Tauri build pipeline before starting the React migration.** Getting this wrong means rework. Follow the pattern in Section 4.

3. **Switch to single-window architecture.** Delete the two-window (fallback + dashboard) pattern. One window, React handles all states.

4. **Serve the React app from Tauri, not from the Node server.** This unlocks all Tauri IPC features. The same React code can also be served by the Node server for mobile/browser access.

5. **Define `#[tauri::command]` functions for `get_server_info`, `start_server`, `stop_server`, `restart_server`.** This replaces the tray-menu-only control flow with an IPC bridge the React app can call.

6. **Fix cross-platform compilation issues** (`libc::kill`, `which` command, Homebrew paths) before any Windows/Linux testing.

7. **Add auto-update (`tauri-plugin-updater`) to the Phase 3 roadmap.** An IDE without auto-update is a non-starter for daily-driver usage.

8. **Harden the CSP** with the object-format configuration. Tighten `default-src`, add `frame-src: 'none'`, separate `dev_csp`.

9. **Replace `parking_lot::Mutex` for `std::sync::Mutex`** to avoid poisoning complexity and gain performance.

10. **Set file permissions to 0o600** on `config.json` and `desktop-settings.json` on Unix.

---

*This audit assesses the Tauri implementation plan against the CLI Agent IDE vision. The foundation is sound. The path from tray wrapper to IDE shell requires deliberate architectural choices in window management, build pipeline, and plugin selection -- all of which are tractable within Tauri v2's capabilities.*
