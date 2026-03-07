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

/// Read the connection info from ~/.chroxy/connection.json.
/// The server writes fields: connectionUrl, wsUrl, httpUrl, apiToken, tunnelMode.
/// Returns (hostname, token) or an error.
pub fn read_connection_info() -> Result<(String, String), String> {
    let path = dirs::home_dir()
        .ok_or("Cannot determine home directory")?
        .join(".chroxy/connection.json");

    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;

    let json: serde_json::Value =
        serde_json::from_str(&contents).map_err(|e| format!("Invalid JSON: {}", e))?;

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

    #[test]
    fn html_escape_handles_special_chars() {
        assert_eq!(html_escape("<b>\"hi\"</b>"), "&lt;b&gt;&quot;hi&quot;&lt;/b&gt;");
        assert_eq!(html_escape("a&b"), "a&amp;b");
        assert_eq!(html_escape("it's"), "it&#x27;s");
    }
}
