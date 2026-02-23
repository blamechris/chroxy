mod config;
mod node;
mod server;
mod window;

use server::ServerManager;
use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItem, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Menu item handles so we can enable/disable them from anywhere.
struct TrayMenuItems {
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    dashboard: MenuItem<tauri::Wry>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(ServerManager::new()))
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
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
    let quit = MenuItemBuilder::with_id("quit", "Quit Chroxy").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&start, &stop, &restart])
        .separator()
        .items(&[&dashboard])
        .separator()
        .items(&[&quit])
        .build()?;

    // Store menu item handles for enable/disable
    app.manage(Mutex::new(TrayMenuItems {
        start: start.clone(),
        stop: stop.clone(),
        restart: restart.clone(),
        dashboard: dashboard.clone(),
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
                "quit" => {
                    if let Some(mgr) = app.try_state::<Mutex<ServerManager>>() {
                        let mut mgr = mgr.lock().unwrap();
                        mgr.stop();
                    }
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click toggles window visibility
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let running = app
                    .try_state::<Mutex<ServerManager>>()
                    .map(|s| s.lock().unwrap().is_running())
                    .unwrap_or(false);

                if running {
                    let port;
                    let token;
                    {
                        let mgr = app.state::<Mutex<ServerManager>>();
                        let mgr = mgr.lock().unwrap();
                        port = mgr.port();
                        token = mgr.token();
                    }
                    // Check if dashboard window exists and toggle, or create it
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
        let items = items.lock().unwrap();
        let _ = items.start.set_enabled(!running);
        let _ = items.stop.set_enabled(running);
        let _ = items.restart.set_enabled(running);
        let _ = items.dashboard.set_enabled(running);
    }
}

fn handle_start(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let result = {
        let mut mgr = state.lock().unwrap();
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
                    let mgr = state.lock().unwrap();
                    if mgr.is_running() {
                        update_menu_state(&app_handle, true);
                        return;
                    }
                    if matches!(mgr.status(), server::ServerStatus::Error(_)) {
                        update_menu_state(&app_handle, false);
                        return;
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("[tray] Failed to start server: {}", e);
            update_menu_state(app, false);
        }
    }
}

fn handle_stop(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let mut mgr = state.lock().unwrap();
    mgr.stop();
    drop(mgr);
    update_menu_state(app, false);
    // Show fallback page if window is visible
    window::show_fallback(app);
}

fn handle_restart(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let result = {
        let mut mgr = state.lock().unwrap();
        mgr.restart()
    };

    match result {
        Ok(()) => update_menu_state(app, true),
        Err(e) => {
            eprintln!("[tray] Failed to restart server: {}", e);
            update_menu_state(app, false);
        }
    }
}

fn handle_dashboard(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<ServerManager>>();
    let mgr = state.lock().unwrap();
    if !mgr.is_running() {
        window::show_fallback(app);
        return;
    }

    let port = mgr.port();
    let token = mgr.token();
    drop(mgr);

    window::open_dashboard(app, port, token.as_deref());
}
