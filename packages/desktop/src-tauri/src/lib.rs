mod config;
mod node;
mod platform;
mod server;
mod settings;
mod setup;
mod window;

use server::{ServerManager, ServerStatus};
use settings::DesktopSettings;
use std::sync::{Mutex, MutexGuard};

/// Lock a Mutex, recovering from poisoning instead of panicking.
pub(crate) fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    Manager,
};
#[cfg(desktop)]
use tauri_plugin_single_instance::init as single_instance_init;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// Menu item handles so we can enable/disable them from anywhere.
struct TrayMenuItems {
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    dashboard: MenuItem<tauri::Wry>,
    auto_start_login: CheckMenuItem<tauri::Wry>,
    auto_start_server: CheckMenuItem<tauri::Wry>,
    tunnel_quick: CheckMenuItem<tauri::Wry>,
    tunnel_named: CheckMenuItem<tauri::Wry>,
    tunnel_none: CheckMenuItem<tauri::Wry>,
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
        .invoke_handler(tauri::generate_handler![])
        .manage(Mutex::new(ServerManager::new()))
        .manage(Mutex::new(DesktopSettings::load()))
        .setup(|app| {
            // First-run: generate config if needed
            setup::ensure_config();

            setup_tray(app)?;

            // Auto-start server on launch if configured
            let settings = app.state::<Mutex<DesktopSettings>>();
            let auto_start = lock_or_recover(&settings).auto_start_server;
            if auto_start {
                let config = config::load_config();
                if config.api_token.is_some() {
                    handle_start(app.handle());
                }
            }

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

    let quit = MenuItemBuilder::with_id("quit", "Quit Chroxy").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&start, &stop, &restart])
        .separator()
        .items(&[&dashboard])
        .separator()
        .item(&auto_start_login)
        .item(&auto_start_server)
        .item(&tunnel_submenu)
        .separator()
        .items(&[&quit])
        .build()?;

    app.manage(Mutex::new(TrayMenuItems {
        start: start.clone(),
        stop: stop.clone(),
        restart: restart.clone(),
        dashboard: dashboard.clone(),
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
                "auto_start_login" => handle_toggle_login(app),
                "auto_start_server" => handle_toggle_auto_start(app),
                "tunnel_quick" => handle_set_tunnel_mode(app, "quick"),
                "tunnel_named" => handle_set_tunnel_mode(app, "named"),
                "tunnel_none" => handle_set_tunnel_mode(app, "none"),
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

fn update_menu_state(app: &tauri::AppHandle, running: bool) {
    if let Some(items) = app.try_state::<Mutex<TrayMenuItems>>() {
        let items = lock_or_recover(&items);
        let _ = items.start.set_enabled(!running);
        let _ = items.stop.set_enabled(running);
        let _ = items.restart.set_enabled(running);
        let _ = items.dashboard.set_enabled(running);
    }
}

fn handle_start(app: &tauri::AppHandle) {
    // Read tunnel mode from settings and apply to server manager
    let tunnel_mode = app
        .try_state::<Mutex<DesktopSettings>>()
        .map(|s| lock_or_recover(&s).tunnel_mode.clone())
        .unwrap_or_else(|| "quick".to_string());

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
        mgr.start()
    };

    match result {
        Ok(()) => {
            update_menu_state(app, true);

            // Show window immediately (loading page listens for server_ready event)
            window::show_window(app);

            let app_handle = app.clone();
            std::thread::spawn(move || {
                // Phase 1: Wait for initial startup (up to 60s)
                let mut reached_running = false;
                for _ in 0..60 {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let state = app_handle.state::<Mutex<ServerManager>>();
                    let status = lock_or_recover(&state).status();
                    match status {
                        ServerStatus::Running => {
                            update_menu_state(&app_handle, true);
                            // Emit server_ready — loading page navigates to dashboard
                            let state = app_handle.state::<Mutex<ServerManager>>();
                            let mgr = lock_or_recover(&state);
                            let p = mgr.port();
                            let t = mgr.token();
                            drop(mgr);
                            window::emit_server_ready(&app_handle, p, t.as_deref());
                            reached_running = true;
                            break;
                        }
                        ServerStatus::Error(ref msg) => {
                            update_menu_state(&app_handle, false);
                            send_notification(&app_handle, "Server Error", msg);
                            return;
                        }
                        _ => {}
                    }
                }

                if !reached_running {
                    return; // Startup timeout
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
                            update_menu_state(&app_handle, false);
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
                                    let mut recovered = false;
                                    for _ in 0..60 {
                                        std::thread::sleep(
                                            std::time::Duration::from_secs(1),
                                        );
                                        let state =
                                            app_handle.state::<Mutex<ServerManager>>();
                                        let status = lock_or_recover(&state).status();
                                        match status {
                                            ServerStatus::Running => {
                                                update_menu_state(&app_handle, true);
                                                // Emit server_ready — dashboard reconnects
                                                let state = app_handle.state::<Mutex<ServerManager>>();
                                                let mgr = lock_or_recover(&state);
                                                let p = mgr.port();
                                                let t = mgr.token();
                                                drop(mgr);
                                                window::emit_server_ready(&app_handle, p, t.as_deref());
                                                send_notification(
                                                    &app_handle,
                                                    "Server Recovered",
                                                    "Auto-restart successful",
                                                );
                                                // Reset restart count after recovery notification
                                                let state = app_handle.state::<Mutex<ServerManager>>();
                                                lock_or_recover(&state).reset_restart_count();
                                                recovered = true;
                                                break;
                                            }
                                            ServerStatus::Error(_) => break,
                                            _ => {}
                                        }
                                    }
                                    // If recovery failed but we haven't hit max
                                    // attempts, re-signal pending so the outer loop
                                    // retries instead of exiting at Error(_).
                                    if !recovered {
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
                                    update_menu_state(&app_handle, false);
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
            update_menu_state(app, false);
            send_notification(app, "Server Error", &e);
        }
    }
}

fn handle_stop(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let mut mgr = lock_or_recover(&state);
    mgr.stop();
    drop(mgr);
    update_menu_state(app, false);
    window::emit_server_stopped(app);
}

fn handle_restart(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let result = {
        let mut mgr = lock_or_recover(&state);
        mgr.restart()
    };

    match result {
        Ok(()) => update_menu_state(app, true),
        Err(e) => {
            eprintln!("[tray] Failed to restart server: {}", e);
            update_menu_state(app, false);
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
