//! The app's own settings, which must stay usable with no daemon running (#9079):
//! the pure logic behind the bundled "App Settings" view, the menu-bar routing
//! while the main window shows the loading page, and the `config.json` port writer.
//!
//! Everything here is a plain function of its inputs so it can be unit tested; the
//! Tauri glue (commands, menu handles, events) lives in `lib.rs`.

use crate::server::ServerStatus;
use crate::settings::DesktopSettings;
use crate::tray_state::PortState;
use crate::{caller_page, CallerPage};
use serde::Serialize;
use std::path::Path;

/// Event the main webview receives when a setting changed anywhere (tray, menu,
/// App Settings, dashboard), so an open App Settings view re-reads its state.
pub const SETTINGS_CHANGED_EVENT: &str = "app_settings_changed";

/// Event carrying a menu action to the bundled page, which acts on it itself.
pub const PAGE_ACTION_EVENT: &str = "app_page_action";

/// The lowest port the app lets a user configure (privileged ports are refused).
pub const MIN_PORT: u16 = 1024;
/// The highest valid TCP port.
pub const MAX_PORT: u16 = u16::MAX;

/// Refuse a port outside [`MIN_PORT`]..=[`MAX_PORT`].
pub fn validate_port(port: u16) -> Result<u16, String> {
    if (MIN_PORT..=MAX_PORT).contains(&port) {
        Ok(port)
    } else {
        Err(format!("Port must be between {} and {}.", MIN_PORT, MAX_PORT))
    }
}

/// Merge `port` into the existing `config.json` at `path`, keeping every other key
/// and writing with the file's restricted permissions (0600 on Unix).
///
/// Refuses, without touching the file: a port outside the valid range, a file that
/// does not exist (`ensure_config` creates it at launch, so a missing one is an
/// error, not something to invent), invalid JSON, and a JSON value that is not an
/// object. `pub` so the integration tests drive it without a running app.
pub fn set_port_at(path: &Path, port: u16) -> Result<(), String> {
    validate_port(port)?;
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read config {}: {}", path.display(), e))?;
    let mut cfg: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse config {}: {}", path.display(), e))?;
    let obj = cfg
        .as_object_mut()
        .ok_or_else(|| format!("Config file {} is not a JSON object", path.display()))?;
    obj.insert("port".to_string(), serde_json::json!(port));
    let json_str = serde_json::to_string_pretty(&cfg)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    crate::platform::write_restricted(path, &json_str)
        .map_err(|e| format!("Failed to write config: {}", e))
}

/// The tunnel mode to report: one of `none` / `quick` / `named`, anything else
/// (a hand-edited settings file) reads as `none`.
pub fn normalize_tunnel_mode(mode: &str) -> String {
    match mode {
        "none" | "quick" | "named" => mode.to_string(),
        _ => "none".to_string(),
    }
}

/// Whether a verified daemon is known to be up, from in-memory state only (no
/// network probe): the app's own server is running, or the configured port was
/// last seen holding a daemon that proved itself as Chroxy.
pub fn daemon_available(own: &ServerStatus, port: PortState) -> bool {
    matches!(own, ServerStatus::Running) || matches!(port, PortState::Chroxy(_))
}

/// What the App Settings view shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsSnapshot {
    pub auto_start_server: bool,
    pub start_at_login: bool,
    pub tunnel_mode: String,
    pub expose_on_lan: bool,
    pub port: u16,
    pub cloudflared_found: bool,
    pub daemon_available: bool,
}

pub fn build_snapshot(
    settings: &DesktopSettings,
    start_at_login: bool,
    port: u16,
    cloudflared_found: bool,
    own: &ServerStatus,
    port_state: PortState,
) -> AppSettingsSnapshot {
    AppSettingsSnapshot {
        auto_start_server: settings.auto_start_server,
        start_at_login,
        tunnel_mode: normalize_tunnel_mode(&settings.tunnel_mode),
        expose_on_lan: settings.expose_on_lan,
        port,
        cloudflared_found,
        daemon_available: daemon_available(own, port_state),
    }
}

/// Only the app's own page may change the app's settings through the new
/// commands: a dashboard (or any other page) has its own settings panel.
pub(crate) fn caller_may_change_app_settings(page: &CallerPage) -> bool {
    matches!(page, CallerPage::App)
}

// -- Menu bar --------------------------------------------------------------

/// The `app_menu:` actions that need the dashboard and so are disabled while the
/// main window shows the bundled page.
pub const DASHBOARD_ONLY_ACTIONS: &[&str] = &[
    "new-session",
    "disconnect",
    "view-toggle-sidebar",
    "view-toggle-plan-mode",
    "view-show-qr",
    "view-reload",
];

/// The `app_menu:` actions the bundled page handles itself when it is showing.
pub const PAGE_ROUTED_ACTIONS: &[&str] = &["preferences", "tunnel-settings", "connect-to-server"];

/// Where a menu action goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuRoute {
    /// `menu://<action>` for the dashboard, as before.
    Dashboard,
    /// An `app_page_action` event for the bundled page.
    AppPage { action: &'static str, section: Option<&'static str> },
}

