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

        fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))
    }
}
