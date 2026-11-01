//! Precedence between `config.json` and the desktop app's own settings for the
//! two values the app used to force onto the server it spawns: the tunnel mode
//! and the bind host (#8890).
//!
//! The server resolves each as `env var > config.json > default`. The app set
//! `CHROXY_TUNNEL` and `CHROXY_HOST` unconditionally, so a desktop setting saved
//! once (`quick`, `exposeOnLan`) silently overrode what the operator wrote in
//! `config.json`: a configured `named` tunnel became a public quick tunnel.
//! Here `config.json` wins, and the app's value applies only when it is silent.
//!
//! Everything in this module is pure so each branch is unit-tested without a
//! process, a filesystem or the real `~/.chroxy`.

/// Where an effective value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `config.json` sets it; the app's own setting is not applied.
    Config,
    /// `config.json` is silent; the app's setting applies.
    App,
}

impl Source {
    /// The wire form reported to the dashboard.
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Config => "config",
            Source::App => "app",
        }
    }
}

/// What to do with one environment variable on the spawned server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvAction {
    /// Set it to this value.
    Set(String),
    /// Remove it, so neither the app nor an inherited value shadows `config.json`.
    Clear,
}

/// The outcome of resolving one setting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    /// What the server ends up using, as a short label.
    pub effective: String,
    pub source: Source,
    pub env: EnvAction,
    /// One log line when the app's value differs from the config value that
    /// won. `None` when they agree or the app's value is the one applied.
    pub conflict: Option<String>,
}

/// A config string that actually says something. Whitespace-only is nothing.
fn configured(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// The tunnel modes the server accepts, as it spells them (`parseTunnelArg` in
/// `packages/server/src/tunnel/index.js`), each with its canonical form. The
/// server is exact: no trimming, no case folding. Anything else it rejects.
fn canonical_tunnel_mode(value: &str) -> Option<&'static str> {
    match value {
        "quick" | "cloudflare" | "cloudflare:quick" => Some("quick"),
        "named" | "cloudflare:named" => Some("named"),
        "none" | "cloudflare:none" => Some("none"),
        _ => None,
    }
}

/// Tunnel mode: a `config.json` `tunnel` that is a recognised mode wins;
/// otherwise (unset or empty) the app's mode is handed to the server through
/// `CHROXY_TUNNEL` as before. A config value that is NOT a recognised mode is an
/// error: the start is refused rather than silently replaced by the app's value
/// (which could be a public quick tunnel) or passed on to the server.
pub fn resolve_tunnel(config_tunnel: Option<&str>, app_mode: &str) -> Result<Resolution, String> {
    match config_tunnel.filter(|v| !v.is_empty()) {
        Some(raw) => {
            let c = canonical_tunnel_mode(raw).ok_or_else(|| {
                format!(
                    "config.json sets tunnel=\"{}\", which is not a recognised tunnel mode (use quick, named or none), so the server was not started. Fix \"tunnel\" in config.json.",
                    raw
                )
            })?;
            Ok(Resolution {
                effective: c.to_string(),
                source: Source::Config,
                env: EnvAction::Clear,
                conflict: (c != app_mode).then(|| {
                    format!(
                        "[tray] config.json sets tunnel={}; the app's tunnel mode ({}) is not applied",
                        c, app_mode
                    )
                }),
            })
        }
        None => Ok(Resolution {
            effective: app_mode.to_string(),
            source: Source::App,
            env: EnvAction::Set(app_mode.to_string()),
            conflict: None,
        }),
    }
}

