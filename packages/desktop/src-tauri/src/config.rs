use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

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
/// Falls back to OS keychain for apiToken if not present in config file.
pub fn load_config() -> ChroxyConfig {
    let path = match config_path() {
        Some(p) => p,
        None => return ChroxyConfig::default(),
    };

    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return ChroxyConfig::default(),
    };

    let mut config: ChroxyConfig = match serde_json::from_str(&contents) {
        Ok(config) => config,
        Err(e) => {
            eprintln!("[config] Failed to parse {}: {}", path.display(), e);
            ChroxyConfig::default()
        }
    };

    // Fallback: if apiToken is missing from config file, check OS keychain.
    // The server migrates tokens from config.json to keychain on first run.
    if config.api_token.is_none() {
        if let Some(token) = get_keychain_token() {
            println!("[config] Loaded API token from OS keychain");
            config.api_token = Some(token);
        }
    }

    config
}

/// Read the API token from the OS keychain.
/// Uses the same service/account as the Node.js server (keychain.js):
///   service = "chroxy", account = "api-token"
fn get_keychain_token() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("security")
            .args(["find-generic-password", "-s", "chroxy", "-a", "api-token", "-w"])
            .output()
            .ok()?;
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
        None
    }

    #[cfg(target_os = "linux")]
    {
        let output = Command::new("secret-tool")
            .args(["lookup", "service", "chroxy", "account", "api-token"])
            .output()
            .ok()?;
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
        None
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// Parse config from a JSON string. Test-only helper.
#[cfg(test)]
pub(crate) fn parse_config(json: &str) -> Result<ChroxyConfig, serde_json::Error> {
    serde_json::from_str(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_zero_port() {
        // Note: #[derive(Default)] sets port to 0, not 8765.
        // The default_port() serde function only applies during deserialization.
        let config = ChroxyConfig::default();
        assert_eq!(config.port, 0);
        assert!(config.api_token.is_none());
        assert!(config.tunnel.is_none());
        assert!(config.model.is_none());
        assert!(config.cwd.is_none());
    }

    #[test]
    fn deserialized_default_port_is_8765() {
        // When deserializing an empty object, serde uses default_port()
        let config: ChroxyConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.port, 8765);
    }

    #[test]
    fn parse_full_config() {
        let json = r#"{
            "apiToken": "test-token-123",
            "port": 9999,
            "tunnel": "named",
            "model": "sonnet",
            "cwd": "/home/user/projects"
        }"#;
        let config = parse_config(json).unwrap();
        assert_eq!(config.api_token.as_deref(), Some("test-token-123"));
        assert_eq!(config.port, 9999);
        assert_eq!(config.tunnel.as_deref(), Some("named"));
        assert_eq!(config.model.as_deref(), Some("sonnet"));
        assert_eq!(config.cwd.as_deref(), Some("/home/user/projects"));
    }

    #[test]
    fn parse_partial_config_uses_defaults() {
        let json = r#"{"apiToken": "tok"}"#;
        let config = parse_config(json).unwrap();
        assert_eq!(config.api_token.as_deref(), Some("tok"));
        assert_eq!(config.port, 8765); // default
        assert!(config.tunnel.is_none());
    }

    #[test]
    fn parse_empty_object_uses_all_defaults() {
        let config = parse_config("{}").unwrap();
        assert_eq!(config.port, 8765);
        assert!(config.api_token.is_none());
    }

    #[test]
    fn parse_invalid_json_returns_error() {
        assert!(parse_config("not json").is_err());
    }

    #[test]
    fn config_path_returns_some() {
        // Should work on any machine with a home directory
        let path = config_path();
        assert!(path.is_some());
        let p = path.unwrap();
        assert!(p.ends_with(".chroxy/config.json"));
    }

    #[test]
    fn get_keychain_token_returns_option() {
        // Should not panic regardless of keychain state
        let result = get_keychain_token();
        // We can't assert the value (depends on machine state),
        // but it should be Some(non-empty) or None — never panic.
        if let Some(ref token) = result {
            assert!(!token.is_empty());
        }
    }
}
