use tauri::{AppHandle, Emitter, Manager};
use serde::Serialize;

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

// -- Tauri event payloads --

#[derive(Clone, Serialize)]
pub struct ServerReadyPayload {
    pub port: u16,
    pub token: String,
    pub url: String,
}

#[derive(Clone, Serialize)]
pub struct ServerErrorPayload {
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct ServerRestartingPayload {
    pub attempt: u32,
    pub max_attempts: u32,
    pub backoff_secs: u64,
}

// -- Event emission (replaces eval-based injection) --

/// Emit `server_ready` event with dashboard URL payload.
/// The loading page JS listens and navigates to the URL.
pub fn emit_server_ready(app: &AppHandle, port: u16, token: Option<&str>) {
    let url = dashboard_url(port, token);
    let payload = ServerReadyPayload {
        port,
        token: token.unwrap_or("").to_string(),
        url,
    };
    let _ = app.emit("server_ready", payload);
    show_window(app);
}

/// Emit `server_stopped` event.
/// React dashboard listens and shows disconnected state.
pub fn emit_server_stopped(app: &AppHandle) {
    let _ = app.emit("server_stopped", ());
    show_window(app);
}

/// Emit `server_error` event with error message.
pub fn emit_server_error(app: &AppHandle, message: &str) {
    let payload = ServerErrorPayload {
        message: message.to_string(),
    };
    let _ = app.emit("server_error", payload);
    show_window(app);
}

/// Emit `server_restarting` event with restart progress.
pub fn emit_server_restarting(app: &AppHandle, attempt: u32, max_attempts: u32, backoff_secs: u64) {
    let payload = ServerRestartingPayload {
        attempt,
        max_attempts,
        backoff_secs,
    };
    let _ = app.emit("server_restarting", payload);
    show_window(app);
}

/// Emit `navigate_console` event.
/// Dashboard listens and switches to console viewMode.
pub fn emit_navigate_console(app: &AppHandle) {
    let _ = app.emit("navigate_console", ());
    show_window(app);
}

// -- Window management (no eval) --

/// Percent-encode HTML for use in a data URI.
/// Encodes characters that are not safe in URIs (spaces, angle brackets, etc.).
pub fn percent_encode_html(html: &str) -> String {
    let mut encoded = String::with_capacity(html.len() * 2);
    for byte in html.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' | b'!' | b'*' | b'\'' | b'(' | b')'
            | b';' | b':' | b'@' | b',' | b'/' | b'?' | b'#' | b'[' | b']'
            | b'=' | b'&' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

/// Show and focus the main window.
pub fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
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

    #[test]
    fn server_ready_payload_serializes() {
        let payload = ServerReadyPayload {
            port: 8765,
            token: "abc".to_string(),
            url: "http://127.0.0.1:8765/dashboard?token=abc".to_string(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["port"], 8765);
        assert_eq!(json["token"], "abc");
        assert!(json["url"].as_str().unwrap().contains("/dashboard"));
    }

    #[test]
    fn server_error_payload_serializes() {
        let payload = ServerErrorPayload {
            message: "something went wrong".to_string(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["message"], "something went wrong");
    }

    #[test]
    fn server_restarting_payload_serializes() {
        let payload = ServerRestartingPayload {
            attempt: 2,
            max_attempts: 3,
            backoff_secs: 6,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["attempt"], 2);
        assert_eq!(json["max_attempts"], 3);
        assert_eq!(json["backoff_secs"], 6);
    }

    #[test]
    fn percent_encode_html_preserves_safe_chars() {
        assert_eq!(percent_encode_html("hello"), "hello");
        assert_eq!(percent_encode_html("/path?key=val"), "/path?key=val");
    }

    #[test]
    fn percent_encode_html_encodes_angle_brackets_and_spaces() {
        let encoded = percent_encode_html("<div>hello world</div>");
        assert!(encoded.contains("%3C"));  // <
        assert!(encoded.contains("%3E"));  // >
        assert!(encoded.contains("%20"));  // space
        assert!(!encoded.contains('<'));
        assert!(!encoded.contains('>'));
    }
}
