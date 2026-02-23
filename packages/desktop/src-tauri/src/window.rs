use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const DASHBOARD_LABEL: &str = "dashboard";
const FALLBACK_LABEL: &str = "main";

/// Percent-encode a string for safe use in URL query values.
/// Encodes everything except unreserved characters (RFC 3986: A-Z a-z 0-9 - _ . ~).
fn url_encode(s: &str) -> String {
    let mut encoded = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

/// Open (or focus) the dashboard window pointing at the local server.
pub fn open_dashboard(app: &AppHandle, port: u16, token: Option<&str>) {
    let url = match token {
        Some(t) => format!("http://localhost:{}/dashboard?token={}", port, url_encode(t)),
        None => format!("http://localhost:{}/dashboard", port),
    };

    // If dashboard window already exists, navigate and show it
    if let Some(win) = app.get_webview_window(DASHBOARD_LABEL) {
        let _ = win.navigate(url.parse().unwrap());
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    // Hide fallback window if visible
    if let Some(fallback) = app.get_webview_window(FALLBACK_LABEL) {
        let _ = fallback.hide();
    }

    // Create new dashboard window
    let builder = WebviewWindowBuilder::new(
        app,
        DASHBOARD_LABEL,
        WebviewUrl::External(url.parse().unwrap()),
    )
    .title("Chroxy Dashboard")
    .inner_size(900.0, 700.0)
    .center();

    if let Ok(win) = builder.build() {
        // Close hides instead of destroying
        let app_handle = app.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(w) = app_handle.get_webview_window(DASHBOARD_LABEL) {
                    let _ = w.hide();
                }
            }
        });
    }
}

/// Show the fallback "server not running" page.
pub fn show_fallback(app: &AppHandle) {
    // Hide dashboard if open
    if let Some(dash) = app.get_webview_window(DASHBOARD_LABEL) {
        let _ = dash.hide();
    }

    if let Some(win) = app.get_webview_window(FALLBACK_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Toggle window visibility (for tray left-click).
pub fn toggle_window(app: &AppHandle, server_running: bool) {
    let label = if server_running {
        DASHBOARD_LABEL
    } else {
        FALLBACK_LABEL
    };

    if let Some(win) = app.get_webview_window(label) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    } else if server_running {
        // Dashboard window doesn't exist yet — will be created via handle_dashboard
    } else {
        show_fallback(app);
    }
}
