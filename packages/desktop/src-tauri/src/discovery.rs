//! LAN discovery of chroxy daemons via mDNS (#5281 ③).
//!
//! The server advertises `_chroxy._tcp` with an instance name of
//! `Chroxy (<hostname>)` and a `version` TXT record (see
//! `packages/server/src/server-cli.js` `maybeAdvertiseMdns`). This module
//! browses for that service on the LAN and resolves each daemon into a
//! [`DiscoveredServer`] the dashboard's ServerPicker can pre-fill.
//!
//! The hostname comes straight from the advertised instance name — so we never
//! need the daemon's `/health` to expose it (a deliberately-guarded field), and
//! there's no new exposure beyond what mDNS already broadcasts on the LAN.

use serde::Serialize;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

const SERVICE_TYPE: &str = "_chroxy._tcp.local.";

/// A chroxy daemon found on the LAN.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    /// Human label — the daemon's machine name, parsed from the mDNS instance
    /// name (`Chroxy (<hostname>)`), with the address as a fallback.
    pub name: String,
    /// First usable address (IPv4 preferred).
    pub host: String,
    pub port: u16,
    /// `ws://` endpoint, pre-fillable into the ServerPicker add form.
    pub ws_url: String,
    /// Advertised server version (TXT `version`), if present.
    pub version: Option<String>,
}

/// Extract the daemon machine name from an mDNS instance name.
/// `Chroxy (mac-host)` → `mac-host`; anything else is returned as-is.
pub fn parse_instance_name(instance: &str) -> String {
    if let Some(open) = instance.find('(') {
        if let Some(rel_close) = instance[open + 1..].find(')') {
            let inner = instance[open + 1..open + 1 + rel_close].trim();
            if !inner.is_empty() {
                return inner.to_string();
            }
        }
    }
    instance.trim().to_string()
}

/// Strip the service-type/domain suffix from a resolved fullname, leaving just
/// the instance label. `Chroxy (host)._chroxy._tcp.local.` → `Chroxy (host)`.
pub fn instance_label(fullname: &str) -> &str {
    fullname.split("._chroxy._tcp").next().unwrap_or(fullname)
}

/// Build a `ws://` authority, bracketing IPv6 literals so the URL is well-formed.
pub fn ws_url(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("ws://[{}]:{}/ws", host, port)
    } else {
        format!("ws://{}:{}/ws", host, port)
    }
}

/// Pick the address a client should connect to — IPv4 first (LAN-friendly,
/// no scope-id hassle), else the first address of any kind.
pub fn pick_address<'a, I: IntoIterator<Item = &'a IpAddr>>(addrs: I) -> Option<String> {
    let mut first_any: Option<String> = None;
    for addr in addrs {
        if addr.is_ipv4() {
            return Some(addr.to_string());
        }
        if first_any.is_none() {
            first_any = Some(addr.to_string());
        }
    }
    first_any
}

/// Assemble a [`DiscoveredServer`] from resolved mDNS fields.
pub fn build_discovered(
    fullname: &str,
    host: &str,
    port: u16,
    version: Option<String>,
) -> DiscoveredServer {
    let label = instance_label(fullname);
    let name = {
        let parsed = parse_instance_name(label);
        if parsed.is_empty() { host.to_string() } else { parsed }
    };
    DiscoveredServer {
        name,
        host: host.to_string(),
        port,
        ws_url: ws_url(host, port),
        version,
    }
}

