use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

/// Subset of the daemon's `config.json` fields that the desktop app needs.
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

/// Warn once per process about a relative `CHROXY_CONFIG_DIR`, mirroring the
/// daemon's `warnedRelative` in `config-dir.js`.
static WARNED_RELATIVE: AtomicBool = AtomicBool::new(false);

/// Resolve the config root from a raw `CHROXY_CONFIG_DIR` value and a home dir.
///
/// Split out from [`config_dir`] and kept **pure** so the tests never touch the
/// process environment: `cargo test` runs tests as threads in a SINGLE process,
/// so a `set_var` in one test would race every other test's view of the root
/// (and `config_path_returns_some` below asserts on the default). The env read
/// lives in the thin wrapper instead.
///
/// Semantics match [`packages/server/src/config-dir.js`] exactly, because the two
/// halves must agree — see [`config_dir`].
fn resolve_config_dir(raw: Option<&str>, home: Option<PathBuf>) -> Option<PathBuf> {
    match raw {
        // An empty value falls through to the default, matching the `||`
        // semantics of the daemon's resolver (`if (!raw) return default`).
        Some(r) if !r.is_empty() => {
            if Path::new(r).is_absolute() {
                return Some(PathBuf::from(r));
            }
            // Refused, not resolved — a relative value would otherwise land
            // desktop state wherever the app happened to be launched from. The
            // daemon refuses it identically, so both halves stay on the default
            // rather than diverging.
            if !WARNED_RELATIVE.swap(true, Ordering::Relaxed) {
                eprintln!(
                    "[config] ignoring CHROXY_CONFIG_DIR={:?}: not an absolute path. Using the default ~/.chroxy instead.",
                    r
                );
            }
            home.map(|h| h.join(".chroxy"))
        }
        _ => home.map(|h| h.join(".chroxy")),
    }
}

/// The daemon's config/state root — `~/.chroxy` by default, relocated by
/// `CHROXY_CONFIG_DIR` (#7052 / #7241).
///
/// **Read per call, never cached.** A `OnceCell`/`lazy_static` here would
/// reproduce the exact defect #7052 was filed for: the daemon's sixteen
/// module-scope `const` copies froze at import and silently ignored the
/// override, so the variable relocated only half the state.
///
/// The desktop app must agree with the server on this value. `server.rs` spawns
/// the embedded server **without** clearing `CHROXY_CONFIG_DIR`, so the child
/// inherits it; before this existed the Rust side read `~/.chroxy` while that
/// child read the relocated root — the same silent split as #7239, and silent
/// for the same reason (the token survives, because `API_TOKEN` is passed
/// explicitly in the spawn env, so only the *other* state diverges).
pub fn config_dir() -> Option<PathBuf> {
    resolve_config_dir(
        std::env::var("CHROXY_CONFIG_DIR").ok().as_deref(),
        dirs::home_dir(),
    )
}

/// Returns the path to `config.json` inside [`config_dir`]
/// (`~/.chroxy/config.json` with no override).
pub fn config_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("config.json"))
}