/// Bind host: a non-empty `config.json` `host` wins; otherwise the app pins
/// loopback, or leaves the server's all-interfaces default when it is set to
/// expose on the LAN (#5356).
pub fn resolve_host(config_host: Option<&str>, expose_on_lan: bool) -> Resolution {
    let app_label = if expose_on_lan { "all interfaces" } else { "127.0.0.1" };
    match configured(config_host) {
        Some(c) => {
            let agrees = if expose_on_lan {
                matches!(c, "0.0.0.0" | "::")
            } else {
                c == "127.0.0.1"
            };
            Resolution {
                effective: c.to_string(),
                source: Source::Config,
                env: EnvAction::Clear,
                conflict: (!agrees).then(|| {
                    format!(
                        "[tray] config.json sets host={}; the app's bind setting ({}) is not applied",
                        c, app_label
                    )
                }),
            }
        }
        None if expose_on_lan => Resolution {
            effective: app_label.to_string(),
            source: Source::App,
            env: EnvAction::Clear,
            conflict: None,
        },
        None => Resolution {
            effective: app_label.to_string(),
            source: Source::App,
            env: EnvAction::Set("127.0.0.1".to_string()),
            conflict: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tunnel(cfg: Option<&str>, app: &str) -> Resolution {
        resolve_tunnel(cfg, app).expect("a recognised or unset tunnel resolves")
    }

    #[test]
    fn config_tunnel_wins_and_the_env_is_cleared() {
        let r = tunnel(Some("named"), "quick");
        assert_eq!(r.effective, "named");
        assert_eq!(r.source, Source::Config);
        assert_eq!(r.env, EnvAction::Clear, "CHROXY_TUNNEL must not shadow config.json");
        let msg = r.conflict.expect("a differing app mode is reported");
        assert!(msg.starts_with("[tray]") && msg.contains("named") && msg.contains("quick"), "{}", msg);
    }

    #[test]
    fn config_none_beats_an_app_quick_tunnel() {
        let r = tunnel(Some("none"), "quick");
        assert_eq!((r.effective.as_str(), r.source, r.env), ("none", Source::Config, EnvAction::Clear));
    }

    #[test]
    fn every_accepted_spelling_resolves_to_its_canonical_mode() {
        for (cfg, want) in [
            ("quick", "quick"),
            ("cloudflare", "quick"),
            ("cloudflare:quick", "quick"),
            ("named", "named"),
            ("cloudflare:named", "named"),
            ("none", "none"),
            ("cloudflare:none", "none"),
        ] {
            assert_eq!(tunnel(Some(cfg), "quick").effective, want, "{}", cfg);
        }
    }

    #[test]
    fn an_unrecognised_config_tunnel_is_an_error_not_a_fallback() {
        // Neither the app's value (here a public quick tunnel) nor the raw string
        // may be used; the message names the bad value.
        for bad in ["cloudflare:naemd", "cloudflare:", "ngrok", "Named", " named", "   ", "quick "] {
            let err = resolve_tunnel(Some(bad), "quick").unwrap_err();
            assert!(err.contains(&format!("tunnel=\"{}\"", bad)) && err.contains("config.json"), "{:?}: {}", bad, err);
        }
    }

    #[test]
    fn matching_config_tunnel_is_not_a_conflict() {
        let r = tunnel(Some("quick"), "quick");
        assert_eq!(r.source, Source::Config);
        assert_eq!(r.conflict, None);
        assert_eq!(tunnel(Some("cloudflare:quick"), "quick").conflict, None);
    }

    #[test]
    fn unset_config_tunnel_keeps_the_app_behaviour() {
        for blank in [None, Some("")] {
            let r = tunnel(blank, "quick");
            assert_eq!(r.effective, "quick");
            assert_eq!(r.source, Source::App);
            assert_eq!(r.env, EnvAction::Set("quick".into()), "{:?}", blank);
            assert_eq!(r.conflict, None);
        }
    }

    #[test]
    fn config_host_wins_over_expose_on_lan() {
        let r = resolve_host(Some("127.0.0.1"), true);
        assert_eq!(r.effective, "127.0.0.1");
        assert_eq!(r.source, Source::Config);
        assert_eq!(r.env, EnvAction::Clear);
        let msg = r.conflict.expect("exposeOnLan against a loopback host is reported");
        assert!(msg.starts_with("[tray]") && msg.contains("127.0.0.1") && msg.contains("all interfaces"), "{}", msg);
    }

    #[test]
    fn config_host_wins_over_the_loopback_pin() {
        let r = resolve_host(Some("192.168.1.5"), false);
        assert_eq!((r.source, r.env), (Source::Config, EnvAction::Clear));
        assert!(r.conflict.is_some());
    }

    #[test]
    fn agreeing_config_host_is_not_a_conflict() {
        assert_eq!(resolve_host(Some("127.0.0.1"), false).conflict, None);
        assert_eq!(resolve_host(Some("0.0.0.0"), true).conflict, None);
        assert_eq!(resolve_host(Some("::"), true).conflict, None);
    }

    #[test]
    fn unset_config_host_keeps_the_expose_on_lan_behaviour() {
        for blank in [None, Some(""), Some("  ")] {
            let lo = resolve_host(blank, false);
            assert_eq!((lo.source, lo.env, lo.conflict), (Source::App, EnvAction::Set("127.0.0.1".into()), None));
            let lan = resolve_host(blank, true);
            assert_eq!((lan.source, lan.env, lan.conflict), (Source::App, EnvAction::Clear, None));
        }
    }

    #[test]
    fn source_wire_forms() {
        assert_eq!(Source::Config.as_str(), "config");
        assert_eq!(Source::App.as_str(), "app");
    }
}
