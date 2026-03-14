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

/// Update the loading page status text, then navigate to the dashboard after a brief delay.
/// Tauri v2's CSP nonce blocks both inline and external scripts in the embedded frontend,
/// so we inject status updates via eval() (which is nonce-aware) and navigate from Rust.
pub fn emit_server_ready(app: &AppHandle, port: u16, token: Option<&str>) {
    let url = dashboard_url(port, token);
    let payload = ServerReadyPayload {
        port,
        token: token.unwrap_or("").to_string(),
        url: url.clone(),
    };
    let _ = app.emit("server_ready", payload);
    show_window(app);

    // Update loading page status to "Connected!" then navigate after 800ms
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.eval(
            "try { \
                var s = document.getElementById('status'); \
                if (s) { s.textContent = 'Connected!'; s.className = 'status'; } \
                var sp = document.getElementById('spinner'); \
                if (sp) sp.style.display = 'none'; \
            } catch(e) {}"
        );
    }

    // Navigate to dashboard after a brief pause so user sees "Connected!"
    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        if let Some(window) = app_handle.get_webview_window(MAIN_LABEL) {
            // Use eval to navigate — window.navigate() from tauri:// to http://
            // may be blocked by same-origin policy in the embedded webview.
            let escaped = url.replace('\\', "\\\\").replace('\'', "\\'");
            let _ = window.eval(&format!("window.location.href = '{}'", escaped));
        }
    });
}

/// Emit `server_stopped` event and update loading page if visible.
pub fn emit_server_stopped(app: &AppHandle) {
    let _ = app.emit("server_stopped", ());
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.eval(
            "try { \
                var s = document.getElementById('status'); \
                if (s) { s.textContent = 'Server stopped'; s.className = 'status'; } \
                var sp = document.getElementById('spinner'); \
                if (sp) sp.style.display = 'none'; \
            } catch(e) {}"
        );
    }
    show_window(app);
}

/// Emit `server_error` event and update loading page if visible.
pub fn emit_server_error(app: &AppHandle, message: &str) {
    let payload = ServerErrorPayload {
        message: message.to_string(),
    };
    let _ = app.emit("server_error", payload);
    let escaped = message.replace('\\', "\\\\").replace('\'', "\\'");
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.eval(&format!(
            "try {{ \
                var s = document.getElementById('status'); \
                if (s) {{ s.textContent = '{}'; s.className = 'status error'; }} \
                var sp = document.getElementById('spinner'); \
                if (sp) sp.style.display = 'none'; \
            }} catch(e) {{}}",
            escaped
        ));
    }
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

/// Inject click handler for the settings button on the loading page.
/// Navigates directly to the dashboard settings panel when clicked.
pub fn inject_settings_button_handler(app: &AppHandle, port: u16, token: Option<&str>) {
    let url = dashboard_url(port, token);
    // Append settings query param so dashboard auto-opens settings panel
    let settings_url = if url.contains('?') {
        format!("{}&settings=1", url)
    } else {
        format!("{}?settings=1", url)
    };
    let escaped = settings_url.replace('\\', "\\\\").replace('\'', "\\'");
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.eval(&format!(
            "try {{ \
                var btn = document.getElementById('settings-btn'); \
                if (btn) btn.addEventListener('click', function() {{ \
                    window.location.href = '{}'; \
                }}); \
            }} catch(e) {{}}",
            escaped
        ));
    }
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
            | b';' | b':' | b'@' | b',' | b'/'
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
        assert_eq!(percent_encode_html("/path=val&k=v"), "/path=val&k=v");
        assert_eq!(percent_encode_html("a-b_c.d~e"), "a-b_c.d~e");
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

    #[test]
    fn percent_encode_html_encodes_hash_and_question_mark() {
        // # and ? are URI-reserved and must be encoded in data URI bodies
        let encoded = percent_encode_html("color: #ff0000; url?token=abc");
        assert!(encoded.contains("%23"), "# must be percent-encoded");
        assert!(encoded.contains("%3F"), "? must be percent-encoded");
        assert!(!encoded.contains('#'), "literal # must not appear");
        assert!(!encoded.contains('?'), "literal ? must not appear");
    }

    #[test]
    fn percent_encode_html_encodes_brackets() {
        let encoded = percent_encode_html("arr[0]");
        assert!(encoded.contains("%5B"), "[ must be percent-encoded");
        assert!(encoded.contains("%5D"), "] must be percent-encoded");
    }
}
