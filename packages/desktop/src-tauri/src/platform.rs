use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Unified error type for platform file operations.
/// Preserves both path context (for error messages) and the underlying
/// `io::ErrorKind` (for callers to match on `AlreadyExists`, etc.).
#[derive(Debug)]
pub struct PlatformError {
    pub path: PathBuf,
    pub operation: &'static str,
    pub source: io::Error,
}

impl PlatformError {
    pub fn kind(&self) -> io::ErrorKind {
        self.source.kind()
    }
}

impl fmt::Display for PlatformError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Failed to {} {}: {}", self.operation, self.path.display(), self.source)
    }
}

impl std::error::Error for PlatformError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

impl From<PlatformError> for String {
    fn from(e: PlatformError) -> String {
        e.to_string()
    }
}

/// Write data to a file with restricted permissions (0o600 on Unix).
/// Uses OpenOptions with mode to create new files atomically with the correct
/// permissions (avoiding a TOCTOU window), and explicitly tightens permissions
/// on the open file descriptor if the file already existed.
///
/// Callers must ensure the parent directory exists before calling this function.
#[cfg(unix)]
pub fn write_restricted(path: &Path, data: &str) -> Result<(), PlatformError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::PermissionsExt;
    let map_err = |e, op| PlatformError { path: path.to_path_buf(), operation: op, source: e };
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| map_err(e, "open"))?;
    // mode() only applies when creating a new file. If the file already existed
    // with broader permissions, explicitly tighten via fchmod on the open FD.
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| map_err(e, "set permissions on"))?;
    file.write_all(data.as_bytes())
        .map_err(|e| map_err(e, "write"))?;
    Ok(())
}

/// Write data to a file (non-Unix fallback, no permission control).
#[cfg(not(unix))]
pub fn write_restricted(path: &Path, data: &str) -> Result<(), PlatformError> {
    fs::write(path, data).map_err(|e| PlatformError {
        path: path.to_path_buf(), operation: "write", source: e,
    })?;
    Ok(())
}

/// Create a new file atomically with restricted permissions (0o600 on Unix).
/// Fails with `PlatformError` where `kind() == AlreadyExists` if the file
/// already exists, eliminating TOCTOU races between existence check and creation.
#[cfg(unix)]
pub fn write_restricted_new(path: &Path, data: &str) -> Result<(), PlatformError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::PermissionsExt;
    let map_err = |e, op| PlatformError { path: path.to_path_buf(), operation: op, source: e };
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| map_err(e, "create"))?;
    // Ensure final permissions are exactly 0o600, independent of process umask.
    if let Err(e) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
        // Best-effort cleanup so subsequent calls don't hit AlreadyExists on a broken file.
        let _ = fs::remove_file(path);
        return Err(map_err(e, "set permissions on"));
    }
    if let Err(e) = file.write_all(data.as_bytes()) {
        let _ = fs::remove_file(path);
        return Err(map_err(e, "write"));
    }
    Ok(())
}

/// Create a new file atomically (non-Unix fallback).
#[cfg(not(unix))]
pub fn write_restricted_new(path: &Path, data: &str) -> Result<(), PlatformError> {
    use std::io::Write;
    let map_err = |e, op| PlatformError { path: path.to_path_buf(), operation: op, source: e };
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| map_err(e, "create"))?;
    if let Err(e) = file.write_all(data.as_bytes()) {
        let _ = fs::remove_file(path);
        return Err(map_err(e, "write"));
    }
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
    fn write_restricted_new_creates_file_with_0o600() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test-new.json");

        write_restricted_new(&path, r#"{"new": true}"#).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "Expected 0o600, got {:o}", mode);

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"new": true}"#);
    }

    #[test]
    fn write_restricted_new_fails_if_file_exists() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test-exists.json");

        // Create the file first
        fs::write(&path, r#"{"old": true}"#).unwrap();

        // write_restricted_new should fail with AlreadyExists
        let result = write_restricted_new(&path, r#"{"new": true}"#);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        // Verify path context is preserved in error
        assert!(err.to_string().contains("test-exists.json"));

        // Original content should be preserved
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"old": true}"#);
    }

    #[test]
    fn platform_error_preserves_path_and_kind() {
        let err = PlatformError {
            path: std::path::PathBuf::from("/tmp/test.json"),
            operation: "write",
            source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied"),
        };
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(err.to_string().contains("/tmp/test.json"));
        assert!(err.to_string().contains("write"));
        assert!(err.to_string().contains("access denied"));

        // Verify String conversion works (used by settings.rs ? operator)
        let s: String = err.into();
        assert!(s.contains("/tmp/test.json"));
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
