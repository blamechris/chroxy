use crate::config;
use crate::platform;
use serde_json::json;
use std::fs;
use std::io::ErrorKind;
use uuid::Uuid;

/// First-run setup: if no ~/.chroxy/config.json exists, generate one with defaults.
/// Uses create_new(true) for atomic creation — no TOCTOU race between exists() and open().
/// Returns true if a new config was created.
pub fn ensure_config() -> bool {
    let path = match config::config_path() {
        Some(p) => p,
        None => return false,
    };

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
            match platform::write_restricted_new(&path, &json_str) {
                Ok(()) => {
                    println!("[setup] Created default config at {}", path.display());
                    true
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                    // Config already exists — not an error, just skip creation
                    false
                }
                Err(e) => {
                    eprintln!("[setup] Failed to write config: {}", e);
                    false
                }
            }
        }
        Err(e) => {
            eprintln!("[setup] Failed to serialize config: {}", e);
            false
        }
    }
}
