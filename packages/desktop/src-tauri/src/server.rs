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

/// Pure filter: given an iterator of (pid, full_command_line) pairs, return
/// the pids whose command line matches a `cloudflared tunnel --url
/// http://{localhost|127.0.0.1}:{port}` invocation. (Cloudflare tunnels
/// always point at the local server over plain HTTP — there's no https
/// variant on this code path.)
///
/// Exposed for unit testing — the impl inside `kill_orphan_cloudflared`
/// delegates here so the filter logic can be exercised against synthetic
/// process listings without spawning anything.
///
/// The port check is word-boundary aware: port 876 must NOT match 8765
/// even though "876" is a substring. We require the literal `:{port}`
/// to be followed by either a non-digit, a path separator, or end of
/// token.
///
/// Binary detection is cross-platform: the basename is taken by
/// splitting on both `/` and `\`, surrounding quotes are trimmed, the
/// match is case-insensitive, and a trailing `.exe` suffix is stripped
/// so Windows command lines like `"C:\\Program Files\\cloudflared\\cloudflared.exe"`
/// match the same `cloudflared` token as their Unix counterparts.
pub(crate) fn cloudflared_pids_to_kill(procs: &[(u32, String)], port: u16) -> Vec<u32> {
    let needles = [
        format!("http://localhost:{}", port),
        format!("http://127.0.0.1:{}", port),
    ];
    let mut out = Vec::new();
    for (pid, cmd) in procs {
        // Require the cloudflared binary name as a whole word. We match
        // on bare "cloudflared", Unix full paths ("/opt/homebrew/bin/cloudflared"),
        // and Windows invocations ("C:\\Program Files\\cloudflared\\cloudflared.exe"
        // with or without surrounding quotes).
        let has_cloudflared_binary = cmd.split_whitespace().any(|tok| {
            // Strip surrounding single/double quotes.
            let trimmed = tok
                .trim_matches(|c: char| c == '"' || c == '\'');
            // Take basename across both Unix (/) and Windows (\) separators.
            let base = trimmed
                .rsplit(|c: char| c == '/' || c == '\\')
                .next()
                .unwrap_or(trimmed);
            // Drop a case-insensitive ".exe" suffix before the compare so
            // bare "cloudflared" and "CLOUDFLARED.EXE" both match.
            let without_exe = if base.len() >= 4
                && base[base.len() - 4..].eq_ignore_ascii_case(".exe")
            {
                &base[..base.len() - 4]
            } else {
                base
            };
            without_exe.eq_ignore_ascii_case("cloudflared")
        });
        if !has_cloudflared_binary {
            continue;
        }

        let mut matched = false;
        for needle in &needles {
            if let Some(idx) = cmd.find(needle.as_str()) {
                // Ensure the port isn't a prefix of a longer port (e.g. 876 vs 8765).
                let tail = &cmd[idx + needle.len()..];
                let next = tail.chars().next();
                let port_terminated = match next {
                    None => true,
                    Some(c) => !c.is_ascii_digit(),
                };
                if port_terminated {
                    matched = true;
                    break;
                }
            }
        }
        if matched {
            out.push(*pid);
        }
    }
    out
}

