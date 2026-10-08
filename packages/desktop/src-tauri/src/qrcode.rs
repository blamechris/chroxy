use crate::config;
use qrcode::QrCode;

/// Build the chroxy:// connection URL from config.
pub fn build_connection_url(hostname: &str, token: &str) -> String {
    format!("chroxy://{}?token={}", hostname, token)
}

/// Generate a QR code as an SVG string.
pub fn generate_qr_svg(data: &str) -> Result<String, String> {
    let code = QrCode::new(data.as_bytes()).map_err(|e| format!("QR encode error: {}", e))?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(200, 200)
        .dark_color(qrcode::render::svg::Color("#ffffff"))
        .light_color(qrcode::render::svg::Color("#1a1a2e"))
        .quiet_zone(true)
        .build();
    Ok(svg)
}

/// HTML-escape a string for safe interpolation into HTML content.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

/// Build the HTML page for the QR code popup.
pub fn build_qr_popup_html(svg: &str, connection_url: &str) -> String {
    let escaped_url = html_escape(connection_url);
    format!(
        r#"<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{
    margin: 0;
    padding: 20px;
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: calc(100vh - 40px);
    user-select: none;
    -webkit-user-select: none;
  }}
  h2 {{
    margin: 0 0 12px;
    font-size: 16px;
    font-weight: 600;
    color: #b0b0d0;
  }}
  .qr-container {{
    background: #1a1a2e;
    border-radius: 12px;
    padding: 8px;
  }}
  .qr-container svg {{
    display: block;
    width: 220px;
    height: 220px;
  }}
  .url {{
    margin-top: 12px;
    font-size: 11px;
    color: #666;
    word-break: break-all;
    text-align: center;
    max-width: 260px;
  }}
  .hint {{
    margin-top: 8px;
    font-size: 12px;
    color: #888;
  }}
</style>
</head>
<body>
  <h2>Scan to Connect</h2>
  <div class="qr-container">{}</div>
  <div class="url">{}</div>
  <div class="hint">Open the Chroxy app on your phone and scan this code</div>
<script>document.addEventListener('keydown', function(e) {{ if (e.key === 'Escape') window.close(); }});</script>
</body>
</html>"#,
        svg, escaped_url
    )
}

/// Path to `connection.json` inside the daemon's config root.
///
/// Split from [`read_connection_info`] so the path resolution is assertable
/// without touching the filesystem — the regression this guards against is one
/// site drifting back to a hardcoded `~/.chroxy` while the others follow the
/// override, which is invisible unless the paths themselves are compared.
pub fn connection_info_path() -> Option<std::path::PathBuf> {
    crate::config::config_dir().map(|d| d.join("connection.json"))
}

/// Read the connection info from `connection.json` in the daemon's config root
/// (`~/.chroxy/connection.json` with no override).
/// The server writes fields: connectionUrl, wsUrl, httpUrl, apiToken, tunnelMode.
/// Returns (hostname, token) or an error.
///
/// Resolved through `config::config_dir()` so it follows `CHROXY_CONFIG_DIR`
/// (#7241). This is the site with the sharpest failure: the *server* writes
/// `connection.json` into its own (possibly relocated) root, so reading it from a
/// hardcoded `~/.chroxy` hands the user a QR code encoding a stale URL and token
/// — silently, because a stale file still parses.
pub fn read_connection_info() -> Result<(String, String), String> {
    let path = connection_info_path().ok_or("Cannot determine the chroxy config directory")?;

    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;

    let json: serde_json::Value =
        serde_json::from_str(&contents).map_err(|e| format!("Invalid JSON: {}", e))?;
    parse_connection_info(&json)
}

