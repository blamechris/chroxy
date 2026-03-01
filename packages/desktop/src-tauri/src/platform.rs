use std::fs;
use std::path::Path;

/// Write data to a file with restricted permissions (0o600 on Unix).
/// Uses OpenOptions with mode to create new files atomically with the correct
/// permissions (avoiding a TOCTOU window), and explicitly tightens permissions
/// on the open file descriptor if the file already existed.
///
/// Callers must ensure the parent directory exists before calling this function.
#[cfg(unix)]
pub fn write_restricted(path: &Path, data: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::PermissionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
    // mode() only applies when creating a new file. If the file already existed
    // with broader permissions, explicitly tighten via fchmod on the open FD.
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("Failed to set permissions on {}: {}", path.display(), e))?;
    file.write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

/// Write data to a file (non-Unix fallback, no permission control).
#[cfg(not(unix))]
pub fn write_restricted(path: &Path, data: &str) -> Result<(), String> {
    fs::write(path, data).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    #[test]
    fn creates_file_with_0o600_permissions() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test-restricted.json");

        write_restricted(&path, r#"{"test": true}"#).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "Expected 0o600, got {:o}", mode);
    }

    #[test]
    fn overwrites_existing_file_preserving_permissions() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test-overwrite.json");

        write_restricted(&path, r#"{"v": 1}"#).unwrap();
        write_restricted(&path, r#"{"v": 2}"#).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"v": 2}"#);

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn tightens_permissions_on_existing_broad_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test-broad.json");

        // Create file with overly broad permissions (0o644)
        fs::write(&path, r#"{"old": true}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "Precondition: file should start at 0o644");

        // write_restricted should tighten to 0o600
        write_restricted(&path, r#"{"new": true}"#).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "Expected 0o600 after tightening, got {:o}", mode);

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"new": true}"#);
    }
}
