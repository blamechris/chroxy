use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Desktop-specific settings persisted to ~/.chroxy/desktop-settings.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default = "default_true")]
    pub auto_start_server: bool,
    #[serde(default = "default_true")]
    pub show_notifications: bool,
    #[serde(default)]
    pub node_path: Option<String>,
    #[serde(default = "default_tunnel_mode")]
    pub tunnel_mode: String,
    #[serde(default)]
    pub last_window_x: Option<f64>,
    #[serde(default)]
    pub last_window_y: Option<f64>,
    #[serde(default)]
    pub last_window_width: Option<f64>,
    #[serde(default)]
    pub last_window_height: Option<f64>,
}

fn default_true() -> bool {
    true
}

fn default_tunnel_mode() -> String {
    "quick".to_string()
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            auto_start_server: true,
            show_notifications: true,
            tunnel_mode: "quick".to_string(),
            node_path: None,
            last_window_x: None,
            last_window_y: None,
            last_window_width: None,
            last_window_height: None,
        }
    }
}

#[cfg(unix)]
pub fn write_restricted(path: &std::path::Path, data: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("Failed to open config: {}", e))?;
    file.write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

#[cfg(not(unix))]
pub fn write_restricted(path: &std::path::Path, data: &str) -> Result<(), String> {
    std::fs::write(path, data).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

impl DesktopSettings {
    /// Path to the settings file.
    pub fn path() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".chroxy/desktop-settings.json"))
    }

    /// Load settings from disk, or return defaults.
    pub fn load() -> Self {
        let path = match Self::path() {
            Some(p) => p,
            None => return Self::default(),
        };

        let contents = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return Self::default(),
        };

        serde_json::from_str(&contents).unwrap_or_default()
    }

    /// Save settings to disk.
    pub fn save(&self) -> Result<(), String> {
        let path = Self::path().ok_or("Could not determine home directory")?;

        // Ensure ~/.chroxy/ exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;

        write_restricted(&path, &json)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn write_restricted_creates_file_with_0o600_permissions() {
        let dir = std::env::temp_dir().join("chroxy-test-settings");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test-write-restricted.json");

        // Clean up from previous runs
        let _ = fs::remove_file(&path);

        write_restricted(&path, r#"{"test": true}"#).unwrap();

        let meta = fs::metadata(&path).unwrap();
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "File should be created with 0o600 permissions, got {:o}", mode);

        // Clean up
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn write_restricted_overwrites_existing_file() {
        let dir = std::env::temp_dir().join("chroxy-test-settings");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test-overwrite.json");

        write_restricted(&path, r#"{"v": 1}"#).unwrap();
        write_restricted(&path, r#"{"v": 2}"#).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"v": 2}"#);

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }
}
