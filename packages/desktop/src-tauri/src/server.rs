use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{self, ChroxyConfig};
use crate::node;

/// Current state of the server process.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerStatus {
    Stopped,
    Starting,
    Running,
    Error(String),
}

impl ServerStatus {
    pub fn label(&self) -> &str {
        match self {
            ServerStatus::Stopped => "Stopped",
            ServerStatus::Starting => "Starting...",
            ServerStatus::Running => "Running",
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
    health_running: Arc<Mutex<bool>>,
}

impl ServerManager {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(ServerStatus::Stopped)),
            child: None,
            log_buffer: Arc::new(Mutex::new(VecDeque::with_capacity(100))),
            node_path: None,
            config: ChroxyConfig::default(),
            health_running: Arc::new(Mutex::new(false)),
        }
    }

    pub fn status(&self) -> ServerStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
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

    /// Start the Chroxy server as a child process.
    pub fn start(&mut self) -> Result<(), String> {
        if matches!(self.status(), ServerStatus::Running | ServerStatus::Starting) {
            return Err("Server is already running".to_string());
        }

        // Reload config each start
        self.config = config::load_config();

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

        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = ServerStatus::Starting;

        // Build command
        let mut cmd = Command::new(&node_path);
        cmd.arg(&cli_js).arg("start");
        cmd.env(
            "PATH",
            format!(
                "{}:{}",
                node_path.parent().unwrap().display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
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
        // No tunnel — tray app connects locally
        cmd.env("CHROXY_TUNNEL", "none");
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
                    let mut logs = buf.lock().unwrap_or_else(|e| e.into_inner());
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
                    let mut logs = buf.lock().unwrap_or_else(|e| e.into_inner());
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

    /// Stop the server process gracefully (SIGTERM → 5s → SIGKILL).
    pub fn stop(&mut self) {
        // Stop health polling
        *self.health_running.lock().unwrap_or_else(|e| e.into_inner()) = false;

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
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = ServerStatus::Stopped;
    }

    /// Restart: stop then start.
    pub fn restart(&mut self) -> Result<(), String> {
        self.stop();
        self.start()
    }

    /// Poll the health endpoint every 2s until Running or timeout (30s).
    fn start_health_poll(&self) {
        let status = self.status.clone();
        let port = self.config.port;
        let health_running = self.health_running.clone();

        *health_running.lock().unwrap_or_else(|e| e.into_inner()) = true;

        thread::spawn(move || {
            let start = Instant::now();
            // Use GET / — the canonical health check endpoint used by Cloudflare
            // routing, app pre-connect verification, and supervisor.js
            let url = format!("http://localhost:{}/", port);

            loop {
                if !*health_running.lock().unwrap_or_else(|e| e.into_inner()) {
                    return;
                }

                if start.elapsed() > Duration::from_secs(30) {
                    let mut s = status.lock().unwrap_or_else(|e| e.into_inner());
                    if *s == ServerStatus::Starting {
                        *s = ServerStatus::Error("Health check timeout after 30s".to_string());
                    }
                    return;
                }

                match ureq::get(&url).timeout(Duration::from_secs(2)).call() {
                    Ok(resp) => {
                        if resp.status() == 200 {
                            *status.lock().unwrap_or_else(|e| e.into_inner()) = ServerStatus::Running;
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
                if !*health_running.lock().unwrap_or_else(|e| e.into_inner()) {
                    return;
                }

                thread::sleep(Duration::from_secs(5));

                if !*health_running.lock().unwrap_or_else(|e| e.into_inner()) {
                    return;
                }

                match ureq::get(&url).timeout(Duration::from_secs(2)).call() {
                    Ok(resp) => {
                        if resp.status() == 200 {
                            *status.lock().unwrap_or_else(|e| e.into_inner()) = ServerStatus::Running;
                        }
                    }
                    Err(_) => {
                        let mut s = status.lock().unwrap_or_else(|e| e.into_inner());
                        if *s == ServerStatus::Running {
                            *s = ServerStatus::Error("Server stopped responding".to_string());
                        }
                    }
                }
            }
        });
    }

    /// Resolve the chroxy CLI entry point (cli.js).
    /// Checks: relative to binary (monorepo), then `which chroxy`, then CHROXY_SERVER_PATH env.
    fn resolve_cli_js() -> Result<PathBuf, String> {
        // Check monorepo path relative to the Tauri binary.
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

        // Check CHROXY_SERVER_PATH env — canonicalize and verify it's a .js file
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

        // Try `which chroxy` and resolve to its cli.js
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
            "Could not find chroxy server. Set CHROXY_SERVER_PATH or run from the monorepo."
                .to_string(),
        )
    }
}

impl Drop for ServerManager {
    fn drop(&mut self) {
        self.stop();
    }
}
