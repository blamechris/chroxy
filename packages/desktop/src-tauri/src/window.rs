use tauri::{AppHandle, Manager};

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

/// Open the dashboard in the system default browser.
pub fn open_dashboard(app: &AppHandle, port: u16, token: Option<&str>) {
    let url = match token {
        Some(t) => format!("http://127.0.0.1:{}/dashboard?token={}", port, url_encode(t)),
        None => format!("http://127.0.0.1:{}/dashboard", port),
    };

    use tauri_plugin_shell::ShellExt;
    use tauri_plugin_shell::open::Program;
    let _ = app.shell().open(&url, None::<Program>);
}

/// Show the fallback/loading page with optional port, token, and tunnel mode for health+QR polling.
pub fn show_fallback(app: &AppHandle, port: Option<u16>, token: Option<&str>, tunnel_mode: Option<&str>) {
    // Hide dashboard if open
    if let Some(dash) = app.get_webview_window(DASHBOARD_LABEL) {
        let _ = dash.hide();
    }

    if let Some(win) = app.get_webview_window(FALLBACK_LABEL) {
        // Inject port/token/tunnelMode and trigger health polling via JS eval
        if let Some(p) = port {
            let t = token.unwrap_or("");
            let tm = tunnel_mode.unwrap_or("none");
            // Escape token for safe JS string interpolation (defense-in-depth)
            let escaped = t
                .replace('\\', "\\\\")
                .replace('\'', "\\'")
                .replace('\n', "\\n")
                .replace('\r', "\\r");
            let _ = win.eval(&format!(
                "if (typeof window.__startPolling === 'function') {{ window.__startPolling({}, '{}', '{}'); }}",
                p, escaped, tm
            ));
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Toggle fallback window visibility (for tray left-click).
pub fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(FALLBACK_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    } else {
        show_fallback(app, None, None, None);
    }
}
