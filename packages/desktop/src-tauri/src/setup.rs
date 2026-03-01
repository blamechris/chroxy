use crate::config;
use crate::platform;
use serde_json::json;
use std::fs;
use uuid::Uuid;

/// First-run setup: if no ~/.chroxy/config.json exists, generate one with defaults.
/// Returns true if a new config was created.
pub fn ensure_config() -> bool {
    let path = match config::config_path() {
        Some(p) => p,
        None => return false,
    };

    if path.exists() {
        return false;
    }

    // Ensure ~/.chroxy/ directory exists
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("[setup] Failed to create config dir: {}", e);
            return false;
        }
    }

    let token = Uuid::new_v4().to_string();
    let config = json!({
        "apiToken": token,
        "port": 8765
    });

    match serde_json::to_string_pretty(&config) {
        Ok(json_str) => {
            if let Err(e) = platform::write_restricted(&path, &json_str) {
                eprintln!("[setup] Failed to write config: {}", e);
                return false;
            }

            println!("[setup] Created default config at {}", path.display());
            true
        }
        Err(e) => {
            eprintln!("[setup] Failed to serialize config: {}", e);
            false
        }
    }
}