/// Extract `(hostname, token)` from a connection-info document: either
/// `connection.json` on disk or the body of the daemon's `GET /connect`, which
/// carries the same fields.
fn parse_connection_info(json: &serde_json::Value) -> Result<(String, String), String> {
    // The server writes connectionUrl as "chroxy://hostname?token=TOKEN".
    // Parse hostname and token from it if available.
    if let Some(conn_url) = json.get("connectionUrl").and_then(|v| v.as_str()) {
        let without_scheme = conn_url.strip_prefix("chroxy://").unwrap_or(conn_url);
        let mut parts = without_scheme.splitn(2, '?');
        let hostname = parts.next().unwrap_or("").to_string();
        let mut token = String::new();
        if let Some(query) = parts.next() {
            for pair in query.split('&') {
                if let Some(value) = pair.strip_prefix("token=") {
                    token = value.to_string();
                    break;
                }
            }
        }
        if !hostname.is_empty() {
            return Ok((hostname, token));
        }
    }

    // Fall back to wsUrl + apiToken fields
    if let Some(ws_url) = json.get("wsUrl").and_then(|v| v.as_str()) {
        // wsUrl is like "wss://hostname" or "ws://host:port"
        let host = ws_url
            .strip_prefix("wss://")
            .or_else(|| ws_url.strip_prefix("ws://"))
            .unwrap_or(ws_url);
        let token = json
            .get("apiToken")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !host.is_empty() {
            return Ok((host.to_string(), token));
        }
    }

    Err("Missing 'connectionUrl' or 'wsUrl' in connection.json".to_string())
}

/// Fetch `(hostname, token)` from a running daemon's `GET /connect` (#8267).
///
/// For a daemon this app did not start there is no app-side state to read, and
/// `connection.json` may live under a config root the app does not see. `/connect`
/// is the live source: it requires the PRIMARY token, which is the one the
/// desktop already holds (config.json, or the OS keychain). The token goes in the
/// `Authorization` header only: never in the URL and never logged.
pub fn fetch_daemon_connection_info(port: u16, token: &str) -> Result<(String, String), String> {
    let url = format!("http://127.0.0.1:{}/connect", port);
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {}", token))
        .timeout(std::time::Duration::from_secs(3))
        .call()
        .map_err(|e| match e {
            // Status only: ureq's Display for a status error carries no headers.
            ureq::Error::Status(code, _) => format!("daemon refused /connect (HTTP {})", code),
            ureq::Error::Transport(_) => "daemon did not answer /connect".to_string(),
        })?;
    let mut body = String::new();
    std::io::Read::read_to_string(&mut std::io::Read::take(resp.into_reader(), 64 * 1024), &mut body)
        .map_err(|_| "daemon returned an unreadable /connect body".to_string())?;
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "daemon returned an unreadable /connect body".to_string())?;
    let (host, tok) = parse_connection_info(&json)?;
    // An auth-less daemon redacts the token rather than omitting it; a QR built
    // from the placeholder would pair nothing.
    if tok == "[REDACTED]" {
        return Err("daemon did not disclose a token".to_string());
    }
    Ok((host, tok))
}

/// Connection info for a daemon the app did not start: ask it directly, and fall
/// back to the on-disk files the same way [`get_connection_info`] does.
pub fn get_external_connection_info(
    port: u16,
    token: Option<&str>,
) -> Result<(String, String), String> {
    if let Some(t) = token {
        if let Ok(info) = fetch_daemon_connection_info(port, t) {
            return Ok(info);
        }
    }
    get_connection_info()
}