/// Parse one line of `ps -eo pid=,command=` output into (pid, full_command).
/// Returns `None` for malformed lines.
#[cfg(unix)]
fn parse_ps_line(line: &str) -> Option<(u32, String)> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    // pid is the first whitespace-delimited token; command is the rest.
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let pid_str = parts.next()?;
    let cmd = parts.next()?.trim_start().to_string();
    let pid: u32 = pid_str.parse().ok()?;
    Some((pid, cmd))
}

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

    /// Set a custom Node binary path from settings.
    /// When set, this path is preferred over auto-discovery via resolve_node22().
    /// Empty/whitespace-only strings are treated as None.
    /// Non-existent paths are ignored (fall back to auto-discovery).
    pub fn set_node_path(&mut self, path: Option<&str>) {
        self.node_path = path
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.exists());
    }

    /// Return buffered server log lines (stdout + stderr).
    pub fn get_logs(&self) -> Vec<String> {
        lock_or_recover(&self.log_buffer).iter().cloned().collect()
    }

    /// Whether auto-restart has been requested by the health poll.
    pub fn is_auto_restart_pending(&self) -> bool {
        self.auto_restart_pending.load(Ordering::Relaxed)
    }

    /// Current consecutive restart attempt count.
    pub fn restart_count(&self) -> u32 {
        self.restart_count.load(Ordering::Relaxed)
    }

    /// Reset consecutive restart count (called by monitoring thread after recovery).
    pub fn reset_restart_count(&self) {
        self.restart_count.store(0, Ordering::Relaxed);
    }

    /// Re-signal that auto-restart should be attempted.
    /// Called when a restart attempt started the process but it failed to
    /// reach Running. Sets the pending flag so the monitoring loop retries.
    pub fn signal_auto_restart(&self) {
        self.auto_restart_pending.store(true, Ordering::Relaxed);
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
    #[cfg(unix)]
    fn kill_port_holder(port: u16) {
        if let Ok(output) = Command::new("lsof")
            .args(["-ti", &format!("tcp:{}", port)])
            .output()
        {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid_str in pids.split_whitespace() {
                if let Ok(pid) = pid_str.trim().parse::<i32>() {
                    // Verify the process belongs to Chroxy/node before killing
                    if let Ok(ps_output) = Command::new("ps")
                        .args(["-p", pid_str.trim(), "-o", "comm="])
                        .output()
                    {
                        let comm = String::from_utf8_lossy(&ps_output.stdout)
                            .trim()
                            .to_lowercase()
                            .to_string();
                        if comm.contains("node") || comm.contains("chroxy") {
                            unsafe {
                                libc::kill(pid, libc::SIGTERM);
                            }
                        }
                    }
                }
            }
            if !pids.trim().is_empty() {
                // Give processes a moment to exit
                thread::sleep(Duration::from_millis(500));
            }
        }
    }

    /// Kill any process listening on the given port (cleanup from previous crash).
    #[cfg(windows)]
    fn kill_port_holder(port: u16) {
        // On Windows, use netstat + taskkill to find and kill port holders
        if let Ok(output) = Command::new("cmd")
            .args(["/C", &format!("netstat -ano | findstr :{}", port)])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if let Some(pid_str) = line.split_whitespace().last() {
                    if let Ok(pid) = pid_str.trim().parse::<u32>() {
                        if pid > 0 {
                            let _ = Command::new("taskkill")
                                .args(["/PID", &pid.to_string(), "/F"])
                                .output();
                        }
                    }
                }
            }
            if !text.trim().is_empty() {
                thread::sleep(Duration::from_millis(500));
            }
        }
    }

    /// Kill orphan `cloudflared` processes still tunneling the given port
    /// from a previous run (e.g. a crashed server left its tunnel child
    /// orphaned). Uses `ps -eo pid,command` on unix and `wmic` on
    /// windows to enumerate processes, filters with the pure
    /// `cloudflared_pids_to_kill()` function, then sends SIGTERM /
    /// terminates. Waits briefly for them to exit.
    #[cfg(unix)]
    fn kill_orphan_cloudflared(port: u16) {
        let Ok(output) = Command::new("ps").args(["-eo", "pid=,command="]).output() else {
            return;
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let procs: Vec<(u32, String)> = stdout.lines().filter_map(parse_ps_line).collect();

        let pids = cloudflared_pids_to_kill(&procs, port);
        if pids.is_empty() {
            return;
        }

        eprintln!(
            "[tray] Killing {} orphan cloudflared process(es) on port {}: {:?}",
            pids.len(),
            port,
            pids
        );
        for pid in &pids {
            // SAFETY: pid was just parsed from `ps` output and is about
            // to receive SIGTERM; there's an inherent PID-reuse race
            // (shared with kill_port_holder) but the verification step
            // in cloudflared_pids_to_kill bounds the damage to
            // processes whose cmdline still matches the cloudflared
            // pattern at enumeration time.
            unsafe {
                libc::kill(*pid as i32, libc::SIGTERM);
            }
        }

        // Wait briefly (< 1s) for processes to exit before we spawn a new tunnel.
        thread::sleep(Duration::from_millis(500));
    }

    #[cfg(windows)]
    fn kill_orphan_cloudflared(port: u16) {
        // Enumerate processes with `wmic process get ProcessId,CommandLine`.
        let Ok(output) = Command::new("wmic")
            .args(["process", "get", "ProcessId,CommandLine", "/format:csv"])
            .output()
        else {
            return;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        // CSV format: Node,CommandLine,ProcessId — skip header and empty lines.
        let mut procs: Vec<(u32, String)> = Vec::new();
        for line in stdout.lines().skip(1) {
            let parts: Vec<&str> = line.rsplitn(2, ',').collect();
            // parts[0] is ProcessId (rightmost), parts[1] is the rest (Node,CommandLine).
            if parts.len() != 2 {
                continue;
            }
            let pid = match parts[0].trim().parse::<u32>() {
                Ok(p) => p,
                Err(_) => continue,
            };
            let rest = parts[1];
            // Drop the leading "Node," segment to get just CommandLine.
            let cmd = rest.splitn(2, ',').nth(1).unwrap_or("").to_string();
            procs.push((pid, cmd));
        }

        let pids = cloudflared_pids_to_kill(&procs, port);
        if pids.is_empty() {
            return;
        }

        eprintln!(
            "[tray] Killing {} orphan cloudflared process(es) on port {}: {:?}",
            pids.len(),
            port,
            pids
        );
        for pid in &pids {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output();
        }
        thread::sleep(Duration::from_millis(500));
    }

    /// Check whether `cloudflared` is available on PATH.
    pub fn check_cloudflared() -> bool {
        // Check common well-known paths first — macOS GUI apps have a
        // minimal PATH that excludes Homebrew and user-local bins.
        #[cfg(target_os = "macos")]
        for path in &[
            "/opt/homebrew/bin/cloudflared",
            "/usr/local/bin/cloudflared",
        ] {
            if std::path::Path::new(path).exists() {
                return true;
            }
        }

        // Fall back to PATH-based lookup
        #[cfg(unix)]
        let cmd = "which";
        #[cfg(windows)]
        let cmd = "where";
        Command::new(cmd)
            .arg("cloudflared")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Start the Chroxy server as a child process.
    pub fn start(&mut self) -> Result<(), String> {
        if matches!(
            self.status(),
            ServerStatus::Running | ServerStatus::Starting
        ) {
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
        // Clear stale logs from any previous run so the buffer only
        // contains output from the current server process.
        lock_or_recover(&self.log_buffer).clear();

        // Reload config each start
        self.config = config::load_config();

        // Kill any orphaned server on the port (e.g. from a previous crash)
        Self::kill_port_holder(self.config.port);
        // Kill any orphaned cloudflared process still tunneling that port,
        // otherwise starting a new tunnel will race / fail to bind (#2835).
        Self::kill_orphan_cloudflared(self.config.port);

        // Resolve Node 22 path.
        // If a custom path was set but no longer exists on disk, clear it
        // and fall back to auto-discovery so startup isn't blocked.
        let node_path = match &self.node_path {
            Some(p) if p.exists() => p.clone(),
            Some(_) => {
                // Custom path is stale — clear and auto-discover
                self.node_path = None;
                let p = node::resolve_node22()?;
                self.node_path = Some(p.clone());
                p
            }
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
        // Homebrew (macOS only)
        #[cfg(target_os = "macos")]
        for dir in &["/opt/homebrew/bin", "/usr/local/bin"] {
            if !base_path.contains(dir) {
                extra_dirs.push(dir.to_string());
            }
        }
        // User-local bins (Unix)
        #[cfg(unix)]
        if let Some(home) = dirs::home_dir() {
            let local_bin = home.join(".local/bin");
            if local_bin.is_dir() {
                extra_dirs.push(local_bin.display().to_string());
            }
        }
        #[cfg(unix)]
        let path_sep = ":";
        #[cfg(windows)]
        let path_sep = ";";
        let full_path = format!("{}{}{}", extra_dirs.join(path_sep), path_sep, base_path);
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

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn server: {}", e))?;

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
                    // Send graceful termination signal
                    #[cfg(unix)]
                    {
                        // SAFETY: We just confirmed the child is still running via try_wait().
                        // The PID (child.id()) belongs to our direct child process, which
                        // has not yet exited, so PID reuse cannot occur here.
                        unsafe {
                            libc::kill(child.id() as i32, libc::SIGTERM);
                        }
                    }
                    #[cfg(windows)]
                    {
                        // Windows: no SIGTERM, kill directly
                        let _ = child.kill();
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
            *lock_or_recover(&self.status) = ServerStatus::Error(format!(
                "Auto-restart failed after {} attempts",
                Self::MAX_RESTART_ATTEMPTS
            ));
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

    /// Sleep in short increments, checking the generation counter between each.
    /// Returns `true` if the full duration elapsed, `false` if generation changed.
    fn sleep_interruptible(dur: Duration, generation: &AtomicU64, my_gen: u64) -> bool {
        let step = Duration::from_millis(100);
        let mut remaining = dur;
        while remaining > Duration::ZERO {
            let chunk = remaining.min(step);
            thread::sleep(chunk);
            if generation.load(Ordering::SeqCst) != my_gen {
                return false;
            }
            remaining = remaining.saturating_sub(chunk);
        }
        true
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

        // Advance generation so any existing poll thread sees a mismatch and exits
        let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;

        thread::spawn(move || {
            let start = Instant::now();
            // Use 127.0.0.1 (not localhost) to avoid IPv6 resolution issues
            // in macOS GUI app context where DNS may resolve differently.
            let url = format!("http://127.0.0.1:{}/", port);

            // Counters used for the timeout summary (issue #2835 sub-fix B).
            let mut attempts: u32 = 0;
            let mut non200: u32 = 0;
            let mut network_errors: u32 = 0;

            loop {
                if generation.load(Ordering::SeqCst) != my_gen {
                    return;
                }

                if start.elapsed() > Duration::from_secs(60) {
                    let mut s = lock_or_recover(&status);
                    if *s == ServerStatus::Starting {
                        eprintln!(
                            "[health_poll] TIMEOUT after 60s: {} attempt(s) total, {} non-200, {} network errors",
                            attempts, non200, network_errors
                        );
                        *s = ServerStatus::Error(format!(
                            "Health check timeout after 60s ({} attempts: {} non-200, {} errors)",
                            attempts, non200, network_errors
                        ));
                    }
                    return;
                }

                attempts += 1;
                let attempt_start = Instant::now();
                match ureq::get(&url).timeout(Duration::from_secs(2)).call() {
                    Ok(resp) => {
                        let code = resp.status();
                        let elapsed_ms = attempt_start.elapsed().as_millis();
                        eprintln!(
                            "[health_poll] attempt #{} GET {} -> {} ({}ms)",
                            attempts, url, code, elapsed_ms
                        );
                        if code == 200 {
                            *lock_or_recover(&status) = ServerStatus::Running;
                            break;
                        } else {
                            non200 += 1;
                        }
                    }
                    Err(err) => {
                        network_errors += 1;
                        let elapsed_ms = attempt_start.elapsed().as_millis();
                        // ureq::Error prints like "Transport(...)" / "Status(...)"
                        // which is short enough to include verbatim.
                        eprintln!(
                            "[health_poll] attempt #{} GET {} -> Err({}) ({}ms)",
                            attempts, url, err, elapsed_ms
                        );
                    }
                }

                if !Self::sleep_interruptible(Duration::from_secs(2), &generation, my_gen) {
                    return;
                }
            }

            // Continue monitoring while running
            loop {
                if generation.load(Ordering::SeqCst) != my_gen {
                    return;
                }

                if !Self::sleep_interruptible(Duration::from_secs(5), &generation, my_gen) {
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

        // Strategy 4: `which chroxy` (Unix) / `where chroxy` (Windows) and resolve to its cli.js
        #[cfg(unix)]
        let which_cmd = "which";
        #[cfg(windows)]
        let which_cmd = "where";
        if let Ok(output) = Command::new(which_cmd).arg("chroxy").output() {
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
    fn health_poll_exits_within_500ms_of_generation_change() {
        let mgr = ServerManager::new();
        // Start a health poll (spawns a thread that sleeps 2s between checks)
        mgr.start_health_poll();
        let poll_gen = mgr.health_generation.load(Ordering::SeqCst);

        // Wait a bit for the thread to enter its sleep
        thread::sleep(Duration::from_millis(50));

        let before = Instant::now();
        // Invalidate the generation — thread should wake up and exit quickly
        mgr.health_generation.fetch_add(1, Ordering::SeqCst);
        assert_ne!(mgr.health_generation.load(Ordering::SeqCst), poll_gen);

        // Wait for the thread to exit (poll every 50ms, up to 600ms)
        // If interruptible, it exits in <200ms. If not, it takes up to 4s.
        thread::sleep(Duration::from_millis(500));
        let elapsed = before.elapsed();
        // Verify it exited well under the old 2s sleep
        assert!(
            elapsed < Duration::from_secs(1),
            "Thread took {:?} to exit — should be <500ms",
            elapsed
        );
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
        mgr.restart_count
            .store(ServerManager::MAX_RESTART_ATTEMPTS, Ordering::Relaxed);

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

    #[test]
    fn get_logs_returns_buffered_lines() {
        let mgr = ServerManager::new();
        {
            let mut buf = lock_or_recover(&mgr.log_buffer);
            buf.push_back("line 1".to_string());
            buf.push_back("line 2".to_string());
        }
        let logs = mgr.get_logs();
        assert_eq!(logs, vec!["line 1", "line 2"]);
    }

    #[test]
    fn get_logs_returns_empty_vec_when_no_logs() {
        let mgr = ServerManager::new();
        assert!(mgr.get_logs().is_empty());
    }

    #[test]
    fn reset_restart_count_clears_to_zero() {
        let mgr = ServerManager::new();
        mgr.restart_count.store(2, Ordering::Relaxed);
        assert_eq!(mgr.restart_count(), 2);

        mgr.reset_restart_count();
        assert_eq!(mgr.restart_count(), 0);
    }

    #[test]
    fn set_node_path_stores_existing_path() {
        let mut mgr = ServerManager::new();
        assert!(mgr.node_path.is_none());

        // Use a path that exists on all systems
        mgr.set_node_path(Some("/usr"));
        assert_eq!(mgr.node_path, Some(PathBuf::from("/usr")));
    }

    #[test]
    fn set_node_path_none_clears_path() {
        let mut mgr = ServerManager::new();
        mgr.set_node_path(Some("/usr"));
        mgr.set_node_path(None);
        assert!(mgr.node_path.is_none());
    }

    #[test]
    fn set_node_path_empty_string_treated_as_none() {
        let mut mgr = ServerManager::new();
        mgr.set_node_path(Some(""));
        assert!(mgr.node_path.is_none());
    }

    #[test]
    fn set_node_path_whitespace_treated_as_none() {
        let mut mgr = ServerManager::new();
        mgr.set_node_path(Some("   "));
        assert!(mgr.node_path.is_none());
    }

    #[test]
    fn set_node_path_nonexistent_path_treated_as_none() {
        let mut mgr = ServerManager::new();
        mgr.set_node_path(Some("/this/path/does/not/exist/node"));
        assert!(mgr.node_path.is_none());
    }

    // -- cloudflared_pids_to_kill: pure filter (#2835) --

    #[test]
    fn cloudflared_filter_matches_localhost_port() {
        let procs = vec![(
            123u32,
            "cloudflared tunnel --url http://localhost:8765".to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert_eq!(pids, vec![123]);
    }

    #[test]
    fn cloudflared_filter_matches_127_0_0_1_port() {
        let procs = vec![(
            456u32,
            "cloudflared tunnel --url http://127.0.0.1:8765 --no-autoupdate".to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert_eq!(pids, vec![456]);
    }

    #[test]
    fn cloudflared_filter_matches_full_path_binary() {
        // macOS GUI apps may run /opt/homebrew/bin/cloudflared with full path
        let procs = vec![(
            789u32,
            "/opt/homebrew/bin/cloudflared tunnel --url http://localhost:8765".to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert_eq!(pids, vec![789]);
    }

    #[test]
    fn cloudflared_filter_rejects_wrong_port() {
        let procs = vec![(
            111u32,
            "cloudflared tunnel --url http://localhost:9999".to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert!(pids.is_empty());
    }

    #[test]
    fn cloudflared_filter_rejects_non_cloudflared_process() {
        let procs = vec![
            (222u32, "node server.js http://localhost:8765".to_string()),
            (223u32, "ssh -R 8765:localhost:8765 user@host".to_string()),
        ];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert!(pids.is_empty());
    }

    #[test]
    fn cloudflared_filter_rejects_cloudflared_on_different_port() {
        // Another Chroxy instance on port 9000 must NOT be killed when we clean up port 8765.
        let procs = vec![(
            333u32,
            "cloudflared tunnel --url http://localhost:9000".to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert!(pids.is_empty());
    }

    #[test]
    fn cloudflared_filter_allows_substring_port_discrimination() {
        // Port 876 must not match 8765, even though "876" is a substring of "8765".
        let procs = vec![(
            444u32,
            "cloudflared tunnel --url http://localhost:876".to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert!(pids.is_empty());
    }

    #[test]
    fn cloudflared_filter_picks_only_matching_from_mixed() {
        let procs = vec![
            (
                1u32,
                "cloudflared tunnel --url http://localhost:8765".to_string(),
            ),
            (
                2u32,
                "cloudflared tunnel --url http://localhost:9000".to_string(),
            ),
            (3u32, "node cli.js start".to_string()),
            (
                4u32,
                "cloudflared tunnel --url http://127.0.0.1:8765 --no-autoupdate".to_string(),
            ),
        ];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert_eq!(pids, vec![1, 4]);
    }

    #[test]
    fn cloudflared_filter_empty_input_returns_empty() {
        let procs: Vec<(u32, String)> = vec![];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert!(pids.is_empty());
    }

    #[test]
    fn cloudflared_filter_handles_tcp_scheme() {
        // cloudflared also supports tcp:// and tls:// URLs; don't false-match these for an http port.
        let procs = vec![(
            555u32,
            "cloudflared tunnel --url tcp://localhost:8765".to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert!(pids.is_empty());
    }

    // -- Windows-style binary detection (#2845 review follow-up) --

    #[test]
    fn cloudflared_filter_matches_windows_exe() {
        // Windows command lines commonly include .exe and backslash paths.
        let procs = vec![(
            666u32,
            r"C:\Program Files\cloudflared\cloudflared.exe tunnel --url http://localhost:8765"
                .to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert_eq!(pids, vec![666]);
    }

    #[test]
    fn cloudflared_filter_matches_quoted_windows_path() {
        // Processes spawned via shell often have the exe path quoted.
        let procs = vec![(
            777u32,
            r#""C:\Program Files\cloudflared\cloudflared.exe" tunnel --url http://localhost:8765"#
                .to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert_eq!(pids, vec![777]);
    }

    #[test]
    fn cloudflared_filter_is_case_insensitive_for_binary() {
        // Some Windows setups preserve case differently (CLOUDFLARED.EXE / Cloudflared.exe).
        let procs = vec![(
            888u32,
            r"C:\tools\CLOUDFLARED.EXE tunnel --url http://localhost:8765".to_string(),
        )];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert_eq!(pids, vec![888]);
    }

    #[test]
    fn cloudflared_filter_rejects_non_cloudflared_exe() {
        // e.g. "someapp.exe --url http://localhost:8765" must NOT match just because of the URL.
        let procs = vec![(999u32, "someapp.exe --url http://localhost:8765".to_string())];
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert!(pids.is_empty());
    }
}