/// Serialises tests whose result depends on `CHROXY_CONFIG_DIR`.
///
/// `cargo test` runs tests as threads in a SINGLE process, so one test's
/// `set_var` is immediately visible to every test running alongside it. Any test
/// that sets the variable — or that resolves a path and asserts on the result —
/// takes this lock, or the two flake against each other.
///
/// Poisoning is absorbed (`into_inner`) on purpose: if a test panics while
/// holding the lock, the remaining tests should report their own results rather
/// than a cascade of `PoisonError`s that hides which one actually broke.
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Load and parse the daemon's `config.json`. Returns default config if file doesn't exist.
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
        let _guard = env_lock();
        let path = config_path();
        assert!(path.is_some());
        let p = path.unwrap();
        // Asserted against the RESOLVED root rather than a hardcoded ".chroxy",
        // so this stays correct in an environment that has CHROXY_CONFIG_DIR set
        // instead of going falsely red.
        assert_eq!(p, config_dir().unwrap().join("config.json"));
        assert!(p.ends_with("config.json"));
    }

    // --- CHROXY_CONFIG_DIR resolution (#7241) -------------------------------
    //
    // These drive the pure `resolve_config_dir` rather than setting the env var:
    // cargo runs tests as threads in ONE process, so a `set_var` here would race
    // `config_path_returns_some` above (and every other test that resolves a
    // path) rather than testing this function in isolation.

    fn home() -> Option<PathBuf> {
        Some(PathBuf::from("/home/u"))
    }

    #[test]
    fn resolve_config_dir_unset_uses_home_default() {
        assert_eq!(
            resolve_config_dir(None, home()),
            Some(PathBuf::from("/home/u/.chroxy"))
        );
    }

    #[test]
    fn resolve_config_dir_absolute_override_wins() {
        assert_eq!(
            resolve_config_dir(Some("/mnt/state"), home()),
            Some(PathBuf::from("/mnt/state"))
        );
    }

    #[test]
    fn resolve_config_dir_relative_is_refused_not_resolved() {
        // The daemon refuses a relative value (config-dir.js) rather than
        // resolving it against the cwd. Desktop must refuse identically, or the
        // two halves land on different roots for the same env value.
        assert_eq!(
            resolve_config_dir(Some("state"), home()),
            Some(PathBuf::from("/home/u/.chroxy"))
        );
        assert_eq!(
            resolve_config_dir(Some("./state"), home()),
            Some(PathBuf::from("/home/u/.chroxy"))
        );
    }

    #[test]
    fn resolve_config_dir_empty_falls_back_to_default() {
        // Matches the `||` semantics of the daemon's resolver: an empty value is
        // "unset", not "relative".
        assert_eq!(
            resolve_config_dir(Some(""), home()),
            Some(PathBuf::from("/home/u/.chroxy"))
        );
    }

    #[test]
    fn resolve_config_dir_absolute_override_works_without_home() {
        // A GUI launch may have no resolvable home; an absolute override is
        // still usable, and must not be discarded along with it.
        assert_eq!(
            resolve_config_dir(Some("/mnt/state"), None),
            Some(PathBuf::from("/mnt/state"))
        );
    }

    #[test]
    fn resolve_config_dir_no_home_no_override_is_none() {
        assert_eq!(resolve_config_dir(None, None), None);
        // A relative override with no home is also None — it falls back to the
        // default, which cannot be built.
        assert_eq!(resolve_config_dir(Some("state"), None), None);
    }

    #[test]
    fn every_desktop_state_path_follows_a_relocated_root() {
        // The defect this guards: N call sites, one of them drifting back to a
        // hardcoded `dirs::home_dir().join(".chroxy/…")` while the rest follow
        // the override. Each path stays individually plausible, so the split is
        // caught only by comparing them against a root that is NOT the home
        // default.
        //
        // That last part is load-bearing and is why this test sets the variable
        // instead of asserting against `config_dir()`: with CHROXY_CONFIG_DIR
        // unset, `config_dir()` IS `~/.chroxy`, so a hardcoded home path and a
        // resolved one are the same string and the assertion passes against the
        // very mutant it exists to catch — a guard that reports success without
        // checking anything (docs/false-safety-guards.md). Proven by mutation:
        // reverting settings.rs::path() to `dirs::home_dir()` fails this test and
        // passes every other test in the crate.
        let _guard = env_lock();
        let previous = std::env::var("CHROXY_CONFIG_DIR").ok();
        std::env::set_var("CHROXY_CONFIG_DIR", "/tmp/chroxy-relocated-test-root");
        let expected = PathBuf::from("/tmp/chroxy-relocated-test-root");

        let observed = (
            config_path(),
            crate::settings::DesktopSettings::path(),
            crate::qrcode::connection_info_path(),
        );

        // Restored before asserting, so a failure cannot leak the override into
        // the rest of the suite.
        match previous {
            Some(v) => std::env::set_var("CHROXY_CONFIG_DIR", v),
            None => std::env::remove_var("CHROXY_CONFIG_DIR"),
        }

        assert_eq!(observed.0, Some(expected.join("config.json")), "config.json");
        assert_eq!(
            observed.1,
            Some(expected.join("desktop-settings.json")),
            "desktop-settings.json"
        );
        assert_eq!(
            observed.2,
            Some(expected.join("connection.json")),
            "connection.json"
        );
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
