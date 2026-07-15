// Modules are `pub` (not private) so the `tests/command_integration.rs`
// integration suite can exercise their public functions directly without a
// running Tauri app. The crate is an internal binary support library — no
// external consumer depends on this surface, so exposing it for testing
// carries no API stability cost.
pub mod config;
pub mod discovery;
pub mod node;
pub mod platform;
pub mod qrcode;
pub mod server;
pub mod settings;
pub mod setup;
#[cfg(target_os = "macos")]
pub mod speech;
pub mod window;

use server::{ServerManager, ServerStatus};
use settings::DesktopSettings;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

/// Lock a Mutex, recovering from poisoning instead of panicking.
/// `pub` so integration tests can drive the same lock-recovery semantics
/// as the production command bodies (see `tests/command_integration.rs`).
pub fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Per-platform "how to install cloudflared" hint for user-facing errors —
/// Windows → winget, macOS → Homebrew, Linux → the Cloudflare package repo
/// (parity with the JS `cloudflaredInstallHint`, #6649).
fn cloudflared_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "brew install cloudflared"
    } else if cfg!(target_os = "windows") {
        "winget install Cloudflare.cloudflared"
    } else {
        "see https://pkg.cloudflare.com/"
    }
}

use tauri::{
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder,
    },
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
#[cfg(desktop)]
use tauri_plugin_single_instance::init as single_instance_init;

/// Tracks whether this is a first-run (config was just created).
static IS_FIRST_RUN: AtomicBool = AtomicBool::new(false);

/// Menu item handles so we can enable/disable them from anywhere.
struct TrayMenuItems {
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    dashboard: MenuItem<tauri::Wry>,
    console: MenuItem<tauri::Wry>,
    show_qr: MenuItem<tauri::Wry>,
    check_updates: MenuItem<tauri::Wry>,
    auto_start_login: CheckMenuItem<tauri::Wry>,
    auto_start_server: CheckMenuItem<tauri::Wry>,
    tunnel_quick: CheckMenuItem<tauri::Wry>,
    tunnel_named: CheckMenuItem<tauri::Wry>,
    tunnel_none: CheckMenuItem<tauri::Wry>,
}

/// #4942 — App-menu (macOS menu bar) item handles. Kept separate from
/// `TrayMenuItems` so the two surfaces stay decoupled; only the radio
/// items (tunnel mode) and the server-state-gated entries (Shell items)
/// need cross-menu state sync, and we touch both menus together when a
/// tunnel-mode change OR a server-status change fans out.
#[cfg(target_os = "macos")]
struct AppMenuItems {
    /// Shell submenu entries. Enabled state mirrors the tray menu's
    /// Start/Stop/Restart/Console gating (see `update_menu_state`).
    shell_start: MenuItem<tauri::Wry>,
    shell_stop: MenuItem<tauri::Wry>,
    shell_restart: MenuItem<tauri::Wry>,
    shell_open_console: MenuItem<tauri::Wry>,
    /// Tunnel radios — kept in lockstep with the tray's tunnel radios
    /// via `handle_set_tunnel_mode` so toggling from either surface
    /// updates the other.
    tunnel_quick: CheckMenuItem<tauri::Wry>,
    tunnel_named: CheckMenuItem<tauri::Wry>,
    tunnel_none: CheckMenuItem<tauri::Wry>,
}

// ── Tauri IPC commands ──────────────────────────────────────────────

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
        "isRunning": mgr.is_running(),
    }))
}

#[tauri::command]
fn start_server(app: tauri::AppHandle) {
    handle_start(&app);
}

/// #5281 ③ — browse the LAN for chroxy daemons advertising `_chroxy._tcp` and
/// return them for the dashboard ServerPicker's "Discover on LAN" list. Runs
/// the blocking mDNS browse off the UI thread; an mDNS failure surfaces as an
/// error string (the picker falls back to manual entry).
#[tauri::command]
async fn discover_lan_servers() -> Result<Vec<discovery::DiscoveredServer>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        discovery::browse_lan(std::time::Duration::from_millis(2000))
    })
    .await
    .map_err(|e| format!("discovery task failed: {e}"))?
}

#[tauri::command]
fn stop_server(app: tauri::AppHandle) {
    handle_stop(&app);
}

#[tauri::command]
fn restart_server(app: tauri::AppHandle) {
    handle_restart(&app);
}

#[tauri::command]
fn get_server_logs(state: tauri::State<'_, Mutex<ServerManager>>) -> Vec<String> {
    let mgr = lock_or_recover(&state);
    mgr.get_logs()
}

/// Return the last `limit` buffered server log lines (stdout + stderr).
/// Used by the loading page / error UI to let the user inspect what the
/// server printed when startup fails (issue #2835 sub-fix C).
#[tauri::command]
fn get_startup_logs(
    state: tauri::State<'_, Mutex<ServerManager>>,
    limit: Option<usize>,
) -> Vec<String> {
    let mgr = lock_or_recover(&state);
    let all = mgr.get_logs();
    let n = limit.unwrap_or(30).min(all.len());
    let start = all.len().saturating_sub(n);
    all[start..].to_vec()
}

#[tauri::command]
fn get_qr_code_svg(
    state: tauri::State<'_, Mutex<ServerManager>>,
) -> Result<serde_json::Value, String> {
    let mgr = lock_or_recover(&state);
    if !mgr.is_running() {
        return Err("Server is not running".to_string());
    }
    drop(mgr);

    let (hostname, token) = qrcode::get_connection_info()?;
    let url = qrcode::build_connection_url(&hostname, &token);
    let svg = qrcode::generate_qr_svg(&url)?;
    Ok(serde_json::json!({
        "svg": svg,
        "url": url,
    }))
}

#[tauri::command]
fn check_dependencies() -> serde_json::Value {
    // Check Node 22
    let node_result = node::resolve_node22();
    let (node_found, node_path, node_version) = match &node_result {
        Ok(path) => {
            let version = std::process::Command::new(path)
                .arg("--version")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            (true, Some(path.display().to_string()), version)
        }
        Err(_) => (false, None, None),
    };

    // Check cloudflared
    let cloudflared_found = server::ServerManager::check_cloudflared();

    // Check claude CLI
    #[cfg(unix)]
    let which_cmd = "which";
    #[cfg(windows)]
    let which_cmd = "where";
    let claude_result = std::process::Command::new(which_cmd).arg("claude").output();
    let (claude_found, claude_version) = match claude_result {
        Ok(output) if output.status.success() => {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let version = std::process::Command::new(&path)
                .arg("--version")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            (true, version)
        }
        _ => (false, None),
    };

    serde_json::json!({
        "node22": {
            "found": node_found,
            "path": node_path,
            "version": node_version,
        },
        "cloudflared": {
            "found": cloudflared_found,
        },
        "claude": {
            "found": claude_found,
            "version": claude_version,
        },
    })
}

#[tauri::command]
fn get_setup_state(
    mgr_state: tauri::State<'_, Mutex<server::ServerManager>>,
    settings_state: tauri::State<'_, Mutex<DesktopSettings>>,
) -> serde_json::Value {
    let config = config::load_config();
    let settings = lock_or_recover(&settings_state);
    let mgr = lock_or_recover(&mgr_state);
    serde_json::json!({
        "isFirstRun": IS_FIRST_RUN.load(std::sync::atomic::Ordering::Relaxed),
        "port": config.port,
        "tunnelMode": settings.tunnel_mode,
        "isRunning": mgr.is_running(),
    })
}

#[tauri::command]
fn save_setup_config(app: tauri::AppHandle, port: u16, tunnel_mode: String) -> Result<(), String> {
    // Update settings
    if let Some(settings_state) = app.try_state::<Mutex<DesktopSettings>>() {
        let mut settings = lock_or_recover(&settings_state);
        settings.tunnel_mode = tunnel_mode.clone();
        settings
            .save()
            .map_err(|e| format!("Failed to save settings: {}", e))?;
    }

    // Update port in config.json
    if let Some(path) = config::config_path() {
        let contents = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read config {}: {}", path.display(), e))?;
        let mut cfg: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse config {}: {}", path.display(), e))?;
        cfg["port"] = serde_json::json!(port);
        let json_str = serde_json::to_string_pretty(&cfg)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&path, json_str)
            .map_err(|e| format!("Failed to write config {}: {}", path.display(), e))?;
    }

    // Apply tunnel mode to server manager
    if let Some(mgr_state) = app.try_state::<Mutex<server::ServerManager>>() {
        let mut mgr = lock_or_recover(&mgr_state);
        mgr.set_tunnel_mode(&tunnel_mode);
    }

    // Clear first-run flag
    IS_FIRST_RUN.store(false, std::sync::atomic::Ordering::Relaxed);

    Ok(())
}

#[tauri::command]
fn get_tunnel_mode(settings_state: tauri::State<'_, Mutex<DesktopSettings>>) -> String {
    let settings = lock_or_recover(&settings_state);
    match settings.tunnel_mode.as_str() {
        "none" | "quick" | "named" => settings.tunnel_mode.clone(),
        _ => "none".to_string(),
    }
}

#[tauri::command]
fn set_tunnel_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    // Validate mode
    if !["none", "quick", "named"].contains(&mode.as_str()) {
        return Err(format!(
            "Invalid tunnel mode: {}. Must be none, quick, or named.",
            mode
        ));
    }

    // Validate cloudflared for tunnel modes
    if mode != "none" && !ServerManager::check_cloudflared() {
        return Err(format!("cloudflared not found. Install with: {}", cloudflared_install_hint()));
    }

    // Update settings
    if let Some(settings_state) = app.try_state::<Mutex<DesktopSettings>>() {
        let mut settings = lock_or_recover(&settings_state);
        settings.tunnel_mode = mode.clone();
        settings
            .save()
            .map_err(|e| format!("Failed to save settings: {}", e))?;
    }

    // Update ServerManager so next restart uses the new mode
    if let Some(mgr_state) = app.try_state::<Mutex<ServerManager>>() {
        let mut mgr = lock_or_recover(&mgr_state);
        mgr.set_tunnel_mode(&mode);
    }

    // Update tray menu checkboxes
    if let Some(items) = app.try_state::<Mutex<TrayMenuItems>>() {
        let items = lock_or_recover(&items);
        let _ = items.tunnel_quick.set_checked(mode == "quick");
        let _ = items.tunnel_named.set_checked(mode == "named");
        let _ = items.tunnel_none.set_checked(mode == "none");
    }
    // #4942 — also sync the macOS app-menu radios so a dashboard-driven
    // tunnel-mode change keeps both menu surfaces consistent.
    #[cfg(target_os = "macos")]
    if let Some(items) = app.try_state::<Mutex<AppMenuItems>>() {
        let items = lock_or_recover(&items);
        let _ = items.tunnel_quick.set_checked(mode == "quick");
        let _ = items.tunnel_named.set_checked(mode == "named");
        let _ = items.tunnel_none.set_checked(mode == "none");
    }

    Ok(())
}