/// Browse the LAN for `_chroxy._tcp` daemons for `timeout`, returning a
/// de-duplicated (by host:port), name-sorted list. Blocking — call off the UI
/// thread. Never panics: daemon/socket errors surface as `Err`.
pub fn browse_lan(timeout: Duration) -> Result<Vec<DiscoveredServer>, String> {
    use mdns_sd::{ServiceDaemon, ServiceEvent};

    let mdns = ServiceDaemon::new().map_err(|e| format!("mDNS init failed: {e}"))?;
    let receiver = mdns
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("mDNS browse failed: {e}"))?;

    let deadline = Instant::now() + timeout;
    let mut found: HashMap<String, DiscoveredServer> = HashMap::new();

    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                // mdns-sd yields `ScopedIp`; flatten to plain IpAddr for selection.
                let ips: Vec<IpAddr> =
                    info.get_addresses().iter().map(|s| s.to_ip_addr()).collect();
                if let Some(host) = pick_address(ips.iter()) {
                    let version = info
                        .get_property_val_str("version")
                        .map(|s| s.to_string());
                    let ds = build_discovered(info.get_fullname(), &host, info.get_port(), version);
                    found.insert(format!("{}:{}", ds.host, ds.port), ds);
                }
            }
            Ok(_) => {}
            // Timed out waiting for the next event — browse window is over.
            Err(_) => break,
        }
    }

    // Best-effort shutdown; a failure here doesn't invalidate what we found.
    let _ = mdns.shutdown();

    let mut servers: Vec<DiscoveredServer> = found.into_values().collect();
    servers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(servers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn parse_instance_name_extracts_hostname() {
        assert_eq!(parse_instance_name("Chroxy (mac-host)"), "mac-host");
        assert_eq!(parse_instance_name("Chroxy (My MacBook Pro)"), "My MacBook Pro");
    }

    #[test]
    fn parse_instance_name_falls_back_to_raw() {
        assert_eq!(parse_instance_name("Chroxy"), "Chroxy");
        assert_eq!(parse_instance_name("Chroxy ()"), "Chroxy ()");
        assert_eq!(parse_instance_name("weird (   )"), "weird (   )");
    }

    #[test]
    fn instance_label_strips_service_suffix() {
        assert_eq!(
            instance_label("Chroxy (host)._chroxy._tcp.local."),
            "Chroxy (host)"
        );
        assert_eq!(instance_label("plain"), "plain");
    }

    #[test]
    fn ws_url_brackets_ipv6_only() {
        assert_eq!(ws_url("192.168.1.5", 8765), "ws://192.168.1.5:8765/ws");
        assert_eq!(ws_url("fe80::1", 8765), "ws://[fe80::1]:8765/ws");
    }

    #[test]
    fn pick_address_prefers_ipv4() {
        let v6: IpAddr = Ipv6Addr::LOCALHOST.into();
        let v4: IpAddr = Ipv4Addr::new(192, 168, 1, 5).into();
        let addrs = vec![v6, v4];
        assert_eq!(pick_address(addrs.iter()), Some("192.168.1.5".to_string()));
    }

    #[test]
    fn pick_address_falls_back_to_ipv6_when_no_ipv4() {
        let v6: IpAddr = Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1).into();
        let addrs = vec![v6];
        assert_eq!(pick_address(addrs.iter()), Some("fe80::1".to_string()));
    }

    #[test]
    fn pick_address_none_when_empty() {
        let addrs: Vec<IpAddr> = vec![];
        assert_eq!(pick_address(addrs.iter()), None);
    }

    #[test]
    fn build_discovered_full_shape() {
        let ds = build_discovered(
            "Chroxy (devbox)._chroxy._tcp.local.",
            "192.168.1.9",
            8765,
            Some("0.9.44".to_string()),
        );
        assert_eq!(ds.name, "devbox");
        assert_eq!(ds.host, "192.168.1.9");
        assert_eq!(ds.port, 8765);
        assert_eq!(ds.ws_url, "ws://192.168.1.9:8765/ws");
        assert_eq!(ds.version.as_deref(), Some("0.9.44"));
    }

    #[test]
    fn build_discovered_name_falls_back_to_host() {
        // A nameless/odd instance shouldn't yield an empty label.
        let ds = build_discovered("._chroxy._tcp.local.", "10.0.0.2", 9000, None);
        assert_eq!(ds.name, "10.0.0.2");
        assert!(ds.version.is_none());
    }

    #[test]
    fn discovered_server_serializes_camel_case() {
        let ds = build_discovered("Chroxy (h)._chroxy._tcp.local.", "1.2.3.4", 8765, None);
        let json = serde_json::to_value(&ds).unwrap();
        assert_eq!(json["name"], "h");
        assert_eq!(json["wsUrl"], "ws://1.2.3.4:8765/ws");
        assert!(json.get("ws_url").is_none(), "must be camelCase wsUrl");
    }
}
