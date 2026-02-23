use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

/// Subset of ~/.chroxy/config.json fields that the desktop app needs.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChroxyConfig {
    #[serde(default)]
    pub api_token: Option<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub tunnel: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

fn default_port() -> u16 {
    8765
}

/// Returns the path to ~/.chroxy/config.json.
pub fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".chroxy/config.json"))
}

/// Load and parse ~/.chroxy/config.json. Returns default config if file doesn't exist.
pub fn load_config() -> ChroxyConfig {
    let path = match config_path() {
        Some(p) => p,
        None => return ChroxyConfig::default(),
    };

    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return ChroxyConfig::default(),
    };

    match serde_json::from_str(&contents) {
        Ok(config) => config,
        Err(e) => {
            eprintln!("[config] Failed to parse {}: {}", path.display(), e);
            ChroxyConfig::default()
        }
    }
}