/// #6184 (Control Room v2 phase 2 / #5964) — set the macOS dock-tile badge label.
/// `None` clears it. Must run on the main thread (the command below dispatches via
/// `run_on_main_thread`) — AppKit UI calls off the main thread are undefined
/// behaviour. Mirrors the existing cocoa/objc usage (the NSApp window-menu setup).
#[cfg(target_os = "macos")]
fn set_dock_badge(label: Option<String>) {
    use cocoa::appkit::NSApp;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{msg_send, sel, sel_impl};
    unsafe {
        let ns_app: id = NSApp();
        let dock_tile: id = msg_send![ns_app, dockTile];
        match label {
            Some(text) => {
                // alloc/init returns a +1-retained NSString (NOT autoreleased).
                // setBadgeLabel: keeps its own copy, so release our reference
                // afterwards or it leaks one NSString per badge update.
                let ns_str: id = NSString::alloc(nil).init_str(&text);
                let _: () = msg_send![dock_tile, setBadgeLabel: ns_str];
                let _: () = msg_send![ns_str, release];
            }
            None => {
                let _: () = msg_send![dock_tile, setBadgeLabel: nil];
            }
        }
    }
}

/// #6184 — reflect the cross-session "needs me" count on the dock icon: a red
/// badge with `blocked + failed` (cleared at zero). The dashboard computes the
/// count from the shared `selectCrossSessionActivity` rollup (#6182) and invokes
/// this whenever it changes. macOS only for now (Tauri v2's tray icon exposes no
/// badge API; the dock tile is the native "count" surface); a no-op elsewhere.
#[tauri::command]
fn update_tray_badge(app: tauri::AppHandle, blocked: u32, failed: u32) -> Result<(), String> {
    let count = blocked.saturating_add(failed);
    #[cfg(target_os = "macos")]
    {
        let label = if count == 0 { None } else { Some(count.to_string()) };
        // AppKit must be touched on the main thread.
        app.run_on_main_thread(move || set_dock_badge(label))
            .map_err(|e| format!("Failed to update dock badge: {}", e))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // No dock/tray badge surface on this platform yet — accept + ignore so the
        // dashboard caller stays platform-agnostic.
        let _ = (&app, count);
    }
    Ok(())
}

/// #5356 — current "expose on LAN" setting. False (loopback-only) is the
/// default and the safe posture for the control socket.
#[tauri::command]
fn get_expose_on_lan(settings_state: tauri::State<'_, Mutex<DesktopSettings>>) -> bool {
    lock_or_recover(&settings_state).expose_on_lan
}

/// #5356 — toggle whether the embedded server binds all interfaces (LAN) or
/// loopback-only. Persisted; applied on the next server start/restart (the bind
/// address is fixed at spawn, so the dashboard prompts for a restart).
#[tauri::command]
fn set_expose_on_lan(app: tauri::AppHandle, expose: bool) -> Result<(), String> {
    if let Some(settings_state) = app.try_state::<Mutex<DesktopSettings>>() {
        let mut settings = lock_or_recover(&settings_state);
        settings.expose_on_lan = expose;
        settings
            .save()
            .map_err(|e| format!("Failed to save settings: {}", e))?;
    }

    // Update ServerManager so the next start/restart picks up the new bind host.
    if let Some(mgr_state) = app.try_state::<Mutex<ServerManager>>() {
        let mut mgr = lock_or_recover(&mgr_state);
        mgr.set_expose_on_lan(expose);
    }

    Ok(())
}

/// #5294 — read the configured summon hotkey accelerator. Returns `None` when
/// unset or blank (i.e. disabled), matching `effective_summon_hotkey()`.
#[tauri::command]
fn get_summon_hotkey(settings_state: tauri::State<'_, Mutex<DesktopSettings>>) -> Option<String> {
    lock_or_recover(&settings_state).effective_summon_hotkey()
}

/// #5294 — set (or clear) the global summon hotkey at runtime and re-register
/// it immediately, so the change takes effect with no restart. Passing `None`
/// or a blank/whitespace string clears the hotkey. A malformed or
/// OS-conflicting accelerator is returned as an error (with the previous
/// binding left intact) instead of being silently swallowed.
#[tauri::command]
fn set_summon_hotkey(app: tauri::AppHandle, accelerator: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // Normalize blank/whitespace to None (disabled), mirroring
    // effective_summon_hotkey()'s treatment so the two never disagree.
    let new_accel = accelerator
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let settings_state = app
        .try_state::<Mutex<DesktopSettings>>()
        .ok_or("Settings state unavailable")?;

    // The accelerator currently registered (what we must unregister first).
    let old_accel = lock_or_recover(&settings_state).effective_summon_hotkey();

    // Unregister the previously-registered accelerator, if any. Best-effort:
    // if it was never actually registered (e.g. it had failed at startup), the
    // unregister error is irrelevant to the new registration.
    if let Some(ref old) = old_accel {
        let _ = app.global_shortcut().unregister(old.as_str());
    }

    // Register the new accelerator. On failure, restore the old binding so a
    // typo doesn't leave the user with no hotkey, and surface the error.
    if let Some(ref acc) = new_accel {
        if let Err(e) = register_summon_hotkey(&app, acc) {
            if let Some(ref old) = old_accel {
                let _ = register_summon_hotkey(&app, old);
            }
            return Err(format!("{} — the previous hotkey is unchanged.", e));
        }
    }

    // Persist only after a successful (un)register. If the write fails, roll
    // back BOTH the in-memory setting and the registration so disk, memory, and
    // the live shortcut stay consistent — otherwise the new hotkey would work
    // this session but the next restart would load the old, persisted value
    // (and register that), a silent drift Copilot flagged on #5294.
    {
        let mut settings = lock_or_recover(&settings_state);
        settings.summon_hotkey = new_accel.clone();
        if let Err(e) = settings.save() {
            settings.summon_hotkey = old_accel.clone();
            drop(settings);
            if let Some(ref acc) = new_accel {
                let _ = app.global_shortcut().unregister(acc.as_str());
            }
            if let Some(ref old) = old_accel {
                let _ = register_summon_hotkey(&app, old);
            }
            return Err(format!(
                "Failed to save settings: {} — the previous hotkey is unchanged.",
                e
            ));
        }
    }

    Ok(())
}

/// Read `allowAutoPermissionMode` from `~/.chroxy/config.json`.
/// Returns `false` if the config file doesn't exist, is empty/whitespace-only,
/// or the key is missing. Surfaces parse errors so the UI can show a meaningful
/// message instead of silently presenting the wrong toggle state.
///
/// Empty/whitespace-only files are treated as `{}` to mirror the writer's
/// behavior (`set_allow_auto_permission_mode_at`) — otherwise a truncated
/// config (e.g. interrupted previous write) would surface as a parse error.
#[tauri::command]
fn get_allow_auto_permission_mode() -> Result<bool, String> {
    let path = config::config_path().ok_or("Could not determine home directory")?;
    if !path.exists() {
        return Ok(false);
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config {}: {}", path.display(), e))?;
    if contents.trim().is_empty() {
        return Ok(false);
    }
    let cfg: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse config {}: {}", path.display(), e))?;
    Ok(cfg
        .get("allowAutoPermissionMode")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// Write `allowAutoPermissionMode` to `~/.chroxy/config.json`, preserving
/// other keys and 0o600 permissions. Creates the file (and parent dir) if
/// missing. The server picks up the new value on next restart.
#[tauri::command]
fn set_allow_auto_permission_mode(value: bool) -> Result<(), String> {
    let path = config::config_path().ok_or("Could not determine home directory")?;
    set_allow_auto_permission_mode_at(&path, value)
}

/// Helper that does the actual file read/merge/write, parameterised on path
/// so unit tests can target a temp file instead of `~/.chroxy/config.json`.
/// `pub` so the integration test suite can drive it directly without a
/// running Tauri app (see `tests/command_integration.rs`).
pub fn set_allow_auto_permission_mode_at(
    path: &std::path::Path,
    value: bool,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir {}: {}", parent.display(), e))?;
    }

    let mut cfg: serde_json::Value = if path.exists() {
        let contents = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read config {}: {}", path.display(), e))?;
        if contents.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&contents)
                .map_err(|e| format!("Failed to parse config {}: {}", path.display(), e))?
        }
    } else {
        serde_json::json!({})
    };

    if !cfg.is_object() {
        return Err(format!(
            "Config file {} is not a JSON object",
            path.display()
        ));
    }

    cfg["allowAutoPermissionMode"] = serde_json::Value::Bool(value);

    let json_str = serde_json::to_string_pretty(&cfg)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    platform::write_restricted(path, &json_str)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn pick_directory(
    app: tauri::AppHandle,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(ref path) = default_path {
        builder = builder.set_directory(path);
    }
    builder.pick_folder(move |folder| {
        let _ = tx.send(folder.map(|p| p.to_string()));
    });
    let result = rx.await.map_err(|e| e.to_string())?;
    Ok(result)
}

/// Tile the main window to left/right half or maximize.
/// Works around WKWebView consuming keyboard events before macOS WindowServer
/// can process them as system tiling shortcuts (fn+ctrl+arrow).
#[tauri::command]
fn tile_window(window: tauri::Window, direction: String) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No monitor found")?;
    let screen = monitor.size();
    let pos = monitor.position();
    let scale = monitor.scale_factor();

    // Account for menu bar (~25 logical pixels on macOS)
    let menu_bar_height = (25.0 * scale) as i32;
    let usable_height = screen.height as i32 - menu_bar_height;
    let half_width = screen.width / 2;

    match direction.as_str() {
        "left" => {
            window
                .set_position(tauri::PhysicalPosition::new(pos.x, pos.y + menu_bar_height))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::PhysicalSize::new(half_width, usable_height as u32))
                .map_err(|e| e.to_string())?;
        }
        "right" => {
            window
                .set_position(tauri::PhysicalPosition::new(
                    pos.x + half_width as i32,
                    pos.y + menu_bar_height,
                ))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::PhysicalSize::new(half_width, usable_height as u32))
                .map_err(|e| e.to_string())?;
        }
        "maximize" => {
            window
                .set_position(tauri::PhysicalPosition::new(pos.x, pos.y + menu_bar_height))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::PhysicalSize::new(screen.width, usable_height as u32))
                .map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unknown direction: {}", direction)),
    }
    Ok(())
}