/// Try to get connection info from connection.json, falling back to config.json.
pub fn get_connection_info() -> Result<(String, String), String> {
    // First try connection.json (written by running server with tunnel)
    if let Ok(info) = read_connection_info() {
        return Ok(info);
    }

    // Fall back to config.json for local-only mode
    let config = config::load_config();
    let token = config.api_token.unwrap_or_default();
    let hostname = format!("localhost:{}", config.port);
    Ok((hostname, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_connection_url_formats_correctly() {
        let url = build_connection_url("example.com", "abc123");
        assert_eq!(url, "chroxy://example.com?token=abc123");
    }

    #[test]
    fn build_connection_url_handles_empty_token() {
        let url = build_connection_url("example.com", "");
        assert_eq!(url, "chroxy://example.com?token=");
    }

    #[test]
    fn generate_qr_svg_returns_valid_svg() {
        let svg = generate_qr_svg("chroxy://test?token=abc").unwrap();
        assert!(svg.contains("<svg"));
        assert!(svg.contains("</svg>"));
    }

    #[test]
    fn generate_qr_svg_uses_dark_theme_colors() {
        let svg = generate_qr_svg("test").unwrap();
        // White modules on dark background
        assert!(svg.contains("#ffffff"));
        assert!(svg.contains("#1a1a2e"));
    }

    #[test]
    fn build_qr_popup_html_contains_svg_and_url() {
        let svg = "<svg>mock</svg>";
        let url = "chroxy://test?token=abc";
        let html = build_qr_popup_html(svg, url);
        assert!(html.contains("<svg>mock</svg>"));
        assert!(html.contains("chroxy://test?token=abc"));
        assert!(html.contains("Scan to Connect"));
    }

    #[test]
    fn build_qr_popup_html_escapes_html_in_url() {
        let html = build_qr_popup_html("<svg></svg>", "chroxy://test?token=<script>alert(1)</script>");
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn build_qr_popup_html_is_valid_html() {
        let html = build_qr_popup_html("<svg></svg>", "chroxy://test");
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("</html>"));
    }

    #[test]
    fn build_qr_popup_html_has_escape_handler() {
        let html = build_qr_popup_html("<svg></svg>", "chroxy://test");
        assert!(html.contains("Escape"));
        assert!(html.contains("window.close()"));
    }

    // --- externally managed daemon (#8267) ---------------------------------

    /// Serve one canned response and hand back the raw request it received.
    fn serve_once(reply: String) -> (u16, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap();
            let _ = s.write_all(reply.as_bytes());
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (port, h)
    }

    fn json_reply(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    #[test]
    fn fetch_daemon_connection_info_sends_bearer_header_and_parses_connect_body() {
        let body = r#"{"connectionUrl":"chroxy://abc.example.com?token=tok123","apiToken":"tok123"}"#;
        let (port, req) = serve_once(json_reply(body));
        let info = fetch_daemon_connection_info(port, "tok123").unwrap();
        assert_eq!(info, ("abc.example.com".to_string(), "tok123".to_string()));
        let req = req.join().unwrap();
        assert!(req.starts_with("GET /connect HTTP/1.1"), "{}", req.lines().next().unwrap_or(""));
        assert!(
            req.to_lowercase().contains("authorization: bearer tok123"),
            "token must travel in the Authorization header"
        );
        assert!(!req.lines().next().unwrap().contains("tok123"), "token must not be in the URL");
    }

    #[test]
    fn fetch_daemon_connection_info_rejects_a_redacted_token() {
        // An auth-less daemon answers with a placeholder; a QR built from it pairs nothing.
        let body = r#"{"wsUrl":"ws://localhost:8765","apiToken":"[REDACTED]"}"#;
        let (port, _req) = serve_once(json_reply(body));
        assert!(fetch_daemon_connection_info(port, "x").is_err());
    }

    #[test]
    fn fetch_daemon_connection_info_surfaces_a_refusal_without_the_token() {
        let (port, _req) = serve_once(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        );
        let err = fetch_daemon_connection_info(port, "s3cret-token").unwrap_err();
        assert!(err.contains("403"));
        assert!(!err.contains("s3cret-token"));
    }

    #[test]
    fn parse_connection_info_reads_both_document_shapes() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"connectionUrl":"chroxy://h.example?token=t"}"#).unwrap();
        assert_eq!(parse_connection_info(&v).unwrap(), ("h.example".into(), "t".into()));
        let v: serde_json::Value =
            serde_json::from_str(r#"{"wsUrl":"wss://w.example","apiToken":"k"}"#).unwrap();
        assert_eq!(parse_connection_info(&v).unwrap(), ("w.example".into(), "k".into()));
        assert!(parse_connection_info(&serde_json::json!({})).is_err());
    }

    #[test]
    fn html_escape_handles_special_chars() {
        assert_eq!(html_escape("<b>\"hi\"</b>"), "&lt;b&gt;&quot;hi&quot;&lt;/b&gt;");
        assert_eq!(html_escape("a&b"), "a&amp;b");
        assert_eq!(html_escape("it's"), "it&#x27;s");
    }
}
