mod config;
mod node;
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
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// Menu item handles so we can enable/disable them from anywhere.
struct TrayMenuItems {
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    dashboard: MenuItem<tauri::Wry>,
    auto_start_login: CheckMenuItem<tauri::Wry>,
    auto_start_server: CheckMenuItem<tauri::Wry>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
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
    let auto_start_server_checked = lock_or_recover(&settings).auto_start_server;
    let auto_start_server =
        CheckMenuItemBuilder::with_id("auto_start_server", "Auto-start Server")
            .checked(auto_start_server_checked)
            .build(app)?;

    let quit = MenuItemBuilder::with_id("quit", "Quit Chroxy").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&start, &stop, &restart])
        .separator()
        .items(&[&dashboard])
        .separator()
        .item(&auto_start_login)
        .item(&auto_start_server)
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
    }));

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
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
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let running = app
                    .try_state::<Mutex<ServerManager>>()
                    .map(|s| lock_or_recover(&s).is_running())
                    .unwrap_or(false);

                if running {
                    let port;
                    let token;
                    {
                        let mgr = app.state::<Mutex<ServerManager>>();
                        let mgr = lock_or_recover(&mgr);
                        port = mgr.port();
                        token = mgr.token();
                    }
                    if app.get_webview_window("dashboard").is_some() {
                        window::toggle_window(app, true);
                    } else {
                        window::open_dashboard(app, port, token.as_deref());
                    }
                } else {
                    window::toggle_window(app, false);
                }
            }
        })
        .build(app)?;

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
    let state = app.state::<Mutex<ServerManager>>();
    let result = {
        let mut mgr = lock_or_recover(&state);
        mgr.start()
    };

    match result {
        Ok(()) => {
            update_menu_state(app, true);
            let app_handle = app.clone();
            std::thread::spawn(move || {
                for _ in 0..60 {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let state = app_handle.state::<Mutex<ServerManager>>();
                    let status = lock_or_recover(&state).status();
                    match status {
                        ServerStatus::Running => {
                            update_menu_state(&app_handle, true);
                            return;
                        }
                        ServerStatus::Error(ref msg) => {
                            update_menu_state(&app_handle, false);
                            send_notification(&app_handle, "Server Error", msg);
                            return;
                        }
                        _ => {}
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
    window::show_fallback(app);
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
        window::show_fallback(app);
        return;
    }

    let port = mgr.port();
    let token = mgr.token();
    drop(mgr);

    window::open_dashboard(app, port, token.as_deref());
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