/// Reveal a path in the OS file manager (Finder on macOS, Explorer on
/// Windows, the default xdg handler on Linux). Used by the sidebar
/// right-click context menu (#4045) to jump to a session's cwd.
///
/// Selects the path itself (rather than opening its parent and leaving the
/// item unselected) on macOS and Windows; Linux's xdg-open does not have a
/// standard "select item" affordance, so we open the directory directly —
/// if the path is a file, we fall back to its parent dir so xdg doesn't
/// launch the default app for that file type.
///
/// Restricted to the `main` window via `require_main_window` so the
/// `dashboard` / `qr_popup` capability surface can't silently shell out to
/// `open` / `explorer` / `xdg-open` (#4045 review).
#[tauri::command]
fn reveal_in_finder(window: tauri::Window, path: String) -> Result<(), String> {
    use std::path::Path;
    use std::process::Command;

    require_main_window(&window)?;

    if path.is_empty() {
        return Err("path is empty".into());
    }
    if !Path::new(&path).exists() {
        return Err(format!("path does not exist: {}", path));
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("failed to spawn open: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // `explorer /select,<path>` is parsed by explorer.exe itself, NOT
        // by CommandLineToArgvW — Rust's normal arg quoting would wrap the
        // whole `/select,...` string in quotes and break the parser. Use
        // `raw_arg` to bypass quoting and wrap only the path in inner
        // quotes so paths containing spaces (e.g. `C:\Program Files\...`)
        // are selected as a single item. See #4045 review.
        use std::os::windows::process::CommandExt;
        Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.replace('"', "")))
            .spawn()
            .map_err(|e| format!("failed to spawn explorer: {}", e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if Path::new(&path).is_dir() {
            path.clone()
        } else {
            Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(path.clone())
        };
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("failed to spawn xdg-open: {}", e))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
    {
        Err("reveal_in_finder is not supported on this platform".into())
    }
}

/// Reject an IPC call that did not originate from the `main` window.
///
/// Used by commands that access privileged resources (microphone, clipboard
/// image data) — restricting them to the main window prevents a compromised
/// `dashboard` or `qr_popup` window from silently invoking the capability
/// after the initial user-granted permission. Generic message so it reads
/// correctly for every caller (#3796).
fn require_main_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("this command is restricted to the main window".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn voice_available(window: tauri::Window) -> Result<bool, String> {
    require_main_window(&window)?;
    Ok(speech::is_available())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn start_voice_input(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<speech::SpeechState>>,
) -> Result<(), String> {
    require_main_window(&window)?;
    let s = lock_or_recover(&state);
    speech::start(&s, &app)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn stop_voice_input(
    window: tauri::Window,
    state: tauri::State<'_, Mutex<speech::SpeechState>>,
) -> Result<(), String> {
    require_main_window(&window)?;
    let s = lock_or_recover(&state);
    speech::stop(&s);
    Ok(())
}

/// #4956 — reset macOS TCC permissions for Microphone + Speech Recognition
/// so a user upgrading past a codesign-hash change (e.g. v0.9.40 shipped
/// the helper-entitlement fix from #4954, but the macOS TCC database
/// remembered the entitlement-less hash) doesn't have to know `tccutil`
/// exists. Surfaced in Settings → Voice Input as a button.
///
/// Runs both `tccutil reset Microphone com.chroxy.desktop` and
/// `tccutil reset SpeechRecognition com.chroxy.desktop`. Either failing
/// individually still returns Err so the UI surfaces the real problem
/// (most likely: macOS prompted for admin elevation and the user
/// cancelled). On success the dashboard surfaces a one-shot confirmation
/// reminding the user to re-grant on the next mic click.
#[cfg(target_os = "macos")]
#[tauri::command]
fn reset_speech_permissions(window: tauri::Window) -> Result<(), String> {
    require_main_window(&window)?;
    // The bundle id is fixed at compile-time in tauri.conf.json; keeping it
    // hard-coded here matches verify-entitlements.sh and the troubleshooting
    // docs so the three references stay aligned by sight.
    const BUNDLE_ID: &str = "com.chroxy.desktop";

    for service in ["Microphone", "SpeechRecognition"] {
        let output = std::process::Command::new("tccutil")
            .args(["reset", service, BUNDLE_ID])
            .output()
            .map_err(|e| format!("Failed to invoke tccutil for {service}: {e}"))?;
        if !output.status.success() {
            // Some tccutil failures only write diagnostics to stdout (or
            // stderr is empty); include both so the UI never shows a blank
            // error string when the exit status is non-zero (#4998 review).
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "tccutil reset {service} {BUNDLE_ID} exited with status {}: stderr={} stdout={}",
                output.status.code().unwrap_or(-1),
                stderr.trim(),
                stdout.trim()
            ));
        }
    }
    Ok(())
}

/// Read the current clipboard image and return it as a base64-encoded PNG.
///
/// Returns `Ok(None)` when the clipboard does not currently hold an image —
/// the JS-side Ctrl+V handler surfaces this as a "No image on clipboard"
/// toast (#3748). Returns `Err(...)` only for real platform failures.
#[tauri::command]
fn read_clipboard_image(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use base64::{engine::general_purpose, Engine as _};
    use image::{ColorType, ImageEncoder};
    use tauri_plugin_clipboard_manager::ClipboardExt;

    require_main_window(&window)?;

    let img = match app.clipboard().read_image() {
        Ok(img) => img,
        // The plugin returns Err when the clipboard holds anything other
        // than an image (including empty). Distinguishing those from real
        // backend failures is unreliable across platforms, so we treat
        // every read_image failure as "no image" to give the user a
        // consistent toast. Log the underlying cause to stderr so genuine
        // backend issues (permission denial, platform driver failure)
        // remain diagnosable from the desktop logs (#3796 review).
        Err(e) => {
            eprintln!("[clipboard] read_image returned no image: {}", e);
            return Ok(None);
        }
    };

    let rgba = img.rgba();
    let width = img.width();
    let height = img.height();
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| "clipboard image dimensions overflow".to_string())?;
    if rgba.len() != expected {
        return Err(format!(
            "clipboard image buffer size {} does not match {}x{}x4",
            rgba.len(),
            width,
            height
        ));
    }

    let mut png_bytes: Vec<u8> = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
    encoder
        .write_image(rgba, width, height, ColorType::Rgba8.into())
        .map_err(|e| format!("PNG encode failed: {}", e))?;

    Ok(Some(general_purpose::STANDARD.encode(&png_bytes)))
}

pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(single_instance_init(
            |app: &tauri::AppHandle, _args, _cwd| {
                // Second instance launched: bring the existing main window
                // forward. Shares the one summon path so the two can't drift.
                window::show_window(app);
            },
        ));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // #5281 ② — global "summon" shortcut. Any registered shortcut (we only
        // ever register the one summon accelerator) brings the main window
        // forward. Registration is opt-in via DesktopSettings.summon_hotkey,
        // done in setup() below.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        window::show_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_server_info,
            get_server_logs,
            get_startup_logs,
            start_server,
            stop_server,
            restart_server,
            discover_lan_servers,
            get_qr_code_svg,
            pick_directory,
            check_dependencies,
            get_setup_state,
            save_setup_config,
            get_tunnel_mode,
            set_tunnel_mode,
            get_expose_on_lan,
            set_expose_on_lan,
            get_summon_hotkey,
            set_summon_hotkey,
            get_allow_auto_permission_mode,
            set_allow_auto_permission_mode,
            update_tray_badge,
            #[cfg(target_os = "macos")]
            voice_available,
            #[cfg(target_os = "macos")]
            start_voice_input,
            #[cfg(target_os = "macos")]
            stop_voice_input,
            #[cfg(target_os = "macos")]
            reset_speech_permissions,
            tile_window,
            read_clipboard_image,
            reveal_in_finder,
        ])
        .manage(Mutex::new(ServerManager::new()))
        .manage(Mutex::new(DesktopSettings::load()))
        .manage({
            #[cfg(target_os = "macos")]
            { Mutex::new(speech::SpeechState::new()) }
            #[cfg(not(target_os = "macos"))]
            { Mutex::new(()) }
        })
        .on_menu_event(|app, event| {
            // #4695 / #4942 — app-menu (macOS menu bar) item dispatch.
            // Tray menu events are handled by their own builder-scoped
            // closure (`on_menu_event` in build_tray_menu). The two
            // surfaces intentionally use disjoint id namespaces:
            //   - tray:    "start", "stop", "dashboard", …
            //   - app-menu: "app_menu:<action>" (this match)
            // The `app_menu:` prefix means stray cross-fires would
            // simply no-op rather than accidentally invoke the wrong
            // tray handler.
            //
            // Two routing classes:
            //   1. Server-control / tunnel / Help-browser actions —
            //      call the existing tray handlers directly. No
            //      dashboard round-trip is needed; the tray handlers
            //      already know how to keep both menus' state in sync.
            //   2. Dashboard-state actions (new session, sidebar
            //      toggle, plan mode, etc.) — emit `menu://<action>`
            //      so the dashboard's `useTauriMenuEvents` hook can
            //      route to a React-side callback supplied by App.tsx.
            //      Whether that callback is shared with another UI
            //      affordance (button, palette entry, …) is decided
            //      by App.tsx, not here.
            let id = event.id().as_ref();
            if let Some(action) = id.strip_prefix("app_menu:") {
                // The app-menu surface emitting these ids is itself
                // macOS-only today (see the menu builder block below),
                // so gate the arms that call macOS-only helpers to
                // match.
                #[cfg(target_os = "macos")]
                {
                    match action {
                        "shell-start" => { handle_start(app); return; }
                        "shell-stop" => { handle_stop(app); return; }
                        "shell-restart" => { handle_restart(app); return; }
                        "shell-open-in-finder" => {
                            handle_open_config_in_finder(app);
                            return;
                        }
                        "shell-open-console" => { handle_console(app); return; }
                        "tunnel-quick" => {
                            handle_set_tunnel_mode(app, "quick");
                            return;
                        }
                        "tunnel-named" => {
                            handle_set_tunnel_mode(app, "named");
                            return;
                        }
                        "tunnel-none" => {
                            handle_set_tunnel_mode(app, "none");
                            return;
                        }
                        "help-documentation" => {
                            handle_open_url(
                                app,
                                "https://github.com/blamechris/chroxy#readme",
                            );
                            return;
                        }
                        "help-report-issue" => {
                            handle_open_url(
                                app,
                                "https://github.com/blamechris/chroxy/issues/new",
                            );
                            return;
                        }
                        "help-check-updates" => {
                            handle_check_updates(app);
                            return;
                        }
                        // #4942 — Window > Bring All to Front. Handled
                        // Rust-side because the dashboard has no state
                        // to mutate AND because the unconditional
                        // `window::show_window(app)` below only raises
                        // the `main` webview — it misses secondary
                        // windows like `qr_popup` (built by
                        // `handle_show_qr`). Iterate every webview
                        // window and call `show()` + `set_focus()` so
                        // a click here actually brings ALL Chroxy
                        // windows forward.
                        "window-bring-all-to-front" => {
                            handle_bring_all_to_front(app);
                            return;
                        }
                        _ => {}
                    }
                }
                // Default route: emit `menu://<action>` for the
                // dashboard's `useTauriMenuEvents` hook to consume.
                // Covers File > New Session, File > Connect to Server…,
                // File > Disconnect, View > *, Tunnel > Settings…,
                // Chroxy > Preferences…, etc.
                let event_name = format!("menu://{}", action);
                let _ = app.emit(&event_name, ());
                // Make sure the main window is foregrounded so the
                // user sees the dashboard react (otherwise a menu
                // click with the window minimized would silently
                // no-op).
                window::show_window(app);
            }
        })
        .setup(|app| {
            // App menu bar — required for macOS Sequoia window tiling keyboard shortcuts.
            // macOS routes fn+ctrl+arrow through the Window menu's "Move & Resize" items.
            // Without a Window submenu, those shortcuts silently do nothing.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::AboutMetadata;
                // #4942 — "Preferences…" appended to the Chroxy
                // submenu so ⌘, opens the dashboard SettingsPanel from
                // the menu bar (the dashboard already binds ⌘, via
                // `settings.open`; macOS will route the chord through
                // the menu bar first once an item with that accelerator
                // is installed).
                let preferences_item = MenuItemBuilder::with_id(
                    "app_menu:preferences",
                    "Preferences…",
                )
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Chroxy")
                    .about(Some(AboutMetadata::default()))
                    .separator()
                    .item(&preferences_item)
                    .separator()
                    .quit()
                    .build()?;
                // #4695 — File menu. v1 ships with a single item ("New
                // Session") so the most-used action has a menu-bar entry
                // matching Terminal.app / iTerm / VS Code muscle memory.
                // The accelerator is `Cmd+N`, matching the dashboard's
                // `session.new` shortcut definition; macOS routes the
                // chord through the menu bar first when one is
                // installed, so this entry also serves as the system-
                // level Cmd+N hint.
                let new_session_item = MenuItemBuilder::with_id("app_menu:new-session", "New Session")
                    .accelerator("CmdOrCtrl+N")
                    .build(app)?;
                // #4942 — Connect to Server… / Disconnect siblings.
                // Cmd+O matches "open a connection" muscle memory from
                // Terminal.app / iTerm; Shift+Cmd+D mirrors Apple's HIG
                // for disconnect actions.
                let connect_item = MenuItemBuilder::with_id(
                    "app_menu:connect-to-server",
                    "Connect to Server…",
                )
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
                let disconnect_item = MenuItemBuilder::with_id(
                    "app_menu:disconnect",
                    "Disconnect",
                )
                .accelerator("Shift+CmdOrCtrl+D")
                .build(app)?;
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&new_session_item)
                    .separator()
                    .item(&connect_item)
                    .item(&disconnect_item)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                // #4942 — Shell submenu. Items mirror tray entries
                // (Start / Stop / Restart / Open Console). "Open in
                // Finder" reveals ~/.chroxy/ so the user can inspect
                // server config / logs without leaving the app. All
                // five items dispatch to existing handlers in
                // `on_menu_event` (no dashboard round-trip).
                let shell_start = MenuItemBuilder::with_id(
                    "app_menu:shell-start",
                    "Start Server",
                )
                .build(app)?;
                let shell_stop = MenuItemBuilder::with_id(
                    "app_menu:shell-stop",
                    "Stop Server",
                )
                .build(app)?;
                let shell_restart = MenuItemBuilder::with_id(
                    "app_menu:shell-restart",
                    "Restart Server",
                )
                .build(app)?;
                let shell_open_in_finder = MenuItemBuilder::with_id(
                    "app_menu:shell-open-in-finder",
                    "Open in Finder",
                )
                .build(app)?;
                let shell_open_console = MenuItemBuilder::with_id(
                    "app_menu:shell-open-console",
                    "Open Console",
                )
                .build(app)?;
                let shell_menu = SubmenuBuilder::new(app, "Shell")
                    .item(&shell_start)
                    .item(&shell_stop)
                    .item(&shell_restart)
                    .separator()
                    .item(&shell_open_in_finder)
                    .item(&shell_open_console)
                    .build()?;
                // #4942 — View submenu. Items dispatch to the
                // dashboard (the toggles all live in App-level React
                // state). The accelerators intentionally match the
                // dashboard shortcut registry defaults so the menu-
                // bar entry serves as the canonical key-binding hint:
                //   - Toggle Sidebar:    ⌘B  (`sidebar.toggle`)
                //   - Toggle Plan Mode:  ⇧⌥P (the registry default is
                //     Shift+Tab, which macOS menus can't represent;
                //     the menu surface picks a non-colliding chord)
                //   - Show QR:           ⇧⌘Q
                //   - Reload:            ⌘R  (Tauri webview reload)
                // Cmd+\ ("cycle split") from the proposal collides
                // with the existing `view.cycleSplit` registry binding
                // and is not duplicated here — the dashboard already
                // handles that chord via the registry.
                let view_toggle_sidebar = MenuItemBuilder::with_id(
                    "app_menu:view-toggle-sidebar",
                    "Toggle Sidebar",
                )
                .accelerator("CmdOrCtrl+B")
                .build(app)?;
                let view_toggle_plan_mode = MenuItemBuilder::with_id(
                    "app_menu:view-toggle-plan-mode",
                    "Toggle Plan Mode",
                )
                .accelerator("Shift+Alt+P")
                .build(app)?;
                let view_show_qr = MenuItemBuilder::with_id(
                    "app_menu:view-show-qr",
                    "Show QR Code",
                )
                .accelerator("Shift+CmdOrCtrl+Q")
                .build(app)?;
                let view_reload = MenuItemBuilder::with_id(
                    "app_menu:view-reload",
                    "Reload",
                )
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
                let view_menu = SubmenuBuilder::new(app, "View")
                    .item(&view_toggle_sidebar)
                    .item(&view_toggle_plan_mode)
                    .separator()
                    .item(&view_show_qr)
                    .item(&view_reload)
                    .build()?;
                // #4942 — Tunnel submenu. Radios mirror the tray
                // menu's tunnel-mode submenu (`tunnel_quick` /
                // `tunnel_named` / `tunnel_none`) and dispatch to the
                // same Rust handler (`handle_set_tunnel_mode`), which
                // keeps both menus' checked state in sync. "Tunnel
                // Settings…" routes to the dashboard so it can open
                // the Settings panel.
                let current_tunnel = {
                    let s = app.state::<Mutex<DesktopSettings>>();
                    let g = lock_or_recover(&s);
                    g.tunnel_mode.clone()
                };
                let tunnel_quick_app = CheckMenuItemBuilder::with_id(
                    "app_menu:tunnel-quick",
                    "Quick Tunnel",
                )
                .checked(current_tunnel == "quick")
                .build(app)?;
                let tunnel_named_app = CheckMenuItemBuilder::with_id(
                    "app_menu:tunnel-named",
                    "Named Tunnel",
                )
                .checked(current_tunnel == "named")
                .build(app)?;
                let tunnel_none_app = CheckMenuItemBuilder::with_id(
                    "app_menu:tunnel-none",
                    "No Tunnel",
                )
                .checked(current_tunnel == "none")
                .build(app)?;
                let tunnel_settings_item = MenuItemBuilder::with_id(
                    "app_menu:tunnel-settings",
                    "Tunnel Settings…",
                )
                .build(app)?;
                let tunnel_menu = SubmenuBuilder::new(app, "Tunnel")
                    .item(&tunnel_quick_app)
                    .item(&tunnel_named_app)
                    .item(&tunnel_none_app)
                    .separator()
                    .item(&tunnel_settings_item)
                    .build()?;
                // #4942 — Window submenu. Append "Bring All to Front"
                // as a custom item — Tauri's SubmenuBuilder doesn't
                // expose a predefined `bring_all_to_front()` today.
                let bring_all_to_front = MenuItemBuilder::with_id(
                    "app_menu:window-bring-all-to-front",
                    "Bring All to Front",
                )
                .build(app)?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .close_window()
                    .separator()
                    .item(&bring_all_to_front)
                    .build()?;
                // #4942 — Help submenu. Documentation / Report Issue
                // open browser URLs Rust-side; Check for Updates
                // reuses the tray's `handle_check_updates`.
                let help_documentation = MenuItemBuilder::with_id(
                    "app_menu:help-documentation",
                    "Documentation",
                )
                .build(app)?;
                let help_report_issue = MenuItemBuilder::with_id(
                    "app_menu:help-report-issue",
                    "Report Issue",
                )
                .build(app)?;
                let help_check_updates = MenuItemBuilder::with_id(
                    "app_menu:help-check-updates",
                    "Check for Updates",
                )
                .build(app)?;
                let help_menu = SubmenuBuilder::new(app, "Help")
                    .item(&help_documentation)
                    .item(&help_report_issue)
                    .separator()
                    .item(&help_check_updates)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&file_menu)
                    .item(&edit_menu)
                    .item(&shell_menu)
                    .item(&view_menu)
                    .item(&tunnel_menu)
                    .item(&window_menu)
                    .item(&help_menu)
                    .build()?;
                app.set_menu(menu)?;

                // #4942 — Track app-menu item handles so we can keep
                // the Shell submenu's enabled state in sync with the
                // server status (via `update_menu_state`) and the
                // Tunnel radios in sync with `handle_set_tunnel_mode`.
                app.manage(Mutex::new(AppMenuItems {
                    shell_start: shell_start.clone(),
                    shell_stop: shell_stop.clone(),
                    shell_restart: shell_restart.clone(),
                    shell_open_console: shell_open_console.clone(),
                    tunnel_quick: tunnel_quick_app.clone(),
                    tunnel_named: tunnel_named_app.clone(),
                    tunnel_none: tunnel_none_app.clone(),
                }));

                // Workaround for Tauri bug #13605: Tauri's SubmenuBuilder doesn't
                // register the Window submenu with NSApp.windowsMenu, so macOS
                // never adds "Move & Resize" tiling items. We set it manually via
                // the cocoa crate to enable fn+ctrl+arrow tiling shortcuts.
                unsafe {
                    use cocoa::base::{id, nil};
                    use cocoa::appkit::NSApp;
                    use objc::{msg_send, sel, sel_impl};

                    let ns_app: id = NSApp();
                    let main_menu: id = msg_send![ns_app, mainMenu];
                    if main_menu != nil {
                        let count: isize = msg_send![main_menu, numberOfItems];
                        for i in 0..count {
                            let item: id = msg_send![main_menu, itemAtIndex:i];
                            if item != nil {
                                let submenu: id = msg_send![item, submenu];
                                if submenu != nil {
                                    let title: id = msg_send![submenu, title];
                                    if title == nil { continue; }
                                    let utf8: *const std::os::raw::c_char = msg_send![title, UTF8String];
                                    if utf8.is_null() { continue; }
                                    let title_str = std::ffi::CStr::from_ptr(utf8)
                                        .to_str().unwrap_or("");
                                    if title_str == "Window" {
                                        let _: () = msg_send![ns_app, setWindowsMenu:submenu];
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // First-run: generate config if needed
            let is_first_run = setup::ensure_config();
            IS_FIRST_RUN.store(is_first_run, Ordering::Relaxed);

            // Restore saved window position and size
            if let Some(win) = app.get_webview_window("main") {
                let settings = app.state::<Mutex<DesktopSettings>>();
                let s = lock_or_recover(&settings);
                if let (Some(x), Some(y)) = (s.last_window_x, s.last_window_y) {
                    // Validate position is on a visible monitor before restoring
                    let on_screen = win.available_monitors().map(|monitors| {
                        monitors.iter().any(|m| {
                            let pos = m.position();
                            let size = m.size();
                            let mx = pos.x as f64;
                            let my = pos.y as f64;
                            let mw = size.width as f64;
                            let mh = size.height as f64;
                            x >= mx && x < mx + mw && y >= my && y < my + mh
                        })
                    }).unwrap_or(false);
                    if on_screen {
                        let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                    }
                    // If off-screen, fall through to Tauri's default center behavior
                }
                if let (Some(w), Some(h)) = (s.last_window_width, s.last_window_height) {
                    let w = w.max(200.0) as u32;
                    let h = h.max(200.0) as u32;
                    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
                }
            }

            // Enable macOS Sequoia window tiling (Fn+Ctrl+Arrow shortcuts).
            // Tauri/tao doesn't set FullScreenPrimary by default, so macOS
            // doesn't consider the window a tiling candidate.
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                use cocoa::appkit::NSWindow;
                use cocoa::base::id;
                if let Ok(raw) = win.ns_window() {
                    let ns_win = raw as id;
                    unsafe {
                        let mut behavior = ns_win.collectionBehavior();
                        // FullScreenPrimary (1 << 7): enables green-button fullscreen + tiling
                        behavior |= cocoa::appkit::NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenPrimary;
                        // FullScreenAllowsTiling (1 << 11): added in macOS 15 Sequoia
                        // for keyboard-driven tiling (Fn+Ctrl+Arrow). Not in the cocoa
                        // crate yet, so we set the raw bit directly.
                        let bits = behavior.bits() | (1 << 11);
                        behavior = cocoa::appkit::NSWindowCollectionBehavior::from_bits_retain(bits);
                        ns_win.setCollectionBehavior_(behavior);
                    }
                }
            }

            setup_tray(app)?;

            // #5281 ② — register the opt-in global summon hotkey, if configured.
            {
                let settings = app.state::<Mutex<DesktopSettings>>();
                let settings_guard = lock_or_recover(&settings);
                let accel = settings_guard.effective_summon_hotkey();
                drop(settings_guard);
                if let Some(accel) = accel {
                    match register_summon_hotkey(app.handle(), &accel) {
                        Ok(()) => eprintln!("[hotkey] summon shortcut registered: {}", accel),
                        Err(e) => eprintln!("[hotkey] {}", e),
                    }
                }
            }

            // Auto-start server on launch if configured (skip on first run — wizard handles it)
            if !is_first_run {
                let settings = app.state::<Mutex<DesktopSettings>>();
                let auto_start = lock_or_recover(&settings).auto_start_server;
                drop(settings);
                let config = config::load_config();
                match startup_action(auto_start, config.api_token.is_some()) {
                    StartupAction::StartOwn => handle_start(app.handle()),
                    // #6015 — client mode: adopt an already-running external server
                    // instead of hanging on the splash. Probe /health on the
                    // configured port; navigate to its dashboard on success, or
                    // surface an actionable error (not an indefinite spinner).
                    StartupAction::AdoptExternal => {
                        let app_handle = app.handle().clone();
                        let port = config.port;
                        let token = config.api_token.clone();
                        std::thread::spawn(move || {
                            if probe_external_health(port) {
                                match token {
                                    Some(t) => window::emit_server_ready(&app_handle, port, Some(&t)),
                                    None => window::emit_server_error(
                                        &app_handle,
                                        &format!(
                                            "A server is running on port {} but no access token was found. Pair the app or paste a token in Settings.",
                                            port
                                        ),
                                    ),
                                }
                            } else {
                                window::emit_server_error(
                                    &app_handle,
                                    &format!(
                                        "No server found on port {}. Start a server, or enable Auto-start Server in Settings.",
                                        port
                                    ),
                                );
                            }
                        });
                    }
                    // #6124 — auto-start is on but no token yet. The pairing /
                    // first-run flow normally mints one, but if it never
                    // completes (wizard dismissed, token expected-but-absent)
                    // the splash would hang forever — the same failure class
                    // #6015 fixes on the client branch. Surface an actionable
                    // message instead of a silent spinner.
                    StartupAction::Skip => window::emit_server_error(
                        app.handle(),
                        "Auto-start is on but no access token was found. Complete pairing, or paste a token in Settings.",
                    ),
                }
            }

            // Silent update check on launch
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_updater::UpdaterExt;
                if let Ok(updater) = app_handle.updater() {
                    if let Ok(Some(update)) = updater.check().await {
                        let _ = app_handle.emit("update_available", &update.version);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Save window position/size on move or resize
            if let tauri::WindowEvent::Moved(pos) = event {
                let app = window.app_handle();
                if let Some(settings) = app.try_state::<Mutex<DesktopSettings>>() {
                    let mut s = lock_or_recover(&settings);
                    s.last_window_x = Some(pos.x as f64);
                    s.last_window_y = Some(pos.y as f64);
                    let _ = s.save();
                }
            }
            if let tauri::WindowEvent::Resized(size) = event {
                let app = window.app_handle();
                if let Some(settings) = app.try_state::<Mutex<DesktopSettings>>() {
                    let mut s = lock_or_recover(&settings);
                    s.last_window_width = Some(size.width as f64);
                    s.last_window_height = Some(size.height as f64);
                    let _ = s.save();
                }
            }
            // Closing any window stops the server and quits the app
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                if let Some(mgr) = app.try_state::<Mutex<ServerManager>>() {
                    let mut mgr = lock_or_recover(&mgr);
                    mgr.stop();
                }
                app.exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Catch all app-exit paths (Cmd+Q, app menu Quit, AppleScript
            // `tell application "Chroxy" to quit`, etc.) so the spawned Node
            // server child gets a graceful SIGTERM and releases port 8765
            // before Tauri tears down. Without this, the child gets
            // reparented to launchd on macOS and holds the port, blocking
            // the next launch with "Port 8765 is already in use" (#3696).
            //
            // The WindowEvent::CloseRequested handler above already covers
            // window-close-driven exits, but those events do not fire for
            // tray-only quit paths. Routing through ExitRequested gives us
            // a single chokepoint that ServerManager::stop() — which already
            // implements SIGTERM + 5s grace + SIGKILL fallback — can use to
            // flush session-state.json before the process dies.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(mgr) = app_handle.try_state::<Mutex<ServerManager>>() {
                    let mut mgr = lock_or_recover(&mgr);
                    mgr.stop();
                }
            }
        });
}

/// Register the opt-in global summon shortcut, returning any registration
/// error (malformed accelerator or OS-level conflict) so the caller can decide
/// how to handle it: surface it to the user for a runtime change
/// (`set_summon_hotkey`), or just log it for the best-effort startup
/// registration — the tray "Show Chroxy" item is always available as a
/// fallback. (#5281 ②, #5294)
fn register_summon_hotkey(app: &tauri::AppHandle, accelerator: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut()
        .register(accelerator)
        .map_err(|e| format!("failed to register summon shortcut '{}': {}", accelerator, e))
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // #5281 ② — always-available "summon" affordance: bring the main window
    // forward from the tray, regardless of server state or any global hotkey.
    let show_window_item =
        MenuItemBuilder::with_id("show_window", "Show Chroxy").build(app)?;
    let start = MenuItemBuilder::with_id("start", "Start Server").build(app)?;
    let stop = MenuItemBuilder::with_id("stop", "Stop Server")
        .enabled(false)
        .build(app)?;
    let restart = MenuItemBuilder::with_id("restart", "Restart Server")
        .enabled(false)
        .build(app)?;
    let dashboard = MenuItemBuilder::with_id("dashboard", "Open Dashboard")
        .enabled(false)
        .build(app)?;
    let console = MenuItemBuilder::with_id("console", "Console")
        .enabled(false)
        .build(app)?;
    let show_qr = MenuItemBuilder::with_id("show_qr", "Show QR Code")
        .enabled(false)
        .build(app)?;

    // Settings toggles
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let auto_start_login = CheckMenuItemBuilder::with_id("auto_start_login", "Start at Login")
        .checked(autostart_enabled)
        .build(app)?;

    let settings = app.state::<Mutex<DesktopSettings>>();
    let settings_guard = lock_or_recover(&settings);
    let auto_start_server_checked = settings_guard.auto_start_server;
    let current_tunnel = settings_guard.tunnel_mode.clone();
    drop(settings_guard);

    let auto_start_server = CheckMenuItemBuilder::with_id("auto_start_server", "Auto-start Server")
        .checked(auto_start_server_checked)
        .build(app)?;

    // Tunnel mode submenu
    let tunnel_quick = CheckMenuItemBuilder::with_id("tunnel_quick", "Quick Tunnel")
        .checked(current_tunnel == "quick")
        .build(app)?;
    let tunnel_named = CheckMenuItemBuilder::with_id("tunnel_named", "Named Tunnel")
        .checked(current_tunnel == "named")
        .build(app)?;
    let tunnel_none = CheckMenuItemBuilder::with_id("tunnel_none", "Local Only")
        .checked(current_tunnel == "none")
        .build(app)?;

    let tunnel_submenu = SubmenuBuilder::with_id(app, "tunnel_mode", "Tunnel Mode")
        .item(&tunnel_quick)
        .item(&tunnel_named)
        .item(&tunnel_none)
        .build()?;

    let check_updates =
        MenuItemBuilder::with_id("check_updates", "Check for Updates").build(app)?;

    let quit = MenuItemBuilder::with_id("quit", "Quit Chroxy").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show_window_item])
        .separator()
        .items(&[&start, &stop, &restart])
        .separator()
        .items(&[&dashboard, &console, &show_qr])
        .separator()
        .item(&auto_start_login)
        .item(&auto_start_server)
        .item(&tunnel_submenu)
        .separator()
        .item(&check_updates)
        .separator()
        .items(&[&quit])
        .build()?;

    app.manage(Mutex::new(TrayMenuItems {
        start: start.clone(),
        stop: stop.clone(),
        restart: restart.clone(),
        dashboard: dashboard.clone(),
        console: console.clone(),
        show_qr: show_qr.clone(),
        check_updates: check_updates.clone(),
        auto_start_login: auto_start_login.clone(),
        auto_start_server: auto_start_server.clone(),
        tunnel_quick: tunnel_quick.clone(),
        tunnel_named: tunnel_named.clone(),
        tunnel_none: tunnel_none.clone(),
    }));

    // Load tray icon from embedded PNG (not from config — avoids dual tray icon conflict)
    let icon_bytes = include_bytes!("../icons/tray-icon.png");
    let img = image::load_from_memory(icon_bytes)
        .expect("decode tray icon")
        .to_rgba8();
    let (w, h) = img.dimensions();
    let icon = tauri::image::Image::new_owned(img.into_raw(), w, h);

    let tray = TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Chroxy")
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                "show_window" => window::show_window(app),
                "start" => handle_start(app),
                "stop" => handle_stop(app),
                "restart" => handle_restart(app),
                "dashboard" => handle_dashboard(app),
                "console" => handle_console(app),
                "show_qr" => handle_show_qr(app),
                "auto_start_login" => handle_toggle_login(app),
                "auto_start_server" => handle_toggle_auto_start(app),
                "tunnel_quick" => handle_set_tunnel_mode(app, "quick"),
                "tunnel_named" => handle_set_tunnel_mode(app, "named"),
                "tunnel_none" => handle_set_tunnel_mode(app, "none"),
                "check_updates" => handle_check_updates(app),
                "quit" => {
                    if let Some(mgr) = app.try_state::<Mutex<ServerManager>>() {
                        let mut mgr = lock_or_recover(&mgr);
                        mgr.stop();
                    }
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    // Keep tray icon alive for the entire app lifetime.
    // TrayIcon is registered with the app but the local reference must not be dropped
    // on older Tauri versions where Drop removes the tray.
    std::mem::forget(tray);

    Ok(())
}

/// Tray menu states that determine which items are enabled.
enum MenuState {
    Running,
    Stopped,
    Restarting,
}

fn update_menu_state(app: &tauri::AppHandle, state: MenuState) {
    if let Some(items) = app.try_state::<Mutex<TrayMenuItems>>() {
        let items = lock_or_recover(&items);
        match state {
            MenuState::Running => {
                let _ = items.start.set_enabled(false);
                let _ = items.stop.set_enabled(true);
                let _ = items.restart.set_enabled(true);
                let _ = items.dashboard.set_enabled(true);
                let _ = items.console.set_enabled(true);
                let _ = items.show_qr.set_enabled(true);
            }
            MenuState::Stopped => {
                let _ = items.start.set_enabled(true);
                let _ = items.stop.set_enabled(false);
                let _ = items.restart.set_enabled(false);
                let _ = items.dashboard.set_enabled(false);
                let _ = items.console.set_enabled(false);
                let _ = items.show_qr.set_enabled(false);
            }
            MenuState::Restarting => {
                let _ = items.start.set_enabled(false);
                let _ = items.stop.set_enabled(false);
                let _ = items.restart.set_enabled(false);
                let _ = items.dashboard.set_enabled(false);
                let _ = items.console.set_enabled(false);
                let _ = items.show_qr.set_enabled(false);
            }
        }
    }
    // #4942 — mirror the gating on the macOS app-menu Shell submenu so
    // the menu-bar entries reflect server status the same way the tray
    // items do. The "Open in Finder" item is intentionally always
    // enabled (it just reveals ~/.chroxy/), so it's omitted here.
    #[cfg(target_os = "macos")]
    if let Some(items) = app.try_state::<Mutex<AppMenuItems>>() {
        let items = lock_or_recover(&items);
        match state {
            MenuState::Running => {
                let _ = items.shell_start.set_enabled(false);
                let _ = items.shell_stop.set_enabled(true);
                let _ = items.shell_restart.set_enabled(true);
                let _ = items.shell_open_console.set_enabled(true);
            }
            MenuState::Stopped => {
                let _ = items.shell_start.set_enabled(true);
                let _ = items.shell_stop.set_enabled(false);
                let _ = items.shell_restart.set_enabled(false);
                let _ = items.shell_open_console.set_enabled(false);
            }
            MenuState::Restarting => {
                let _ = items.shell_start.set_enabled(false);
                let _ = items.shell_stop.set_enabled(false);
                let _ = items.shell_restart.set_enabled(false);
                let _ = items.shell_open_console.set_enabled(false);
            }
        }
    }
}

/// Whether `monitor_startup` is watching an initial start or a restart.
enum StartupContext {
    Start,
    Restart,
}

/// Poll `ServerStatus` every 1s for up to 60 seconds after a start or restart.
///
/// On `Running`: emits `server_ready`, updates menu to Running.
/// On `Error`: emits `server_error`, sends a notification, updates menu to Stopped.
/// On timeout (60 seconds): emits `server_error`, sends a timeout notification.
///
/// Returns `true` if the server reached `Running`, `false` otherwise.
fn monitor_startup(app: &tauri::AppHandle, context: StartupContext) -> bool {
    let (error_title, timeout_title, action) = match context {
        StartupContext::Start => ("Server Error", "Server Timeout", "start"),
        StartupContext::Restart => ("Restart Failed", "Restart Timeout", "restart"),
    };
    let timeout_msg = format!("Server failed to {} within 60 seconds.", action);

    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let state = app.state::<Mutex<ServerManager>>();

        // Child-exit fast path (issue #5492): if the spawned server process
        // died before health ever succeeded (e.g. EADDRINUSE because another
        // chroxy owns the port), fail immediately with a classified cause
        // instead of spinning — a foreign healthy server on the same port
        // can answer the health poll and mask the death entirely.
        if let Some(msg) = lock_or_recover(&state).check_startup_child_exit() {
            update_menu_state(app, MenuState::Stopped);
            window::emit_server_error(app, &msg);
            send_notification(app, error_title, &msg);
            return false;
        }

        let status = lock_or_recover(&state).status();
        match status {
            ServerStatus::Running => {
                update_menu_state(app, MenuState::Running);
                let state = app.state::<Mutex<ServerManager>>();
                let mgr = lock_or_recover(&state);
                let p = mgr.port();
                let t = mgr.token();
                drop(mgr);
                window::emit_server_ready(app, p, t.as_deref());
                return true;
            }
            ServerStatus::Error(ref msg) => {
                update_menu_state(app, MenuState::Stopped);
                window::emit_server_error(app, msg);
                send_notification(app, error_title, msg);
                return false;
            }
            ServerStatus::Stopped => return false,
            _ => {}
        }
    }

    // Timeout
    update_menu_state(app, MenuState::Stopped);
    window::emit_server_error(app, &timeout_msg);
    send_notification(app, timeout_title, &timeout_msg);
    false
}

/// #6015 — what to do for the embedded server at a (non-first-run) launch. The
/// pure decision is split out from the I/O (probe + navigate) so it is unit
/// testable.
#[derive(Debug, PartialEq, Eq)]
enum StartupAction {
    /// Auto-start is on and a token exists — launch the bundled server.
    StartOwn,
    /// Auto-start is off — act as a CLIENT: probe for an already-running
    /// external server (e.g. an always-on launchd daemon) and navigate to its
    /// dashboard, instead of hanging on the "Still starting…" splash forever.
    AdoptExternal,
    /// Auto-start is on but no token yet — do NOT launch a tokenless server
    /// (the pairing / first-run flow mints one). #6124: the caller surfaces an
    /// actionable "complete pairing" message rather than hanging on the splash
    /// if that flow never completes.
    Skip,
}

fn startup_action(auto_start: bool, has_token: bool) -> StartupAction {
    match (auto_start, has_token) {
        (true, true) => StartupAction::StartOwn,
        (true, false) => StartupAction::Skip,
        (false, _) => StartupAction::AdoptExternal,
    }
}

/// #6015 — probe an already-running external server's `/health` on loopback.
/// A few short attempts (so a just-launched daemon is still adopted); returns
/// true on the first 200. Mirrors the embedded-server health check (ureq, 2s).
/// #6015 (security, #6123 review) — confirm a 200 `/health` body is actually a
/// chroxy server before adopting it. We navigate WITH the access token, so a
/// 200 from an UNRELATED local service squatting on the port must NOT receive
/// the token. chroxy's health JSON is `{"status":"ok","mode":...,"version":...}`
/// — require `status:"ok"` AND a string `version` as the fingerprint. Pure, so
/// unit-tested.
fn is_chroxy_health(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .map(|v| {
            v.get("status").and_then(|s| s.as_str()) == Some("ok")
                && v.get("version").and_then(|x| x.as_str()).is_some()
        })
        .unwrap_or(false)
}

fn probe_external_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/health", port);
    for attempt in 0..10 {
        // Log each attempt (mirrors the embedded-server health check in
        // server.rs) so a stuck client-mode launch is debuggable from the app's
        // stderr/console rather than a silent spinner.
        match ureq::get(&url).timeout(std::time::Duration::from_secs(2)).call() {
            Ok(resp) => {
                let code = resp.status();
                if code == 200 {
                    // Token-leak guard: only adopt a verified chroxy server.
                    let body = resp.into_string().unwrap_or_default();
                    if is_chroxy_health(&body) {
                        eprintln!("[client-adopt] attempt #{} GET {} -> 200 (chroxy)", attempt + 1, url);
                        return true;
                    }
                    eprintln!(
                        "[client-adopt] attempt #{} GET {} -> 200 but not a chroxy /health body; not adopting",
                        attempt + 1, url
                    );
                } else {
                    eprintln!("[client-adopt] attempt #{} GET {} -> {}", attempt + 1, url, code);
                }
            }
            Err(err) => {
                eprintln!("[client-adopt] attempt #{} GET {} -> Err({})", attempt + 1, url, err);
            }
        }
        // No sleep after the final attempt.
        if attempt < 9 {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
    false
}

fn handle_start(app: &tauri::AppHandle) {
    // Read settings and apply to server manager. #5356 — also carry the
    // expose-on-LAN flag so the embedded server is pinned to loopback unless
    // the user explicitly opted in; defaults to false (loopback) when settings
    // state is unavailable.
    let (tunnel_mode, node_path, expose_on_lan) = app
        .try_state::<Mutex<DesktopSettings>>()
        .map(|s| {
            let settings = lock_or_recover(&s);
            (
                settings.tunnel_mode.clone(),
                settings.node_path.clone(),
                settings.expose_on_lan,
            )
        })
        .unwrap_or_else(|| ("quick".to_string(), None, false));

    // Validate cloudflared for tunnel modes
    if tunnel_mode != "none" && !ServerManager::check_cloudflared() {
        send_notification(
            app,
            "Tunnel Unavailable",
            &format!("cloudflared not found. Install with: {}", cloudflared_install_hint()),
        );
        // Fall back to local-only mode for this start
    }

    let state = app.state::<Mutex<ServerManager>>();
    let result = {
        let mut mgr = lock_or_recover(&state);
        // Only use tunnel mode if cloudflared is available, otherwise fall back to none
        let effective_mode = if tunnel_mode != "none" && !ServerManager::check_cloudflared() {
            "none"
        } else {
            &tunnel_mode
        };
        mgr.set_tunnel_mode(effective_mode);
        mgr.set_node_path(node_path.as_deref());
        mgr.set_expose_on_lan(expose_on_lan);
        mgr.start()
    };

    match result {
        Ok(()) => {
            update_menu_state(app, MenuState::Running);

            // Show window immediately (loading page shows spinner)
            window::show_window(app);

            // Inject settings button handler on the loading page
            {
                let state = app.state::<Mutex<ServerManager>>();
                let mgr = lock_or_recover(&state);
                let p = mgr.port();
                let t = mgr.token();
                drop(mgr);
                window::inject_settings_button_handler(app, p, t.as_deref());
            }

            let app_handle = app.clone();
            std::thread::spawn(move || {
                // Phase 1: Wait for initial startup (up to 60s)
                let reached_running = monitor_startup(&app_handle, StartupContext::Start);

                if !reached_running {
                    return;
                }

                // Phase 2: Monitor for crashes and auto-restart
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));

                    let state = app_handle.state::<Mutex<ServerManager>>();
                    let mgr = lock_or_recover(&state);
                    let status = mgr.status();
                    let pending = mgr.is_auto_restart_pending();
                    let backoff = mgr.restart_backoff();
                    let count = mgr.restart_count();
                    drop(mgr);

                    match status {
                        ServerStatus::Stopped => return, // User stopped
                        ServerStatus::Error(_) if pending => {
                            // Crash detected — attempt auto-restart
                            update_menu_state(&app_handle, MenuState::Restarting);
                            send_notification(
                                &app_handle,
                                "Server Crashed",
                                &format!(
                                    "Auto-restarting in {}s (attempt {}/{})",
                                    backoff.as_secs(),
                                    count + 1,
                                    ServerManager::MAX_RESTART_ATTEMPTS
                                ),
                            );

                            // Emit restarting event — React dashboard shows restart progress
                            window::emit_server_restarting(
                                &app_handle,
                                count + 1,
                                ServerManager::MAX_RESTART_ATTEMPTS as u32,
                                backoff.as_secs(),
                            );

                            // Wait backoff delay
                            std::thread::sleep(backoff);

                            // Attempt restart
                            let state = app_handle.state::<Mutex<ServerManager>>();
                            let mut mgr = lock_or_recover(&state);
                            match mgr.try_auto_restart() {
                                Ok(()) => {
                                    drop(mgr);
                                    // Wait for server to reach Running again
                                    let recovered =
                                        monitor_startup(&app_handle, StartupContext::Restart);
                                    if recovered {
                                        send_notification(
                                            &app_handle,
                                            "Server Recovered",
                                            "Auto-restart successful",
                                        );
                                        let state = app_handle.state::<Mutex<ServerManager>>();
                                        lock_or_recover(&state).reset_restart_count();
                                    } else {
                                        // If recovery failed but we haven't hit max
                                        // attempts, re-signal pending so the outer loop
                                        // retries instead of exiting at Error(_).
                                        let state = app_handle.state::<Mutex<ServerManager>>();
                                        let mgr = lock_or_recover(&state);
                                        if mgr.restart_count() < ServerManager::MAX_RESTART_ATTEMPTS
                                        {
                                            mgr.signal_auto_restart();
                                        }
                                    }
                                    // Continue loop — will check for more crashes
                                }
                                Err(_) => {
                                    drop(mgr);
                                    update_menu_state(&app_handle, MenuState::Stopped);
                                    window::emit_server_error(
                                        &app_handle,
                                        "Auto-restart failed. Use tray menu to restart manually.",
                                    );
                                    send_notification(
                                        &app_handle,
                                        "Server Unrecoverable",
                                        "Auto-restart failed. Use tray menu to restart manually.",
                                    );
                                    return;
                                }
                            }
                        }
                        ServerStatus::Error(_) => {
                            // Error without auto-restart pending (max attempts or unknown)
                            return;
                        }
                        _ => {} // Running, Starting, Restarting — keep monitoring
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("[tray] Failed to start server: {}", e);
            update_menu_state(app, MenuState::Stopped);
            window::emit_server_error(app, &e);
            send_notification(app, "Server Error", &e);
        }
    }
}

fn handle_stop(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let mut mgr = lock_or_recover(&state);
    mgr.stop();
    drop(mgr);
    update_menu_state(app, MenuState::Stopped);
    window::emit_server_stopped(app);
}

fn handle_restart(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let result = {
        let mut mgr = lock_or_recover(&state);
        mgr.restart()
    };

    match result {
        Ok(()) => {
            update_menu_state(app, MenuState::Restarting);

            // Spawn monitoring thread to verify server reaches Running
            let app_handle = app.clone();
            std::thread::spawn(move || {
                monitor_startup(&app_handle, StartupContext::Restart);
            });
        }
        Err(e) => {
            eprintln!("[tray] Failed to restart server: {}", e);
            update_menu_state(app, MenuState::Stopped);
            window::emit_server_error(app, &e);
            send_notification(app, "Restart Failed", &e);
        }
    }
}

fn handle_dashboard(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let mgr = lock_or_recover(&state);
    if !mgr.is_running() {
        // Emit server_stopped so the loading page shows "Server stopped"
        // instead of the default "Starting server..." text
        window::emit_server_stopped(app);
        return;
    }

    let port = mgr.port();
    let token = mgr.token();
    drop(mgr);

    window::emit_server_ready(app, port, token.as_deref());
}

fn handle_console(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let mgr = lock_or_recover(&state);
    if !mgr.is_running() {
        // No-op when server isn't running — avoid emitting server_stopped
        // which would incorrectly disconnect the dashboard during Starting/Restarting
        return;
    }
    drop(mgr);

    window::emit_navigate_console(app);
}

fn handle_show_qr(app: &tauri::AppHandle) {
    // Verify server is running (menu state can become stale on crash/restart)
    let state = app.state::<Mutex<ServerManager>>();
    let mgr = lock_or_recover(&state);
    if !mgr.is_running() {
        send_notification(app, "QR Code", "Server is not running");
        return;
    }
    drop(mgr);

    // If popup already exists, focus it
    if let Some(win) = app.get_webview_window("qr_popup") {
        let _ = win.set_focus();
        return;
    }

    let (hostname, token) = match qrcode::get_connection_info() {
        Ok(info) => info,
        Err(e) => {
            send_notification(app, "QR Code Error", &e);
            return;
        }
    };

    let url = qrcode::build_connection_url(&hostname, &token);
    let svg = match qrcode::generate_qr_svg(&url) {
        Ok(s) => s,
        Err(e) => {
            send_notification(app, "QR Code Error", &e);
            return;
        }
    };

    let html = qrcode::build_qr_popup_html(&svg, &url);

    // Build a data URI to avoid document.write() (CSP-safe)
    let encoded_html = window::percent_encode_html(&html);
    let data_uri = format!("data:text/html;charset=utf-8,{}", encoded_html);
    let webview_url = match data_uri.parse::<tauri::Url>() {
        Ok(parsed) => tauri::WebviewUrl::External(parsed),
        Err(e) => {
            send_notification(
                app,
                "QR Code Error",
                &format!("Failed to encode popup HTML: {}", e),
            );
            return;
        }
    };

    if let Err(e) = tauri::WebviewWindowBuilder::new(app, "qr_popup", webview_url)
        .title("Chroxy — QR Code")
        .inner_size(320.0, 400.0)
        .resizable(false)
        .center()
        .build()
    {
        eprintln!("[tray] Failed to create QR popup: {}", e);
        send_notification(
            app,
            "QR Code Error",
            &format!("Failed to open popup: {}", e),
        );
    }
}

fn handle_toggle_login(app: &tauri::AppHandle) {
    let autolaunch = app.autolaunch();
    let currently_enabled = autolaunch.is_enabled().unwrap_or(false);

    if currently_enabled {
        let _ = autolaunch.disable();
    } else {
        let _ = autolaunch.enable();
    }

    // Update the checkbox
    if let Some(items) = app.try_state::<Mutex<TrayMenuItems>>() {
        let items = lock_or_recover(&items);
        let _ = items.auto_start_login.set_checked(!currently_enabled);
    }
}

fn handle_toggle_auto_start(app: &tauri::AppHandle) {
    if let Some(settings_state) = app.try_state::<Mutex<DesktopSettings>>() {
        let mut settings = lock_or_recover(&settings_state);
        settings.auto_start_server = !settings.auto_start_server;
        let _ = settings.save();

        if let Some(items) = app.try_state::<Mutex<TrayMenuItems>>() {
            let items = lock_or_recover(&items);
            let _ = items
                .auto_start_server
                .set_checked(settings.auto_start_server);
        }
    }
}

fn handle_set_tunnel_mode(app: &tauri::AppHandle, mode: &str) {
    // Validate cloudflared for tunnel modes
    if mode != "none" && !ServerManager::check_cloudflared() {
        send_notification(
            app,
            "Tunnel Unavailable",
            &format!("cloudflared not found. Install with: {}", cloudflared_install_hint()),
        );
        // Revert the checkbox to current mode
        let current = app
            .try_state::<Mutex<DesktopSettings>>()
            .map(|s| lock_or_recover(&s).tunnel_mode.clone())
            .unwrap_or_else(|| "quick".to_string());
        if let Some(items) = app.try_state::<Mutex<TrayMenuItems>>() {
            let items = lock_or_recover(&items);
            let _ = items.tunnel_quick.set_checked(current == "quick");
            let _ = items.tunnel_named.set_checked(current == "named");
            let _ = items.tunnel_none.set_checked(current == "none");
        }
        // #4942 — also revert the app-menu radios so a click on either
        // surface leaves both consistent when cloudflared is missing.
        #[cfg(target_os = "macos")]
        if let Some(items) = app.try_state::<Mutex<AppMenuItems>>() {
            let items = lock_or_recover(&items);
            let _ = items.tunnel_quick.set_checked(current == "quick");
            let _ = items.tunnel_named.set_checked(current == "named");
            let _ = items.tunnel_none.set_checked(current == "none");
        }
        return;
    }

    // Update settings
    if let Some(settings_state) = app.try_state::<Mutex<DesktopSettings>>() {
        let mut settings = lock_or_recover(&settings_state);
        settings.tunnel_mode = mode.to_string();
        let _ = settings.save();
    }

    // Update checkboxes (radio-style: only one checked at a time)
    if let Some(items) = app.try_state::<Mutex<TrayMenuItems>>() {
        let items = lock_or_recover(&items);
        let _ = items.tunnel_quick.set_checked(mode == "quick");
        let _ = items.tunnel_named.set_checked(mode == "named");
        let _ = items.tunnel_none.set_checked(mode == "none");
    }
    // #4942 — keep the app-menu Tunnel radios in lockstep with the tray
    // radios so toggling from either surface updates the other.
    #[cfg(target_os = "macos")]
    if let Some(items) = app.try_state::<Mutex<AppMenuItems>>() {
        let items = lock_or_recover(&items);
        let _ = items.tunnel_quick.set_checked(mode == "quick");
        let _ = items.tunnel_named.set_checked(mode == "named");
        let _ = items.tunnel_none.set_checked(mode == "none");
    }

    send_notification(
        app,
        "Tunnel Mode Changed",
        &format!(
            "Restart server for {} mode to take effect.",
            match mode {
                "quick" => "Quick Tunnel",
                "named" => "Named Tunnel",
                "none" => "Local Only",
                _ => mode,
            }
        ),
    );
}

/// #4942 — Open `~/.chroxy/` in Finder so the user can inspect server
/// config / logs without leaving the app. macOS-only: gated alongside
/// the app-menu Shell submenu (which is only built on macOS today).
#[cfg(target_os = "macos")]
fn handle_open_config_in_finder(app: &tauri::AppHandle) {
    let Some(config_path) = config::config_path() else {
        send_notification(
            app,
            "Open in Finder",
            "Could not determine ~/.chroxy/ location.",
        );
        return;
    };
    // Reveal the parent directory, not the file itself; on first run
    // the config file may not exist yet but the directory should.
    let target = match config_path.parent() {
        Some(p) => p.to_path_buf(),
        None => config_path.clone(),
    };
    if !target.exists() {
        let _ = std::fs::create_dir_all(&target);
    }
    let _ = std::process::Command::new("open").arg(&target).spawn();
}

/// #4942 — Open an arbitrary URL in the user's default browser. Used
/// by the Help submenu (Documentation / Report Issue). We avoid pulling
/// in `tauri-plugin-opener` and instead shell out to `open(1)` — keeps
/// the new surface footprint zero new dependencies / zero new tauri
/// commands. macOS-only.
#[cfg(target_os = "macos")]
fn handle_open_url(_app: &tauri::AppHandle, url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}

/// #4942 — Window > Bring All to Front. Iterates every Tauri webview
/// window (today: `main`, plus `qr_popup` when `handle_show_qr` has
/// opened it) and brings each one forward. macOS classically defines
/// "Bring All to Front" as "raise all of the application's windows
/// above other apps' windows" — `window::show_window` alone only
/// targets `main`, so the QR popup would stay hidden behind the active
/// app. We also call `set_focus()` after the iteration to ensure the
/// main window ends up the key window. macOS-only.
#[cfg(target_os = "macos")]
fn handle_bring_all_to_front(app: &tauri::AppHandle) {
    use tauri::Manager;
    for (_label, win) in app.webview_windows() {
        let _ = win.show();
        let _ = win.set_focus();
    }
    // Land focus on `main` last so the user keeps interacting with the
    // dashboard rather than a secondary window like `qr_popup`.
    window::show_window(app);
}

fn handle_check_updates(app: &tauri::AppHandle) {
    /// Guard to prevent concurrent update checks.
    static UPDATE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

    // Atomically set the flag; bail if already in flight.
    if UPDATE_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    // Disable the menu item while the check runs.
    if let Some(items) = app.try_state::<Mutex<TrayMenuItems>>() {
        let items = lock_or_recover(&items);
        let _ = items.check_updates.set_enabled(false);
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Ensure guard is cleared and menu re-enabled on every exit path.
        struct ResetGuard<'a>(&'a AtomicBool, tauri::AppHandle);
        impl Drop for ResetGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
                if let Some(items) = self.1.try_state::<Mutex<TrayMenuItems>>() {
                    let items = lock_or_recover(&items);
                    let _ = items.check_updates.set_enabled(true);
                }
            }
        }
        let _guard = ResetGuard(&UPDATE_IN_FLIGHT, app_handle.clone());

        use tauri_plugin_updater::UpdaterExt;
        let updater = match app_handle.updater() {
            Ok(u) => u,
            Err(e) => {
                send_notification(&app_handle, "Update Check Failed", &format!("{}", e));
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                send_notification(
                    &app_handle,
                    "Update Available",
                    &format!("Chroxy {} is available. Downloading...", version),
                );
                // Don't emit update_available here — user already initiated via tray menu.
                // The silent startup check emits it for passive dashboard notification.

                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        send_notification(
                            &app_handle,
                            "Update Installed",
                            &format!("Chroxy {} installed. Restart to apply.", version),
                        );
                        let _ = app_handle.emit("update_installed", &version);
                    }
                    Err(e) => {
                        send_notification(
                            &app_handle,
                            "Update Failed",
                            &format!("Download failed: {}", e),
                        );
                    }
                }
            }
            Ok(None) => {
                send_notification(
                    &app_handle,
                    "No Updates",
                    "You're running the latest version.",
                );
            }
            Err(e) => {
                send_notification(
                    &app_handle,
                    "Update Check Failed",
                    &format!("Could not check for updates: {}", e),
                );
            }
        }
    });
}

