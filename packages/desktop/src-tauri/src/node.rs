use std::fs;
use std::path::PathBuf;
use std::process::Command;

const MIN_NODE_MAJOR: u32 = 22;

/// Parse major version from a Node version string like "v22.22.0".
fn parse_major(version: &str) -> Option<u32> {
    version
        .strip_prefix('v')
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.parse().ok())
}

/// Search common locations for Node >= 22, verify the version, and return the path.
/// Prefers Node 22 at well-known paths, then falls back to any Node >= 22 on PATH.
pub fn resolve_node22() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // macOS/Linux: Homebrew paths
    #[cfg(unix)]
    {
        // Homebrew (Apple Silicon)
        candidates.push(PathBuf::from("/opt/homebrew/opt/node@22/bin/node"));
        // Homebrew (Intel)
        candidates.push(PathBuf::from("/usr/local/opt/node@22/bin/node"));
    }

    // Windows: common install locations
    #[cfg(windows)]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(format!("{}/nodejs/node.exe", pf)));
        }
        // nvm-windows
        if let Some(home) = dirs::home_dir() {
            let nvm_dir = home.join("AppData/Roaming/nvm");
            if nvm_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(&nvm_dir) {
                    let mut eligible: Vec<PathBuf> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path())
                        .filter(|p| {
                            p.file_name()
                                .and_then(|n| n.to_str())
                                .and_then(|n| parse_major(&format!("v{}", n)))
                                .map(|major| major >= MIN_NODE_MAJOR)
                                .unwrap_or(false)
                        })
                        .collect();
                    eligible.sort();
                    for d in eligible {
                        candidates.push(d.join("node.exe"));
                    }
                }
            }
        }
    }

    // nvm (Unix) — glob for v22.* and above, prefer v22 first
    #[cfg(unix)]
    if let Some(home) = dirs::home_dir() {
        let nvm_dir = home.join(".nvm/versions/node");
        if nvm_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&nvm_dir) {
                let mut eligible: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .and_then(|n| parse_major(n))
                            .map(|major| major >= MIN_NODE_MAJOR)
                            .unwrap_or(false)
                    })
                    .collect();
                // Sort so v22.x comes before v23+
                eligible.sort();
                for d in eligible {
                    candidates.push(d.join("bin/node"));
                }
            }
        }
    }

    // Unix: Homebrew "current" node (may be 22+)
    #[cfg(unix)]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
        candidates.push(PathBuf::from("/usr/local/bin/node"));
    }

    // Check each candidate
    for candidate in &candidates {
        if candidate.exists() {
            if let Ok(output) = Command::new(candidate).arg("--version").output() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Some(major) = parse_major(&version) {
                    if major >= MIN_NODE_MAJOR {
                        return Ok(candidate.clone());
                    }
                }
            }
        }
    }

    // Fall back to `which`/`where` node and check version
    #[cfg(unix)]
    let which_cmd = "which";
    #[cfg(windows)]
    let which_cmd = "where";
    if let Ok(output) = Command::new(which_cmd).arg("node").output() {
        let which_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !which_path.is_empty() {
            let node_path = PathBuf::from(&which_path);
            if node_path.exists() {
                if let Ok(ver_output) = Command::new(&node_path).arg("--version").output() {
                    let version =
                        String::from_utf8_lossy(&ver_output.stdout).trim().to_string();
                    if let Some(major) = parse_major(&version) {
                        if major >= MIN_NODE_MAJOR {
                            return Ok(node_path);
                        }
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    let install_hint = "Could not find Node.js >= 22. Install it via:\n  \
         brew install node@22\n  \
         or use nvm: nvm install 22";
    #[cfg(windows)]
    let install_hint = "Could not find Node.js >= 22. Install it from:\n  \
         https://nodejs.org/\n  \
         or use nvm-windows: nvm install 22";
    Err(install_hint.to_string())
}
