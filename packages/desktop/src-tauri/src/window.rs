use tauri::{AppHandle, Manager};

const MAIN_LABEL: &str = "main";

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

/// Build the dashboard URL for the given port and optional token.
pub fn dashboard_url(port: u16, token: Option<&str>) -> String {
    match token {
        Some(t) => format!("http://127.0.0.1:{}/dashboard?token={}", port, url_encode(t)),
        None => format!("http://127.0.0.1:{}/dashboard", port),
    }
}

/// Navigate the main window to the dashboard URL.
pub fn navigate_to_dashboard(app: &AppHandle, port: u16, token: Option<&str>) {
    let url = dashboard_url(port, token);
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let _ = win.eval(&format!("window.location.href = '{}';", url));
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Navigate the main window back to the bundled loading page and show it.
/// Used after server stop, crash, or when server is not yet running.
pub fn show_loading(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let _ = win.eval("window.location.href = 'tauri://localhost';");
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Toggle main window visibility (for tray left-click).
pub fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_leaves_unreserved_chars() {
        assert_eq!(url_encode("hello"), "hello");
        assert_eq!(url_encode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn url_encode_encodes_special_chars() {
        assert_eq!(url_encode("a b"), "a%20b");
        assert_eq!(url_encode("a+b"), "a%2Bb");
        assert_eq!(url_encode("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn dashboard_url_without_token() {
        let url = dashboard_url(8765, None);
        assert_eq!(url, "http://127.0.0.1:8765/dashboard");
    }

    #[test]
    fn dashboard_url_with_token() {
        let url = dashboard_url(8765, Some("abc-123"));
        assert_eq!(url, "http://127.0.0.1:8765/dashboard?token=abc-123");
    }

    #[test]
    fn dashboard_url_encodes_token_special_chars() {
        let url = dashboard_url(9000, Some("key with spaces&more"));
        assert!(url.contains("key%20with%20spaces%26more"));
    }
}
