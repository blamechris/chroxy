use crate::config;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
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

/// Generate a QR code as a PNG data URL (base64-encoded).
pub fn generate_qr_png_data_url(data: &str) -> Result<String, String> {
    let code = QrCode::new(data.as_bytes()).map_err(|e| format!("QR encode error: {}", e))?;
    let image = code.render::<image::Luma<u8>>().quiet_zone(true).build();

    let mut png_bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::L8,
    )
    .map_err(|e| format!("PNG encode error: {}", e))?;

    let b64 = BASE64.encode(&png_bytes);
    Ok(format!("data:image/png;base64,{}", b64))
}

/// Build the HTML page for the QR code popup.
pub fn build_qr_popup_html(svg: &str, connection_url: &str) -> String {
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
</body>
</html>"#,
        svg, connection_url
    )
}

/// Read the connection info from ~/.chroxy/connection.json.
/// Returns (hostname, token) or an error.
pub fn read_connection_info() -> Result<(String, String), String> {
    let path = dirs::home_dir()
        .ok_or("Cannot determine home directory")?
        .join(".chroxy/connection.json");

    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;

    let json: serde_json::Value =
        serde_json::from_str(&contents).map_err(|e| format!("Invalid JSON: {}", e))?;

    let hostname = json
        .get("hostname")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'hostname' in connection.json")?
        .to_string();

    let token = json
        .get("token")
        .and_then(|v| v.as_str())
        .or_else(|| {
            // Fall back to config.json token
            None
        })
        .unwrap_or("")
        .to_string();

    if hostname.is_empty() {
        return Err("Empty hostname in connection.json".to_string());
    }

    Ok((hostname, token))
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
    fn build_qr_popup_html_is_valid_html() {
        let html = build_qr_popup_html("<svg></svg>", "chroxy://test");
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("</html>"));
    }
}
