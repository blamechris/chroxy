use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// Search common locations for Node 22, verify the version, and return the path.
/// Mirrors the search order in packages/server/src/service.js:resolveNode22Path().
pub fn resolve_node22() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Homebrew (Apple Silicon)
    candidates.push(PathBuf::from("/opt/homebrew/opt/node@22/bin/node"));
    // Homebrew (Intel)
    candidates.push(PathBuf::from("/usr/local/opt/node@22/bin/node"));

    // nvm — glob for latest v22.*
    if let Some(home) = dirs::home_dir() {
        let nvm_dir = home.join(".nvm/versions/node");
        if nvm_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&nvm_dir) {
                let mut v22_dirs: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .map(|n| n.starts_with("v22."))
                            .unwrap_or(false)
                    })
                    .collect();
                v22_dirs.sort();
                v22_dirs.reverse();
                for d in v22_dirs {
                    candidates.push(d.join("bin/node"));
                }
            }
        }
    }

    // Check each candidate
    for candidate in &candidates {
        if candidate.exists() {
            if let Ok(output) = Command::new(candidate).arg("--version").output() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if version.starts_with("v22") {
                    return Ok(candidate.clone());
                }
            }
        }
    }

    // Fall back to `which node` and check version
    if let Ok(output) = Command::new("which").arg("node").output() {
        let which_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !which_path.is_empty() {
            let node_path = PathBuf::from(&which_path);
            if node_path.exists() {
                if let Ok(ver_output) = Command::new(&node_path).arg("--version").output() {
                    let version =
                        String::from_utf8_lossy(&ver_output.stdout).trim().to_string();
                    if version.starts_with("v22") {
                        return Ok(node_path);
                    }
                }
            }
        }
    }

    Err(
        "Could not find Node.js 22. Install it via:\n  \
         brew install node@22\n  \
         or use nvm: nvm install 22"
            .to_string(),
    )
}