/// The page action that opens App Settings.
pub const PAGE_ACTION_OPEN_SETTINGS: &str = "open-settings";
/// The page action that runs the page's own Connect flow.
pub const PAGE_ACTION_CONNECT: &str = "connect";

/// Route an `app_menu:` action, given whether the main window is on the app's
/// own page. Only [`PAGE_ROUTED_ACTIONS`] ever leave the dashboard route.
pub fn route_app_menu(action: &str, on_app_page: bool) -> MenuRoute {
    if !on_app_page {
        return MenuRoute::Dashboard;
    }
    match action {
        "preferences" => MenuRoute::AppPage { action: PAGE_ACTION_OPEN_SETTINGS, section: None },
        "tunnel-settings" => {
            MenuRoute::AppPage { action: PAGE_ACTION_OPEN_SETTINGS, section: Some("tunnel") }
        }
        "connect-to-server" => MenuRoute::AppPage { action: PAGE_ACTION_CONNECT, section: None },
        _ => MenuRoute::Dashboard,
    }
}

/// Whether the dashboard-only menu items are enabled while the main window shows
/// `url`: an http(s) page that is not the app's own origin. The bundled page
/// (`tauri://localhost`, `http://tauri.localhost`), `data:` and `about:blank` are not.
pub fn dashboard_items_enabled(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https") && caller_page(url) != CallerPage::App
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    fn remote() -> CallerPage {
        CallerPage::Remote { host: Some("127.0.0.1".into()), port: Some(8765) }
    }

    #[test]
    fn the_caller_predicate_is_the_apps_own_page_only() {
        assert!(caller_may_change_app_settings(&CallerPage::App));
        assert!(!caller_may_change_app_settings(&remote()));
        assert!(!caller_may_change_app_settings(&CallerPage::Remote { host: None, port: None }));
    }

    #[test]
    fn port_validation_bounds() {
        assert!(validate_port(0).is_err());
        assert!(validate_port(1023).is_err());
        assert_eq!(validate_port(1024), Ok(1024));
        assert_eq!(validate_port(8765), Ok(8765));
        assert_eq!(validate_port(65535), Ok(65535));
    }

    #[test]
    fn every_menu_action_routes_by_page() {
        let all: Vec<&str> = DASHBOARD_ONLY_ACTIONS.iter().chain(PAGE_ROUTED_ACTIONS).copied().collect();
        // On a dashboard everything is the dashboard's, exactly as before.
        for a in &all {
            assert_eq!(route_app_menu(a, false), MenuRoute::Dashboard, "{a} on a dashboard");
        }
        // On the app page the three routed actions go to the page...
        assert_eq!(
            route_app_menu("preferences", true),
            MenuRoute::AppPage { action: "open-settings", section: None }
        );
        assert_eq!(
            route_app_menu("tunnel-settings", true),
            MenuRoute::AppPage { action: "open-settings", section: Some("tunnel") }
        );
        assert_eq!(
            route_app_menu("connect-to-server", true),
            MenuRoute::AppPage { action: "connect", section: None }
        );
        // ...and every other action keeps the dashboard route (those items are disabled).
        for a in DASHBOARD_ONLY_ACTIONS {
            assert_eq!(route_app_menu(a, true), MenuRoute::Dashboard, "{a} on the app page");
        }
        // The routed list and the router agree, in both directions.
        for a in PAGE_ROUTED_ACTIONS {
            assert_ne!(route_app_menu(a, true), MenuRoute::Dashboard, "{a} is listed as routed");
        }
    }

    #[test]
    fn dashboard_items_follow_the_page_url() {
        for (u, enabled) in [
            ("tauri://localhost/index.html", false),
            ("tauri://localhost", false),
            ("http://tauri.localhost/", false),
            ("https://tauri.localhost/", false),
            ("data:text/html,hi", false),
            ("about:blank", false),
            ("file:///tmp/x.html", false),
            ("http://127.0.0.1:8765/dashboard?x=1", true),
            ("http://localhost:8765/", true),
            ("https://example.trycloudflare.com/", true),
            // Not the app origin (a different port), so `caller_page` calls it a
            // remote page and the dashboard items are enabled for it.
            ("http://tauri.localhost:1234/", true),
        ] {
            assert_eq!(dashboard_items_enabled(&url(u)), enabled, "{u}");
        }
    }

    /// The roster check, in both directions: every `app_menu:` id the menu builder
    /// declares is disabled on the app page, routed to it, or handled natively (an
    /// arm in the macOS match); and every id in the two lists is a real menu item.
    #[test]
    fn every_app_menu_id_is_disabled_routed_or_native() {
        let src = include_str!("lib.rs");
        let mut ids: Vec<String> = Vec::new();
        let mut rest = src;
        while let Some(i) = rest.find("\"app_menu:") {
            let after = &rest[i + "\"app_menu:".len()..];
            let end = after.find('"').unwrap();
            let id = after[..end].to_string();
            // Comments and `strip_prefix("app_menu:")` also match the scan; a real
            // id is a kebab-case word.
            let real = !id.is_empty() && id.chars().all(|c| c.is_ascii_lowercase() || c == '-');
            if real && !ids.contains(&id) {
                ids.push(id);
            }
            rest = &after[end..];
        }
        assert!(ids.len() > 10, "the scrape found only {} ids", ids.len());
        for list in [DASHBOARD_ONLY_ACTIONS, PAGE_ROUTED_ACTIONS] {
            for a in list {
                assert!(ids.iter().any(|i| i == a), "{a} is not a menu item in lib.rs");
            }
        }
        for id in &ids {
            if DASHBOARD_ONLY_ACTIONS.contains(&id.as_str()) || PAGE_ROUTED_ACTIONS.contains(&id.as_str()) {
                continue;
            }
            let arm = format!("\"{}\" =>", id);
            assert!(
                src.contains(&arm),
                "menu item app_menu:{id} is neither disabled off the dashboard, routed to the app page, nor handled natively"
            );
        }
    }

    #[test]
    fn the_snapshot_reflects_settings_and_daemon_state() {
        let mut s = DesktopSettings::default();
        s.auto_start_server = false;
        s.tunnel_mode = "bogus".into();
        s.expose_on_lan = true;
        let snap = build_snapshot(&s, true, 9000, false, &ServerStatus::Stopped, PortState::Free);
        assert_eq!(
            snap,
            AppSettingsSnapshot {
                auto_start_server: false,
                start_at_login: true,
                tunnel_mode: "none".into(),
                expose_on_lan: true,
                port: 9000,
                cloudflared_found: false,
                daemon_available: false,
            }
        );
        let v = serde_json::to_value(&snap).unwrap();
        for k in ["autoStartServer", "startAtLogin", "tunnelMode", "exposeOnLan", "port", "cloudflaredFound", "daemonAvailable"] {
            assert!(v.get(k).is_some(), "camelCase key {k}");
        }
    }

    #[test]
    fn a_daemon_is_available_only_when_the_own_server_runs_or_one_proved_itself() {
        use ServerStatus::*;
        assert!(daemon_available(&Running, PortState::Free));
        assert!(daemon_available(&Stopped, PortState::Chroxy(8765)));
        assert!(!daemon_available(&Stopped, PortState::Free));
        assert!(!daemon_available(&Stopped, PortState::Foreign(8765)));
        assert!(!daemon_available(&Starting, PortState::Free));
        assert!(!daemon_available(&Restarting, PortState::Foreign(8765)));
        assert!(!daemon_available(&Error("x".into()), PortState::Free));
    }

    #[test]
    fn normalize_tunnel_mode_accepts_only_the_three_modes() {
        for m in ["none", "quick", "named"] {
            assert_eq!(normalize_tunnel_mode(m), m);
        }
        assert_eq!(normalize_tunnel_mode("Quick"), "none");
        assert_eq!(normalize_tunnel_mode(""), "none");
    }

    #[test]
    fn the_port_writer_merges_keeps_keys_and_tightens_permissions() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"apiToken":"secret-token","port":8765,"tunnel":"none"}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        set_port_at(&path, 9100).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["port"], 9100);
        assert_eq!(v["apiToken"], "secret-token");
        assert_eq!(v["tunnel"], "none");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn the_port_writer_adds_the_key_when_the_file_has_none() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"apiToken":"t"}"#).unwrap();
        set_port_at(&path, 1024).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["port"], 1024);
        assert_eq!(v["apiToken"], "t");
    }

    #[test]
    fn the_port_writer_refuses_bad_input_and_leaves_the_file_untouched() {
        let dir = tempfile::TempDir::new().unwrap();

        // A missing file is an error, and is not created.
        let missing = dir.path().join("missing.json");
        assert!(set_port_at(&missing, 9000).unwrap_err().contains("Failed to read"));
        assert!(!missing.exists());

        for (name, body, want) in [
            ("invalid.json", "{not json", "Failed to parse"),
            ("empty.json", "", "Failed to parse"),
            ("array.json", "[1,2,3]", "not a JSON object"),
            ("string.json", "\"hi\"", "not a JSON object"),
            ("null.json", "null", "not a JSON object"),
        ] {
            let p = dir.path().join(name);
            std::fs::write(&p, body).unwrap();
            let err = set_port_at(&p, 9000).unwrap_err();
            assert!(err.contains(want), "{name}: {err}");
            assert_eq!(std::fs::read_to_string(&p).unwrap(), body, "{name} must be byte-identical");
        }

        // An out-of-range port is refused before the file is read or written.
        let ok = dir.path().join("ok.json");
        let body = r#"{"apiToken":"t","port":8765}"#;
        std::fs::write(&ok, body).unwrap();
        for bad in [0u16, 1, 1023] {
            assert!(set_port_at(&ok, bad).is_err(), "{bad}");
            assert_eq!(std::fs::read_to_string(&ok).unwrap(), body);
        }
    }
}