fn send_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    if let Some(settings) = app.try_state::<Mutex<DesktopSettings>>() {
        if !lock_or_recover(&settings).show_notifications {
            return;
        }
    }

    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    /// Reads `allowAutoPermissionMode` from a config path. Mirrors the
    /// non-IPC half of `get_allow_auto_permission_mode` for testing.
    fn read_flag(path: &std::path::Path) -> bool {
        if !path.exists() {
            return false;
        }
        let contents = std::fs::read_to_string(path).expect("read config");
        let cfg: serde_json::Value = serde_json::from_str(&contents).expect("parse json");
        cfg.get("allowAutoPermissionMode")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    // #6015 — startup-mode decision: auto-start+token launches our own server;
    // auto-start without a token does nothing (pairing mints one); auto-start
    // OFF means act as a client and adopt an external server.
    #[test]
    fn startup_action_maps_each_mode() {
        assert_eq!(startup_action(true, true), StartupAction::StartOwn);
        assert_eq!(startup_action(true, false), StartupAction::Skip);
        assert_eq!(startup_action(false, true), StartupAction::AdoptExternal);
        assert_eq!(startup_action(false, false), StartupAction::AdoptExternal);
    }

    // #6015 (security) — only a real chroxy /health body is adoptable; a 200
    // from an unrelated local service squatting on the port must NOT be adopted
    // (we'd otherwise navigate the token to it).
    #[test]
    fn is_chroxy_health_fingerprint() {
        assert!(is_chroxy_health(r#"{"status":"ok","mode":"cli","version":"0.9.46"}"#));
        // Wrong/foreign shapes — reject.
        assert!(!is_chroxy_health(r#"{"status":"ok"}"#)); // no version
        assert!(!is_chroxy_health(r#"{"status":"healthy","version":"1.0"}"#)); // not chroxy's "ok"
        assert!(!is_chroxy_health(r#"{"version":"1.0"}"#)); // no status
        assert!(!is_chroxy_health("OK")); // not JSON (e.g. another service)
        assert!(!is_chroxy_health("")); // empty
        assert!(!is_chroxy_health(r#"{"status":"ok","version":200}"#)); // version not a string
    }

    #[test]
    fn writes_flag_to_new_config_file_with_0o600() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");

        set_allow_auto_permission_mode_at(&path, true).unwrap();

        assert!(path.exists());
        assert!(read_flag(&path));

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "Expected 0o600, got {:o}", mode);
    }

    #[test]
    fn preserves_other_keys_when_updating_flag() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"apiToken":"tok-123","port":9999,"tunnel":"named"}"#,
        )
        .unwrap();

        set_allow_auto_permission_mode_at(&path, true).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        let cfg: serde_json::Value = serde_json::from_str(&contents).unwrap();
        assert_eq!(cfg["apiToken"], "tok-123");
        assert_eq!(cfg["port"], 9999);
        assert_eq!(cfg["tunnel"], "named");
        assert_eq!(cfg["allowAutoPermissionMode"], true);
    }

    #[test]
    fn round_trips_off_to_on_to_off() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"port":8765}"#).unwrap();

        set_allow_auto_permission_mode_at(&path, true).unwrap();
        assert!(read_flag(&path));

        set_allow_auto_permission_mode_at(&path, false).unwrap();
        assert!(!read_flag(&path));

        // Other keys still present
        let contents = std::fs::read_to_string(&path).unwrap();
        let cfg: serde_json::Value = serde_json::from_str(&contents).unwrap();
        assert_eq!(cfg["port"], 8765);
    }

    #[test]
    fn creates_parent_directory_when_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested/dir/config.json");

        set_allow_auto_permission_mode_at(&path, true).unwrap();

        assert!(path.exists());
        assert!(read_flag(&path));
    }

    #[test]
    fn rejects_non_object_config() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "[1,2,3]").unwrap();

        let err = set_allow_auto_permission_mode_at(&path, true).unwrap_err();
        assert!(err.contains("not a JSON object"), "got: {}", err);
    }

    #[test]
    fn handles_empty_file_as_empty_object() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "").unwrap();

        set_allow_auto_permission_mode_at(&path, true).unwrap();
        assert!(read_flag(&path));
    }
}

