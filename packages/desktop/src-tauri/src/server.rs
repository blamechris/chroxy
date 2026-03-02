use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{self, ChroxyConfig};
use crate::lock_or_recover;
use crate::node;

/// Current state of the server process.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerStatus {
    Stopped,
    Starting,
    Running,
    Restarting,
    Error(String),
}

impl ServerStatus {
    pub fn label(&self) -> &str {
        match self {
            ServerStatus::Stopped => "Stopped",
            ServerStatus::Starting => "Starting...",
            ServerStatus::Running => "Running",
            ServerStatus::Restarting => "Restarting...",
            ServerStatus::Error(_) => "Error",
        }
    }
}

/// Manages the Chroxy server child process.
pub struct ServerManager {
    status: Arc<Mutex<ServerStatus>>,
    child: Option<Child>,
    log_buffer: Arc<Mutex<VecDeque<String>>>,
    node_path: Option<PathBuf>,
    config: ChroxyConfig,
    tunnel_mode: String,
    health_generation: Arc<AtomicU64>,
    /// Set by stop() to prevent auto-restart after user-initiated stop.
    user_stopped: Arc<AtomicBool>,
    /// Set by health poll when crash detected; cleared by try_auto_restart().
    auto_restart_pending: Arc<AtomicBool>,
    /// Consecutive auto-restart attempts; reset when server reaches Running.
    restart_count: Arc<AtomicU32>,
}

