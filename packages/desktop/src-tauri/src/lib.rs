mod config;
mod node;
mod platform;
mod qrcode;
mod server;
mod settings;
mod setup;
#[cfg(target_os = "macos")]
mod speech;
mod window;

use server::{ServerManager, ServerStatus};
use settings::DesktopSettings;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

/// Lock a Mutex, recovering from poisoning instead of panicking.
pub(crate) fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    Emitter,
    Manager,
};
#[cfg(desktop)]
use tauri_plugin_single_instance::init as single_instance_init;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

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


// ── Tauri IPC commands ──────────────────────────────────────────────

#[tauri::command]
fn get_server_info(state: tauri::State<'_, Mutex<ServerManager>>) -> Result<serde_json::Value, String> {
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

#[tauri::command]
fn get_qr_code_svg(state: tauri::State<'_, Mutex<ServerManager>>) -> Result<serde_json::Value, String> {
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
    let claude_result = std::process::Command::new(which_cmd)
        .arg("claude")
        .output();
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
fn save_setup_config(
    app: tauri::AppHandle,
    port: u16,
    tunnel_mode: String,
) -> Result<(), String> {
    // Update settings
    if let Some(settings_state) = app.try_state::<Mutex<DesktopSettings>>() {
        let mut settings = lock_or_recover(&settings_state);
        settings.tunnel_mode = tunnel_mode.clone();
        settings.save().map_err(|e| format!("Failed to save settings: {}", e))?;
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
async fn pick_directory(app: tauri::AppHandle, default_path: Option<String>) -> Result<Option<String>, String> {
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

/// Reject an IPC call that did not originate from the `main` window.
///
/// Voice commands interact with the system microphone. Restricting them to the
/// main window prevents a compromised `dashboard` or `qr_popup` window from
/// silently starting a recording after the initial microphone permission has
/// been granted by the user.
fn require_main_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("voice commands are restricted to the main window".into());
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

pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(single_instance_init(|app: &tauri::AppHandle, _args, _cwd| {
            // Second instance launched: focus the existing main window.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }));
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
        .invoke_handler(tauri::generate_handler![
            get_server_info,
            get_server_logs,
            start_server,
            stop_server,
            restart_server,
            get_qr_code_svg,
            pick_directory,
            check_dependencies,
            get_setup_state,
            save_setup_config,
            #[cfg(target_os = "macos")]
            voice_available,
            #[cfg(target_os = "macos")]
            start_voice_input,
            #[cfg(target_os = "macos")]
            stop_voice_input,
        ])
        .manage(Mutex::new(ServerManager::new()))
        .manage(Mutex::new(DesktopSettings::load()))
        .manage({
            #[cfg(target_os = "macos")]
            { Mutex::new(speech::SpeechState::new()) }
            #[cfg(not(target_os = "macos"))]
            { Mutex::new(()) }
        })
        .setup(|app| {
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
                        ns_win.setCollectionBehavior_(behavior);
                    }
                }
            }

            setup_tray(app)?;

            // Auto-start server on launch if configured (skip on first run — wizard handles it)
            if !is_first_run {
                let settings = app.state::<Mutex<DesktopSettings>>();
                let auto_start = lock_or_recover(&settings).auto_start_server;
                if auto_start {
                    let config = config::load_config();
                    if config.api_token.is_some() {
                        handle_start(app.handle());
                    }
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
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
    let autostart_enabled = app
        .autolaunch()
        .is_enabled()
        .unwrap_or(false);
    let auto_start_login =
        CheckMenuItemBuilder::with_id("auto_start_login", "Start at Login")
            .checked(autostart_enabled)
            .build(app)?;

    let settings = app.state::<Mutex<DesktopSettings>>();
    let settings_guard = lock_or_recover(&settings);
    let auto_start_server_checked = settings_guard.auto_start_server;
    let current_tunnel = settings_guard.tunnel_mode.clone();
    drop(settings_guard);

    let auto_start_server =
        CheckMenuItemBuilder::with_id("auto_start_server", "Auto-start Server")
            .checked(auto_start_server_checked)
            .build(app)?;

    // Tunnel mode submenu
    let tunnel_quick =
        CheckMenuItemBuilder::with_id("tunnel_quick", "Quick Tunnel")
            .checked(current_tunnel == "quick")
            .build(app)?;
    let tunnel_named =
        CheckMenuItemBuilder::with_id("tunnel_named", "Named Tunnel")
            .checked(current_tunnel == "named")
            .build(app)?;
    let tunnel_none =
        CheckMenuItemBuilder::with_id("tunnel_none", "Local Only")
            .checked(current_tunnel == "none")
            .build(app)?;

    let tunnel_submenu = SubmenuBuilder::with_id(app, "tunnel_mode", "Tunnel Mode")
        .item(&tunnel_quick)
        .item(&tunnel_named)
        .item(&tunnel_none)
        .build()?;

    let check_updates = MenuItemBuilder::with_id("check_updates", "Check for Updates").build(app)?;

    let quit = MenuItemBuilder::with_id("quit", "Quit Chroxy").build(app)?;

    let menu = MenuBuilder::new(app)
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
    let img = image::load_from_memory(icon_bytes).expect("decode tray icon").to_rgba8();
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
    let timeout_msg = format!(
        "Server failed to {} within 60 seconds.",
        action
    );

    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let state = app.state::<Mutex<ServerManager>>();
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

fn handle_start(app: &tauri::AppHandle) {
    // Read settings and apply to server manager
    let (tunnel_mode, node_path) = app
        .try_state::<Mutex<DesktopSettings>>()
        .map(|s| {
            let settings = lock_or_recover(&s);
            (settings.tunnel_mode.clone(), settings.node_path.clone())
        })
        .unwrap_or_else(|| ("quick".to_string(), None));

    // Validate cloudflared for tunnel modes
    if tunnel_mode != "none" && !ServerManager::check_cloudflared() {
        send_notification(
            app,
            "Tunnel Unavailable",
            "cloudflared not found. Install with: brew install cloudflared",
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
                                    let recovered = monitor_startup(&app_handle, StartupContext::Restart);
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
                                        let state =
                                            app_handle.state::<Mutex<ServerManager>>();
                                        let mgr = lock_or_recover(&state);
                                        if mgr.restart_count()
                                            < ServerManager::MAX_RESTART_ATTEMPTS
                                        {
                                            mgr.signal_auto_restart();
                                        }
                                    }
                                    // Continue loop — will check for more crashes
                                }
                                Err(_) => {
                                    drop(mgr);
                                    update_menu_state(&app_handle, MenuState::Stopped);
                                    window::emit_server_error(&app_handle, "Auto-restart failed. Use tray menu to restart manually.");
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
            send_notification(app, "QR Code Error", &format!("Failed to encode popup HTML: {}", e));
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
        send_notification(app, "QR Code Error", &format!("Failed to open popup: {}", e));
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
        let _ = items
            .auto_start_login
            .set_checked(!currently_enabled);
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
            "cloudflared not found. Install with: brew install cloudflared",
        );
        // Revert the checkbox to current mode
        if let Some(items) = app.try_state::<Mutex<TrayMenuItems>>() {
            let items = lock_or_recover(&items);
            let current = app
                .try_state::<Mutex<DesktopSettings>>()
                .map(|s| lock_or_recover(&s).tunnel_mode.clone())
                .unwrap_or_else(|| "quick".to_string());
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

    send_notification(
        app,
        "Tunnel Mode Changed",
        &format!("Restart server for {} mode to take effect.", match mode {
            "quick" => "Quick Tunnel",
            "named" => "Named Tunnel",
            "none" => "Local Only",
            _ => mode,
        }),
    );
}

fn handle_check_updates(app: &tauri::AppHandle) {
    /// Guard to prevent concurrent update checks.
    static UPDATE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

    // Atomically set the flag; bail if already in flight.
    if UPDATE_IN_FLIGHT.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
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
                send_notification(&app_handle, "No Updates", "You're running the latest version.");
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
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}
