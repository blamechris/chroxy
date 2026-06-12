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
    /// #5356 — when false (the default), the embedded server binds loopback
    /// (`127.0.0.1`) so the control socket is reachable only from this machine.
    /// Set true to bind all interfaces (`0.0.0.0`) for the "scan QR from my
    /// phone on the same wifi" LAN flow — explicit opt-in, not the default.
    #[serde(default)]
    pub expose_on_lan: bool,
    #[serde(default)]
    pub last_window_x: Option<f64>,
    #[serde(default)]
    pub last_window_y: Option<f64>,
    #[serde(default)]
    pub last_window_width: Option<f64>,
    #[serde(default)]
    pub last_window_height: Option<f64>,
    /// Global "summon" hotkey accelerator (Tauri syntax, e.g.
    /// "CmdOrCtrl+Shift+K"). #5281 ② — opt-in: `None` (the default) registers
    /// NO global shortcut, so chroxy never silently steals a chord from another
    /// app. The always-available "Show Chroxy" tray item is the baseline
    /// summon; this is for users who want a system-wide one.
    #[serde(default)]
    pub summon_hotkey: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_tunnel_mode() -> String {
    "none".to_string()
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            auto_start_server: true,
            show_notifications: true,
            tunnel_mode: "none".to_string(),
            expose_on_lan: false,
            node_path: None,
            last_window_x: None,
            last_window_y: None,
            last_window_width: None,
            last_window_height: None,
            summon_hotkey: None,
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

        crate::platform::write_restricted(&path, &json)?;

        Ok(())
    }

    /// The summon accelerator to actually register, or `None` to register no
    /// global shortcut. Treats unset / blank / whitespace-only as "no hotkey"
    /// so a user can disable it by clearing the field without removing the key.
    pub fn effective_summon_hotkey(&self) -> Option<String> {
        match self.summon_hotkey.as_deref() {
            Some(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
            _ => None,
        }
    }

    /// Parse settings from a JSON string. Test-only helper.
    #[cfg(test)]
    pub(crate) fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Serialize settings to a JSON string. Test-only helper.
    #[cfg(test)]
    pub(crate) fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings() {
        let settings = DesktopSettings::default();
        assert!(settings.auto_start_server);
        assert!(settings.show_notifications);
        assert_eq!(settings.tunnel_mode, "none");
        assert!(settings.node_path.is_none());
        assert!(settings.last_window_x.is_none());
    }

    #[test]
    fn parse_full_settings() {
        let json = r#"{
            "autoStartServer": false,
            "showNotifications": false,
            "nodePath": "/usr/local/bin/node",
            "tunnelMode": "named",
            "lastWindowX": 100.0,
            "lastWindowY": 200.0,
            "lastWindowWidth": 800.0,
            "lastWindowHeight": 600.0
        }"#;
        let settings = DesktopSettings::from_json(json).unwrap();
        assert!(!settings.auto_start_server);
        assert!(!settings.show_notifications);
        assert_eq!(settings.node_path.as_deref(), Some("/usr/local/bin/node"));
        assert_eq!(settings.tunnel_mode, "named");
        assert_eq!(settings.last_window_x, Some(100.0));
    }

    #[test]
    fn parse_empty_object_uses_defaults() {
        let settings = DesktopSettings::from_json("{}").unwrap();
        assert!(settings.auto_start_server);
        assert!(settings.show_notifications);
        assert_eq!(settings.tunnel_mode, "none");
    }

    #[test]
    fn expose_on_lan_defaults_to_false() {
        // #5356 — loopback by default: the embedded server must NOT bind all
        // interfaces unless the user explicitly opts into LAN exposure.
        assert!(!DesktopSettings::default().expose_on_lan);
        assert!(!DesktopSettings::from_json("{}").unwrap().expose_on_lan);
    }

    #[test]
    fn expose_on_lan_round_trips() {
        let mut settings = DesktopSettings::default();
        settings.expose_on_lan = true;
        let json = settings.to_json().unwrap();
        let restored = DesktopSettings::from_json(&json).unwrap();
        assert!(restored.expose_on_lan);
    }

    #[test]
    fn round_trip_serialize_deserialize() {
        let mut settings = DesktopSettings::default();
        settings.tunnel_mode = "quick".to_string();
        settings.auto_start_server = false;

        let json = settings.to_json().unwrap();
        let restored = DesktopSettings::from_json(&json).unwrap();
        assert!(!restored.auto_start_server);
        assert_eq!(restored.tunnel_mode, "quick");
    }

    #[test]
    fn summon_hotkey_defaults_to_none() {
        let settings = DesktopSettings::default();
        assert!(settings.summon_hotkey.is_none());
        // No hotkey unless the user opts in.
        assert!(settings.effective_summon_hotkey().is_none());
    }

    #[test]
    fn summon_hotkey_round_trips() {
        let mut settings = DesktopSettings::default();
        settings.summon_hotkey = Some("CmdOrCtrl+Shift+K".to_string());
        let json = settings.to_json().unwrap();
        let restored = DesktopSettings::from_json(&json).unwrap();
        assert_eq!(restored.summon_hotkey.as_deref(), Some("CmdOrCtrl+Shift+K"));
        assert_eq!(restored.effective_summon_hotkey().as_deref(), Some("CmdOrCtrl+Shift+K"));
    }

    #[test]
    fn effective_summon_hotkey_trims_and_treats_blank_as_disabled() {
        let mut settings = DesktopSettings::default();
        settings.summon_hotkey = Some("  ".to_string());
        assert!(settings.effective_summon_hotkey().is_none());
        settings.summon_hotkey = Some("  CmdOrCtrl+Shift+K  ".to_string());
        assert_eq!(settings.effective_summon_hotkey().as_deref(), Some("CmdOrCtrl+Shift+K"));
        settings.summon_hotkey = Some(String::new());
        assert!(settings.effective_summon_hotkey().is_none());
    }

    #[test]
    fn parse_omits_summon_hotkey_uses_none() {
        // Older settings files won't have the field — must deserialize to None.
        let settings = DesktopSettings::from_json("{}").unwrap();
        assert!(settings.summon_hotkey.is_none());
    }

    #[test]
    fn settings_path_returns_some() {
        let path = DesktopSettings::path();
        assert!(path.is_some());
        let p = path.unwrap();
        assert!(p.ends_with(".chroxy/desktop-settings.json"));
    }
}