impl ServerManager {
    /// Maximum auto-restart attempts before giving up.
    pub const MAX_RESTART_ATTEMPTS: u32 = 3;

    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(ServerStatus::Stopped)),
            child: None,
            log_buffer: Arc::new(Mutex::new(VecDeque::with_capacity(100))),
            node_path: None,
            config: ChroxyConfig::default(),
            tunnel_mode: "quick".to_string(),
            health_generation: Arc::new(AtomicU64::new(0)),
            user_stopped: Arc::new(AtomicBool::new(false)),
            auto_restart_pending: Arc::new(AtomicBool::new(false)),
            restart_count: Arc::new(AtomicU32::new(0)),
        }
    }

    pub fn status(&self) -> ServerStatus {
        lock_or_recover(&self.status).clone()
    }

    pub fn is_running(&self) -> bool {
        matches!(self.status(), ServerStatus::Running)
    }

    pub fn port(&self) -> u16 {
        self.config.port
    }

    pub fn token(&self) -> Option<String> {
        self.config.api_token.clone()
    }

    pub fn tunnel_mode(&self) -> &str {
        &self.tunnel_mode
    }

    pub fn set_tunnel_mode(&mut self, mode: &str) {
        self.tunnel_mode = mode.to_string();
    }

    /// Whether auto-restart has been requested by the health poll.
    pub fn is_auto_restart_pending(&self) -> bool {
        self.auto_restart_pending.load(Ordering::Relaxed)
    }

    /// Current consecutive restart attempt count.
    pub fn restart_count(&self) -> u32 {
        self.restart_count.load(Ordering::Relaxed)
    }

    /// Backoff delay for auto-restart: 3s, 6s, 12s.
    pub fn restart_backoff(&self) -> Duration {
        let count = self.restart_count.load(Ordering::Relaxed);
        Duration::from_secs(match count {
            0 => 3,
            1 => 6,
            _ => 12,
        })
    }

    /// Kill any process listening on the given port (cleanup from previous crash).
    fn kill_port_holder(port: u16) {
        if let Ok(output) = Command::new("lsof")
            .args(["-ti", &format!("tcp:{}", port)])
            .output()
        {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid_str in pids.split_whitespace() {
                if let Ok(pid) = pid_str.trim().parse::<i32>() {
                    unsafe { libc::kill(pid, libc::SIGTERM); }
                }
            }
            if !pids.trim().is_empty() {
                // Give processes a moment to exit
                thread::sleep(Duration::from_millis(500));
            }
        }
    }

    /// Check whether `cloudflared` is available on PATH.
    pub fn check_cloudflared() -> bool {
        Command::new("which")
            .arg("cloudflared")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Start the Chroxy server as a child process.
    pub fn start(&mut self) -> Result<(), String> {
        if matches!(self.status(), ServerStatus::Running | ServerStatus::Starting) {
            return Err("Server is already running".to_string());
        }

        // Reset auto-restart state on user-initiated start
        self.user_stopped.store(false, Ordering::Relaxed);
        self.auto_restart_pending.store(false, Ordering::Relaxed);
        self.restart_count.store(0, Ordering::Relaxed);

        self.start_server_process()
    }

    /// Internal: spawn the server process and start health polling.
    fn start_server_process(&mut self) -> Result<(), String> {
        // Reload config each start
        self.config = config::load_config();

        // Kill any orphaned server on the port (e.g. from a previous crash)
        Self::kill_port_holder(self.config.port);

        // Resolve Node 22 path
        let node_path = match &self.node_path {
            Some(p) => p.clone(),
            None => {
                let p = node::resolve_node22()?;
                self.node_path = Some(p.clone());
                p
            }
        };

        // Resolve cli.js path
        let cli_js = Self::resolve_cli_js()?;

        *lock_or_recover(&self.status) = ServerStatus::Starting;

        // Build command
        let mut cmd = Command::new(&node_path);
        cmd.arg(&cli_js).arg("start");

        // Build a comprehensive PATH.  macOS GUI apps inherit a minimal
        // PATH (/usr/bin:/bin:/usr/sbin:/sbin) which misses Homebrew,
        // nvm, and tools like cloudflared. Prepend common locations.
        let node_bin = node_path.parent().unwrap().display().to_string();
        let base_path = std::env::var("PATH").unwrap_or_default();
        let mut extra_dirs: Vec<String> = vec![node_bin];
        // Homebrew
        for dir in &["/opt/homebrew/bin", "/usr/local/bin"] {
            if !base_path.contains(dir) {
                extra_dirs.push(dir.to_string());
            }
        }
        // User-local bins
        if let Some(home) = dirs::home_dir() {
            let local_bin = home.join(".local/bin");
            if local_bin.is_dir() {
                extra_dirs.push(local_bin.display().to_string());
            }
        }
        let full_path = format!("{}:{}", extra_dirs.join(":"), base_path);
        cmd.env("PATH", &full_path);
        // Ensure HOME is set — macOS GUI apps may not inherit it
        if let Some(home) = dirs::home_dir() {
            cmd.env("HOME", home);
        }
        // Pass config as env vars (same pattern as supervisor.js)
        if let Some(ref token) = self.config.api_token {
            cmd.env("API_TOKEN", token);
        }
        cmd.env("PORT", self.config.port.to_string());
        if let Some(ref cwd) = self.config.cwd {
            cmd.env("CHROXY_CWD", cwd);
        }
        if let Some(ref model) = self.config.model {
            cmd.env("CHROXY_MODEL", model);
        }
        // Tunnel mode: "quick", "named", or "none"
        cmd.env("CHROXY_TUNNEL", &self.tunnel_mode);
        // No supervisor — tray app IS the supervisor
        cmd.arg("--no-supervisor");

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn server: {}", e))?;

        // Capture stdout in background thread
        let log_buf = self.log_buffer.clone();
        if let Some(stdout) = child.stdout.take() {
            let buf = log_buf.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    let mut logs = lock_or_recover(&buf);
                    if logs.len() >= 100 {
                        logs.pop_front();
                    }
                    logs.push_back(line);
                }
            });
        }

        // Capture stderr in background thread
        if let Some(stderr) = child.stderr.take() {
            let buf = log_buf;
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    let mut logs = lock_or_recover(&buf);
                    if logs.len() >= 100 {
                        logs.pop_front();
                    }
                    logs.push_back(format!("[stderr] {}", line));
                }
            });
        }

        self.child = Some(child);

        // Start health polling in background
        self.start_health_poll();

        Ok(())
    }

    /// Internal: kill the child process and clear the handle.
    /// Does NOT change status — callers decide what status to set.
    fn kill_child(&mut self) {
        // Stop health polling by advancing generation (old threads will see mismatch and exit)
        self.health_generation.fetch_add(1, Ordering::SeqCst);

        if let Some(ref mut child) = self.child {
            // Only send SIGTERM if the child is still running
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => {
                    // Child already exited or cannot be inspected; skip signalling
                }
                Ok(None) => {
                    // SAFETY: We just confirmed the child is still running via try_wait().
                    // The PID (child.id()) belongs to our direct child process, which
                    // has not yet exited, so PID reuse cannot occur here.
                    unsafe {
                        libc::kill(child.id() as i32, libc::SIGTERM);
                    }

                    // Wait up to 5 seconds for graceful shutdown
                    let start = Instant::now();
                    loop {
                        match child.try_wait() {
                            Ok(Some(_)) => break,
                            Ok(None) => {
                                if start.elapsed() > Duration::from_secs(5) {
                                    // Force kill
                                    let _ = child.kill();
                                    let _ = child.wait();
                                    break;
                                }
                                thread::sleep(Duration::from_millis(100));
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        }

        self.child = None;
    }

    /// Internal stop: kill process and set status to Stopped.
    fn stop_process(&mut self) {
        self.kill_child();
        *lock_or_recover(&self.status) = ServerStatus::Stopped;
    }

    /// Stop the server process gracefully. Prevents auto-restart.
    pub fn stop(&mut self) {
        self.user_stopped.store(true, Ordering::Relaxed);
        self.auto_restart_pending.store(false, Ordering::Relaxed);
        self.stop_process();
    }

    /// Restart: stop then start (resets auto-restart state via start()).
    pub fn restart(&mut self) -> Result<(), String> {
        self.kill_child();
        self.start()
    }

    /// Attempt auto-restart after crash detection.
    /// Increments restart count. Returns Err if max attempts exceeded or start fails.
    pub fn try_auto_restart(&mut self) -> Result<(), String> {
        let count = self.restart_count.load(Ordering::Relaxed);
        if count >= Self::MAX_RESTART_ATTEMPTS {
            *lock_or_recover(&self.status) = ServerStatus::Error(
                format!("Auto-restart failed after {} attempts", Self::MAX_RESTART_ATTEMPTS),
            );
            return Err("Max restart attempts exceeded".to_string());
        }
        self.restart_count.fetch_add(1, Ordering::Relaxed);

        self.auto_restart_pending.store(false, Ordering::Relaxed);
        *lock_or_recover(&self.status) = ServerStatus::Restarting;
        self.kill_child();
        match self.start_server_process() {
            Ok(()) => Ok(()),
            Err(e) => {
                *lock_or_recover(&self.status) = ServerStatus::Error(e.clone());
                self.auto_restart_pending.store(true, Ordering::Relaxed);
                Err(e)
            }
        }
    }

    /// Poll the health endpoint every 2s until Running or timeout (60s),
    /// then monitor continuously. Signals auto-restart on crash detection.
    /// Uses a generation counter to ensure old threads exit when a new poll starts.
    fn start_health_poll(&self) {
        let status = self.status.clone();
        let port = self.config.port;
        let generation = self.health_generation.clone();
        let user_stopped = self.user_stopped.clone();
        let auto_restart_pending = self.auto_restart_pending.clone();
        let restart_count = self.restart_count.clone();

        // Advance generation so any existing poll thread sees a mismatch and exits
        let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;

        thread::spawn(move || {
            let start = Instant::now();
            // Use 127.0.0.1 (not localhost) to avoid IPv6 resolution issues
            // in macOS GUI app context where DNS may resolve differently.
            let url = format!("http://127.0.0.1:{}/", port);

            loop {
                if generation.load(Ordering::SeqCst) != my_gen {
                    return;
                }

                if start.elapsed() > Duration::from_secs(60) {
                    let mut s = lock_or_recover(&status);
                    if *s == ServerStatus::Starting {
                        *s = ServerStatus::Error("Health check timeout after 60s".to_string());
                    }
                    return;
                }

                match ureq::get(&url).timeout(Duration::from_secs(2)).call() {
                    Ok(resp) => {
                        if resp.status() == 200 {
                            *lock_or_recover(&status) = ServerStatus::Running;
                            // Reset restart count on successful startup
                            restart_count.store(0, Ordering::Relaxed);
                            break;
                        }
                    }
                    Err(_) => {
                        // Not ready yet
                    }
                }

                thread::sleep(Duration::from_secs(2));
            }

            // Continue monitoring while running
            loop {
                if generation.load(Ordering::SeqCst) != my_gen {
                    return;
                }

                thread::sleep(Duration::from_secs(5));

                if generation.load(Ordering::SeqCst) != my_gen {
                    return;
                }

                match ureq::get(&url).timeout(Duration::from_secs(2)).call() {
                    Ok(resp) => {
                        if resp.status() == 200 {
                            *lock_or_recover(&status) = ServerStatus::Running;
                        }
                    }
                    Err(_) => {
                        let mut s = lock_or_recover(&status);
                        if *s == ServerStatus::Running {
                            *s = ServerStatus::Error("Server stopped responding".to_string());
                            // Signal auto-restart unless user explicitly stopped
                            if !user_stopped.load(Ordering::Relaxed) {
                                auto_restart_pending.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                }
            }
        });
    }

    /// Resolve the chroxy CLI entry point (cli.js).
    /// Checks: bundled .app resources, monorepo relative, CHROXY_SERVER_PATH env, `which chroxy`.
    fn resolve_cli_js() -> Result<PathBuf, String> {
        // Strategy 1: Bundled inside .app (macOS).
        // Binary lives at Contents/MacOS/chroxy-desktop,
        // resources at Contents/Resources/server/src/cli.js.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(contents_dir) = exe.parent().and_then(|p| p.parent()) {
                let bundled = contents_dir.join("Resources/server/src/cli.js");
                if bundled.exists() {
                    return Ok(bundled);
                }
            }
        }

        // Strategy 2: Monorepo path relative to the Tauri binary.
        // Walk up to 6 parent directories to find the monorepo root.
        // In dev: packages/desktop/src-tauri/target/debug/chroxy-desktop (5 levels up)
        // In release: packages/desktop/src-tauri/target/release/chroxy-desktop (5 levels up)
        // Extra level provides margin for nested build configurations.
        if let Ok(exe) = std::env::current_exe() {
            let mut dir = exe.parent().map(|p| p.to_path_buf());
            for _ in 0..6 {
                if let Some(d) = dir {
                    let cli = d.join("packages/server/src/cli.js");
                    if cli.exists() {
                        return Ok(cli);
                    }
                    dir = d.parent().map(|p| p.to_path_buf());
                } else {
                    break;
                }
            }
        }

        // Strategy 3: CHROXY_SERVER_PATH env — canonicalize and verify it's a .js file
        if let Ok(path) = std::env::var("CHROXY_SERVER_PATH") {
            let p = PathBuf::from(&path);
            if let Ok(canonical) = p.canonicalize() {
                let is_js = canonical
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("js"))
                    .unwrap_or(false);
                if canonical.is_file() && is_js {
                    return Ok(canonical);
                }
            }
        }

        // Strategy 4: `which chroxy` and resolve to its cli.js
        if let Ok(output) = Command::new("which").arg("chroxy").output() {
            let which_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !which_path.is_empty() {
                // chroxy bin is a Node script, the actual cli.js should be nearby
                let p = PathBuf::from(&which_path);
                if p.exists() {
                    return Ok(p);
                }
            }
        }

        Err(
            "Could not find chroxy server. Checked: bundled .app resources, monorepo layout, CHROXY_SERVER_PATH env, and PATH (which chroxy)."
                .to_string(),
        )
    }
}

impl Drop for ServerManager {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_generation_is_zero() {
        let mgr = ServerManager::new();
        let initial = mgr.health_generation.load(Ordering::SeqCst);
        assert_eq!(initial, 0);
    }

    #[test]
    fn stop_increments_generation() {
        let mut mgr = ServerManager::new();
        let gen_before = mgr.health_generation.load(Ordering::SeqCst);
        mgr.stop();
        let gen_after = mgr.health_generation.load(Ordering::SeqCst);
        assert_eq!(gen_after, gen_before + 1);
    }

    #[test]
    fn multiple_stops_increment_generation_each_time() {
        let mut mgr = ServerManager::new();
        mgr.stop();
        mgr.stop();
        mgr.stop();
        let gen = mgr.health_generation.load(Ordering::SeqCst);
        assert_eq!(gen, 3);
    }

    #[test]
    fn health_poll_advances_generation_on_spawn() {
        let mgr = ServerManager::new();
        let gen_before = mgr.health_generation.load(Ordering::SeqCst);
        // start_health_poll increments generation before spawning thread
        mgr.start_health_poll();
        let gen_after = mgr.health_generation.load(Ordering::SeqCst);
        assert_eq!(gen_after, gen_before + 1);
        // Advance generation to stop the spawned thread
        mgr.health_generation.fetch_add(1, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(100));
    }

    #[test]
    fn second_health_poll_invalidates_first() {
        let mgr = ServerManager::new();
        // First poll gets generation 1
        mgr.start_health_poll();
        assert_eq!(mgr.health_generation.load(Ordering::SeqCst), 1);
        // Second poll gets generation 2 — first thread will see mismatch
        mgr.start_health_poll();
        assert_eq!(mgr.health_generation.load(Ordering::SeqCst), 2);
        // Clean up: advance generation to stop the second thread
        mgr.health_generation.fetch_add(1, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(100));
    }

    #[test]
    fn restarting_status_has_correct_label() {
        assert_eq!(ServerStatus::Restarting.label(), "Restarting...");
    }

    #[test]
    fn restart_backoff_increases_with_count() {
        let mgr = ServerManager::new();

        // Initial: 3s
        assert_eq!(mgr.restart_backoff(), Duration::from_secs(3));

        // After 1st attempt: 6s
        mgr.restart_count.store(1, Ordering::Relaxed);
        assert_eq!(mgr.restart_backoff(), Duration::from_secs(6));

        // After 2nd attempt: 12s
        mgr.restart_count.store(2, Ordering::Relaxed);
        assert_eq!(mgr.restart_backoff(), Duration::from_secs(12));

        // Capped at 12s
        mgr.restart_count.store(10, Ordering::Relaxed);
        assert_eq!(mgr.restart_backoff(), Duration::from_secs(12));
    }

    #[test]
    fn try_auto_restart_rejects_at_max_attempts() {
        let mut mgr = ServerManager::new();
        mgr.restart_count.store(ServerManager::MAX_RESTART_ATTEMPTS, Ordering::Relaxed);

        let result = mgr.try_auto_restart();
        assert!(result.is_err());
        assert_eq!(
            mgr.status(),
            ServerStatus::Error(format!(
                "Auto-restart failed after {} attempts",
                ServerManager::MAX_RESTART_ATTEMPTS
            ))
        );
    }

    #[test]
    fn stop_sets_user_stopped_and_clears_auto_restart() {
        let mut mgr = ServerManager::new();
        mgr.auto_restart_pending.store(true, Ordering::Relaxed);

        mgr.stop();

        assert!(mgr.user_stopped.load(Ordering::Relaxed));
        assert!(!mgr.auto_restart_pending.load(Ordering::Relaxed));
        assert_eq!(mgr.status(), ServerStatus::Stopped);
    }

    #[test]
    fn max_restart_attempts_is_three() {
        assert_eq!(ServerManager::MAX_RESTART_ATTEMPTS, 3);
    }
}
