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

/// Create a new file atomically with restricted permissions (0o600 on Unix).
/// Fails with `std::io::ErrorKind::AlreadyExists` if the file already exists,
/// eliminating TOCTOU races between existence check and file creation.
#[cfg(unix)]
pub fn write_restricted_new(path: &Path, data: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::PermissionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    // Ensure final permissions are exactly 0o600, independent of process umask.
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(data.as_bytes())?;
    Ok(())
}

/// Create a new file atomically (non-Unix fallback).
#[cfg(not(unix))]
pub fn write_restricted_new(path: &Path, data: &str) -> std::io::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(data.as_bytes())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn creates_file_with_0o600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "chroxy-test-platform-create-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test-restricted.json");
        let _ = fs::remove_file(&path);

        write_restricted(&path, r#"{"test": true}"#).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "Expected 0o600, got {:o}", mode);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn overwrites_existing_file_preserving_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "chroxy-test-platform-overwrite-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test-overwrite.json");

        write_restricted(&path, r#"{"v": 1}"#).unwrap();
        write_restricted(&path, r#"{"v": 2}"#).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"v": 2}"#);

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn write_restricted_new_creates_file_with_0o600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "chroxy-test-platform-new-create-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test-new.json");
        let _ = fs::remove_file(&path);

        write_restricted_new(&path, r#"{"new": true}"#).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "Expected 0o600, got {:o}", mode);

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"new": true}"#);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn write_restricted_new_fails_if_file_exists() {
        let dir = std::env::temp_dir().join(format!(
            "chroxy-test-platform-new-exists-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test-exists.json");

        // Create the file first
        fs::write(&path, r#"{"old": true}"#).unwrap();

        // write_restricted_new should fail with AlreadyExists
        let result = write_restricted_new(&path, r#"{"new": true}"#);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);

        // Original content should be preserved
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"old": true}"#);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn tightens_permissions_on_existing_broad_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "chroxy-test-platform-tighten-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("test-broad.json");

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

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }
}
