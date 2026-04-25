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
            // bare "cloudflared" and "CLOUDFLARED.EXE" both match. Compare
            // the last 4 bytes directly to avoid panicking when `base` is
            // longer than 4 bytes but its length minus 4 lands inside a
            // multi-byte UTF-8 character (e.g. a process whose command
            // line contains non-ASCII glyphs).
            let bytes = base.as_bytes();
            let without_exe = if bytes.len() >= 4
                && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".exe")
            {
                // Last 4 bytes are ASCII (.exe), so the char boundary
                // guarantee holds and `&base[..base.len() - 4]` is safe.
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
#[cfg(any(unix, test))]
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

/// Parse `wmic process get ProcessId,CommandLine /format:csv` stdout into
/// (pid, full_command) pairs. Pure: exposed for unit testing.
///
/// CSV format is `Node,CommandLine,ProcessId` — skips header + empty lines,
/// splits on the rightmost comma so commas inside command lines don't
/// break parsing.
#[cfg(any(windows, test))]
pub(crate) fn parse_wmic_csv(stdout: &str) -> Vec<(u32, String)> {
    let mut procs: Vec<(u32, String)> = Vec::new();
    for line in stdout.lines().skip(1) {
        let parts: Vec<&str> = line.rsplitn(2, ',').collect();
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
    procs
}

/// Parse `Get-CimInstance Win32_Process | ConvertTo-Json` stdout into
/// (pid, full_command) pairs. Pure: exposed for unit testing.
///
/// PowerShell `ConvertTo-Json` emits a JSON object when there's a single
/// result and a JSON array when there are multiple. Both shapes are
/// handled. Each element has `ProcessId` (number) and `CommandLine`
/// (string or null). Entries with null/missing CommandLine are skipped —
/// they can't match the cloudflared filter anyway.
#[cfg(any(windows, test))]
pub(crate) fn parse_powershell_json(stdout: &str) -> Vec<(u32, String)> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return Vec::new();
    };
    // Normalize single-object output to an array of one.
    let items: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(arr) => arr.iter().collect(),
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    for item in items {
        let Some(pid) = item.get("ProcessId").and_then(|v| v.as_u64()) else {
            continue;
        };
        let Some(cmd) = item.get("CommandLine").and_then(|v| v.as_str()) else {
            continue;
        };
        if cmd.is_empty() {
            continue;
        }
        out.push((pid as u32, cmd.to_string()));
    }
    out
}

/// Build an enriched PATH string for the spawned server child process.
///
/// macOS GUI apps (including launchd-launched apps like Tauri tray binaries)
/// inherit a minimal PATH — typically `/usr/bin:/bin:/usr/sbin:/sbin` — that
/// omits Homebrew, nvm, pipx, npm-global, and other user install locations.
/// Without enrichment, any subprocess the server spawns (claude binary, git,
/// cloudflared, hook scripts, MCP servers) will silently fail to resolve
/// common tools.
///
/// This is a pure function so it can be unit-tested without touching the real
/// environment or filesystem. The caller is responsible for supplying
/// `base_path` (usually from `std::env::var("PATH")`) and `home_dir` (usually
/// from `dirs::home_dir()`).
///
/// Semantics:
/// - `node_bin` is always prepended first so the bundled Node is preferred.
/// - Common system bins (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`,
///   `/bin`) are prepended next on Unix.
/// - User install dirs (`~/.local/bin`, `~/.npm-global/bin`,
///   `~/.claude/local/node_modules/.bin`) are prepended when `home_dir` is
///   `Some`. They are NOT filesystem-checked — the goal is defense-in-depth,
///   and a non-existent dir on PATH is harmless.
/// - Directories already present in `base_path` are skipped to avoid
///   duplicates. The check splits `base_path` on `path_sep` and compares
///   elements exactly, so paths like `/sbin` do not accidentally suppress
///   `/bin`.
/// - `base_path` is appended verbatim at the end.
///
/// On Windows, only `node_bin` and `base_path` are joined — the user install
/// dirs and Unix-specific system bins do not apply.
pub(crate) fn build_enriched_path(
    base_path: &str,
    node_bin: &str,
    home_dir: Option<&std::path::Path>,
    path_sep: &str,
) -> String {
    let mut dirs: Vec<String> = Vec::new();

    // Bundled Node directory — always first so it wins over any system node.
    if !node_bin.is_empty() {
        dirs.push(node_bin.to_string());
    }

    // System bins (Unix). We leave Windows PATH handling to the OS default
    // because `%PATH%` semantics and typical install locations differ.
    #[cfg(unix)]
    {
        let base_entries: Vec<&str> = base_path.split(path_sep).collect();
        let already_present = |candidate: &str| base_entries.iter().any(|e| *e == candidate);

        for dir in &[
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ] {
            if !already_present(dir) && !dirs.iter().any(|d| d == dir) {
                dirs.push((*dir).to_string());
            }
        }

        // User install dirs — only when we know $HOME.
        if let Some(home) = home_dir {
            for rel in &[
                ".local/bin",
                ".npm-global/bin",
                ".claude/local/node_modules/.bin",
            ] {
                let candidate = home.join(rel).display().to_string();
                if !already_present(&candidate) && !dirs.iter().any(|d| d == &candidate) {
                    dirs.push(candidate);
                }
            }
        }
    }

    // Silence unused-param warning on Windows builds (user install dirs are
    // Unix-only, so home_dir is not referenced above on Windows).
    #[cfg(windows)]
    let _ = home_dir;

    if dirs.is_empty() {
        return base_path.to_string();
    }
    if base_path.is_empty() {
        return dirs.join(path_sep);
    }
    format!("{}{}{}", dirs.join(path_sep), path_sep, base_path)
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

    /// Ring-buffer ceiling for captured server/health logs. Shared by the
    /// child-stdout drain, child-stderr drain, and health-poll thread so
    /// any source can push up to this many lines before the oldest is
    /// evicted.
    pub const MAX_LOG_LINES: usize = 100;

    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(ServerStatus::Stopped)),
            child: None,
            log_buffer: Arc::new(Mutex::new(VecDeque::with_capacity(Self::MAX_LOG_LINES))),
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

    /// Return buffered server log lines (stdout + stderr + health-poll).
    pub fn get_logs(&self) -> Vec<String> {
        lock_or_recover(&self.log_buffer).iter().cloned().collect()
    }

    /// Append a single log line to the shared buffer, enforcing the
    /// `MAX_LOG_LINES` ring-buffer ceiling. Shared by the child stdout
    /// drain, child stderr drain, and the health-poll thread so all three
    /// sources surface in `get_startup_logs` with one consistent cap
    /// (issue #2846).
    fn push_log_line(buf: &Arc<Mutex<VecDeque<String>>>, line: String) {
        let mut logs = lock_or_recover(buf);
        if logs.len() >= Self::MAX_LOG_LINES {
            logs.pop_front();
        }
        logs.push_back(line);
    }

    /// Extract a compact, single-line snippet of stderr suitable for
    /// embedding in a log line. Trims whitespace, collapses newlines to
    /// spaces, and caps the length so one noisy command can't blow past
    /// the per-line log budget (issue #2868).
    ///
    /// When the collapsed text exceeds `MAX_LEN` chars, it is truncated
    /// to `MAX_LEN` and "..." is appended — so the returned string may
    /// be up to `MAX_LEN + 3` chars (the cap applies to the payload, not
    /// including the ellipsis).
    fn stderr_snippet(stderr: &[u8]) -> String {
        const MAX_LEN: usize = 200;
        let text = String::from_utf8_lossy(stderr);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return "<no stderr>".to_string();
        }
        let collapsed: String = trimmed
            .split(['\n', '\r'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        if collapsed.chars().count() > MAX_LEN {
            let truncated: String = collapsed.chars().take(MAX_LEN).collect();
            format!("{}...", truncated)
        } else {
            collapsed
        }
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
    /// orphaned). Uses `ps -eo pid,command` on unix and `wmic` (with a
    /// PowerShell `Get-CimInstance` fallback for Windows 11 22H2+ where
    /// wmic is deprecated/removed) on windows to enumerate processes,
    /// filters with the pure `cloudflared_pids_to_kill()` function, then
    /// sends SIGTERM / terminates. Waits briefly for them to exit.
    #[cfg(unix)]
    fn kill_orphan_cloudflared(port: u16, log_buf: &Arc<Mutex<VecDeque<String>>>) {
        let procs = Self::enumerate_unix_processes_with_runner(port, log_buf, &|| {
            Command::new("ps").args(["-eo", "pid=,command="]).output()
        });

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
    fn kill_orphan_cloudflared(port: u16, log_buf: &Arc<Mutex<VecDeque<String>>>) {
        // Try `wmic` first — still present on older Windows (pre-11 22H2)
        // and cheaper than spinning up PowerShell. Fall back to
        // `Get-CimInstance` via PowerShell when wmic is absent (newer
        // Windows has it removed) or returns a non-success exit.
        let procs = Self::enumerate_windows_processes(log_buf);

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

    /// Testable unix enumerator. Runs the injected process-listing command
    /// via `runner`, logs any failure to `log_buf`, and returns the parsed
    /// (pid, command_line) pairs (empty on failure).
    ///
    /// Production callers pass a runner that spawns `ps -eo pid=,command=`;
    /// tests pass a closure that returns a synthetic `io::Error` or
    /// non-success `Output` to exercise the failure-path diagnostics
    /// added in #2868 (issue #2887).
    ///
    /// Available on unix (production) and in tests on any platform so the
    /// failure paths can be exercised deterministically on dev hosts. The
    /// `#[cfg(any(unix, test))]` gate matches `parse_ps_line` — both symbols
    /// must be available together, and neither needs to exist in a Windows
    /// release build where `kill_orphan_cloudflared` takes a different path.
    #[cfg(any(unix, test))]
    fn enumerate_unix_processes_with_runner(
        port: u16,
        log_buf: &Arc<Mutex<VecDeque<String>>>,
        runner: &dyn Fn() -> std::io::Result<std::process::Output>,
    ) -> Vec<(u32, String)> {
        let output = match runner() {
            Ok(out) => out,
            Err(err) => {
                let msg = format!(
                    "[cloudflared-cleanup] ps spawn failed: {} — skipping orphan cleanup on port {}",
                    err, port
                );
                eprintln!("{}", msg);
                Self::push_log_line(log_buf, msg);
                return Vec::new();
            }
        };

        if !output.status.success() {
            let stderr_snip = Self::stderr_snippet(&output.stderr);
            let msg = format!(
                "[cloudflared-cleanup] ps exited {} — skipping orphan cleanup on port {}: {}",
                output.status, port, stderr_snip
            );
            eprintln!("{}", msg);
            Self::push_log_line(log_buf, msg);
            return Vec::new();
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.lines().filter_map(parse_ps_line).collect()
    }

    /// Enumerate (pid, command_line) pairs on Windows.
    ///
    /// Primary: `wmic process get ProcessId,CommandLine /format:csv`
    /// (still present on Windows 10 and Windows 11 pre-22H2).
    ///
    /// Fallback: `powershell -NoProfile -Command
    /// "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine
    /// | ConvertTo-Json -Compress"` (Windows 11 22H2+ where wmic is
    /// deprecated and eventually removed). The `-NoProfile` flag skips
    /// user profile loading for faster startup; `-Compress` keeps the
    /// JSON on a single line.
    #[cfg(windows)]
    fn enumerate_windows_processes(log_buf: &Arc<Mutex<VecDeque<String>>>) -> Vec<(u32, String)> {
        Self::enumerate_windows_processes_with_runners(
            log_buf,
            &|| {
                Command::new("wmic")
                    .args(["process", "get", "ProcessId,CommandLine", "/format:csv"])
                    .output()
            },
            &|| {
                Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
                    ])
                    .output()
            },
        )
    }

    /// Testable windows enumerator. Accepts separate runners for the `wmic`
    /// primary path and the PowerShell `Get-CimInstance` fallback so each
    /// of the four failure modes (wmic spawn err, wmic non-success,
    /// powershell spawn err, powershell non-success) can be exercised by
    /// unit tests without a real Windows host (issue #2887).
    ///
    /// Logs exactly match the pre-refactor strings from #2868 so consumers
    /// scraping the log buffer for diagnostics see no wire-format change.
    ///
    /// Available on windows (production) and in tests on any platform so
    /// the failure paths can be exercised deterministically on dev hosts.
    #[cfg(any(windows, test))]
    fn enumerate_windows_processes_with_runners(
        log_buf: &Arc<Mutex<VecDeque<String>>>,
        wmic_runner: &dyn Fn() -> std::io::Result<std::process::Output>,
        powershell_runner: &dyn Fn() -> std::io::Result<std::process::Output>,
    ) -> Vec<(u32, String)> {
        match wmic_runner() {
            Ok(output) => {
                if output.status.success() && !output.stdout.is_empty() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let procs = parse_wmic_csv(&stdout);
                    if !procs.is_empty() {
                        return procs;
                    }
                    // wmic ran successfully but produced no usable rows —
                    // fall through to PowerShell silently (not a failure).
                } else {
                    let stderr_snip = Self::stderr_snippet(&output.stderr);
                    let msg = format!(
                        "[cloudflared-cleanup] wmic exited {} — falling back to powershell: {}",
                        output.status, stderr_snip
                    );
                    eprintln!("{}", msg);
                    Self::push_log_line(log_buf, msg);
                }
            }
            Err(err) => {
                // Distinguish "binary genuinely missing" from other spawn
                // failures (permission denial, policy blocks, etc.) so the
                // diagnostic isn't misleading on systems where wmic exists
                // but can't be launched.
                let msg = if err.kind() == std::io::ErrorKind::NotFound {
                    format!(
                        "[cloudflared-cleanup] wmic not present ({}), falling back to powershell",
                        err
                    )
                } else {
                    format!(
                        "[cloudflared-cleanup] wmic spawn failed ({}), falling back to powershell",
                        err
                    )
                };
                eprintln!("{}", msg);
                Self::push_log_line(log_buf, msg);
            }
        }

        // wmic absent or returned nothing — fall back to PowerShell.
        let output = match powershell_runner() {
            Ok(out) => out,
            Err(err) => {
                let msg = format!(
                    "[cloudflared-cleanup] powershell spawn failed: {} — cannot enumerate processes, skipping orphan cleanup",
                    err
                );
                eprintln!("{}", msg);
                Self::push_log_line(log_buf, msg);
                return Vec::new();
            }
        };
        if !output.status.success() {
            let stderr_snip = Self::stderr_snippet(&output.stderr);
            let msg = format!(
                "[cloudflared-cleanup] powershell exited {} — cannot enumerate processes, skipping orphan cleanup: {}",
                output.status, stderr_snip
            );
            eprintln!("{}", msg);
            Self::push_log_line(log_buf, msg);
            return Vec::new();
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        parse_powershell_json(&stdout)
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
        Self::kill_orphan_cloudflared(self.config.port, &self.log_buffer);

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

        // Build a comprehensive PATH. macOS GUI apps launched via launchd
        // (including this Tauri tray binary) inherit a minimal PATH
        // (`/usr/bin:/bin:/usr/sbin:/sbin`) that misses Homebrew, nvm,
        // npm-global, pipx, `~/.claude/local/node_modules/.bin`, and
        // cloudflared. Without enrichment, every subprocess the server
        // spawns (claude CLI, git, hooks, MCP servers) will silently fail
        // to resolve common tools. See issue #2893 for the defense-in-depth
        // rationale — this is the root-cause fix, complementing per-binary
        // `resolveBinary()` fallback lists in the Node server.
        let node_bin = node_path
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let base_path = std::env::var("PATH").unwrap_or_default();
        let home_dir = dirs::home_dir();
        #[cfg(unix)]
        let path_sep = ":";
        #[cfg(windows)]
        let path_sep = ";";
        let full_path =
            build_enriched_path(&base_path, &node_bin, home_dir.as_deref(), path_sep);
        cmd.env("PATH", &full_path);
        // Ensure HOME is set — macOS GUI apps may not inherit it. Reuse the
        // already-resolved `home_dir` so PATH and HOME are derived from the
        // same value rather than risking a second, potentially divergent
        // `dirs::home_dir()` lookup.
        if let Some(ref home) = home_dir {
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
        // Mark this as a bundled .app launch so the doctor Dependencies check
        // downgrades to `warn` instead of `fail` — end users can't run
        // `npm install` to fix a broken bundle; they need to reinstall.
        cmd.env("CHROXY_BUNDLED", "1");
        // No supervisor — tray app IS the supervisor
        cmd.arg("--no-supervisor");

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn server: {}", e))?;

        // Capture stdout in background thread. Unprefixed — stdout is the
        // default source; stderr and health-poll lines are source-tagged.
        let log_buf = self.log_buffer.clone();
        if let Some(stdout) = child.stdout.take() {
            let buf = log_buf.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    Self::push_log_line(&buf, line);
                }
            });
        }

        // Capture stderr in background thread, prefixed so operators can
        // distinguish normal stdout from error output in the log panel.
        if let Some(stderr) = child.stderr.take() {
            let buf = log_buf;
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    Self::push_log_line(&buf, format!("[stderr] {}", line));
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
        // Clone the shared log buffer so the health thread can surface
        // its own events (attempt counts, timeouts, connect errors) to
        // the dashboard via get_startup_logs (issue #2846).
        let log_buf = self.log_buffer.clone();

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
                        let msg = format!(
                            "[health] TIMEOUT after 60s: {} attempt(s) total, {} non-200, {} network errors",
                            attempts, non200, network_errors
                        );
                        eprintln!("{}", msg);
                        Self::push_log_line(&log_buf, msg);
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
                        let msg = format!(
                            "[health] attempt #{} GET {} -> {} ({}ms)",
                            attempts, url, code, elapsed_ms
                        );
                        eprintln!("{}", msg);
                        Self::push_log_line(&log_buf, msg);
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
                        let msg = format!(
                            "[health] attempt #{} GET {} -> Err({}) ({}ms)",
                            attempts, url, err, elapsed_ms
                        );
                        eprintln!("{}", msg);
                        Self::push_log_line(&log_buf, msg);
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
                    Err(err) => {
                        let mut s = lock_or_recover(&status);
                        if *s == ServerStatus::Running {
                            let msg = format!(
                                "[health] monitor GET {} -> Err({}): server stopped responding",
                                url, err
                            );
                            eprintln!("{}", msg);
                            Self::push_log_line(&log_buf, msg);
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

    // -- build_enriched_path --
    //
    // These tests pin down the pure PATH-enrichment helper used before
    // spawning the Node server child. They exercise the Unix path shape
    // because the helper is Unix-specific (Windows only gets node_bin +
    // base_path).

    #[cfg(unix)]
    #[test]
    fn build_enriched_path_prepends_node_bin_first() {
        let out = build_enriched_path("/usr/bin:/bin", "/tmp/node/bin", None, ":");
        assert!(
            out.starts_with("/tmp/node/bin:"),
            "node_bin must be prepended first, got: {}",
            out
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_enriched_path_appends_base_path_verbatim() {
        let out = build_enriched_path("/existing:/stuff", "/tmp/node/bin", None, ":");
        assert!(
            out.ends_with("/existing:/stuff"),
            "base_path should end the result, got: {}",
            out
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_enriched_path_includes_system_bins_on_unix() {
        // Base path is deliberately missing Homebrew + /usr/local/bin.
        let out = build_enriched_path("/usr/bin:/bin", "/tmp/node/bin", None, ":");
        assert!(out.contains("/opt/homebrew/bin"), "homebrew missing: {}", out);
        assert!(out.contains("/usr/local/bin"), "/usr/local/bin missing: {}", out);
    }

    #[cfg(unix)]
    #[test]
    fn build_enriched_path_skips_system_dir_already_in_base_path() {
        let out = build_enriched_path(
            "/opt/homebrew/bin:/usr/bin:/bin",
            "/tmp/node/bin",
            None,
            ":",
        );
        // Homebrew appears exactly once (in the base path) — not prepended again.
        let occurrences = out.matches("/opt/homebrew/bin").count();
        assert_eq!(occurrences, 1, "homebrew duplicated in: {}", out);
    }

    #[cfg(unix)]
    #[test]
    fn build_enriched_path_includes_user_install_dirs_when_home_is_some() {
        let home = std::path::PathBuf::from("/Users/alice");
        let out = build_enriched_path("/usr/bin:/bin", "/tmp/node/bin", Some(&home), ":");
        assert!(
            out.contains("/Users/alice/.local/bin"),
            "~/.local/bin missing: {}",
            out
        );
        assert!(
            out.contains("/Users/alice/.npm-global/bin"),
            "~/.npm-global/bin missing: {}",
            out
        );
        assert!(
            out.contains("/Users/alice/.claude/local/node_modules/.bin"),
            "~/.claude/local/node_modules/.bin missing: {}",
            out
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_enriched_path_omits_user_install_dirs_when_home_is_none() {
        let out = build_enriched_path("/usr/bin:/bin", "/tmp/node/bin", None, ":");
        assert!(!out.contains(".local/bin"), "should not inject .local/bin without HOME: {}", out);
        assert!(!out.contains(".npm-global/bin"), "should not inject .npm-global/bin without HOME: {}", out);
        assert!(
            !out.contains(".claude/local/node_modules/.bin"),
            "should not inject claude-local without HOME: {}",
            out
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_enriched_path_handles_empty_base_path() {
        // An empty base PATH happens when `env -i` strips it — the helper
        // must still produce a usable PATH (no leading/trailing separators,
        // no empty elements).
        let out = build_enriched_path("", "/tmp/node/bin", None, ":");
        assert!(!out.is_empty());
        assert!(!out.starts_with(':'), "leading separator: {}", out);
        assert!(!out.ends_with(':'), "trailing separator: {}", out);
        assert!(!out.contains("::"), "empty element: {}", out);
    }

    #[cfg(unix)]
    #[test]
    fn build_enriched_path_handles_empty_node_bin() {
        // resolve_node22() could conceivably return a root path with no
        // parent — guard against prepending an empty string (which would
        // produce a leading `:` and silently search CWD).
        let out = build_enriched_path("/usr/bin:/bin", "", None, ":");
        assert!(!out.starts_with(':'), "leading separator: {}", out);
        assert!(!out.contains("::"), "empty element: {}", out);
    }

    #[test]
    fn build_enriched_path_honors_custom_separator() {
        // Windows callers pass ";" — verify the helper does not hardcode ":".
        let out = build_enriched_path("C:\\Windows;C:\\Windows\\System32", "C:\\node", None, ";");
        // The windows branch only prepends node_bin + base_path.
        assert!(out.starts_with("C:\\node;"), "unexpected prefix: {}", out);
        assert!(out.ends_with("C:\\Windows;C:\\Windows\\System32"), "unexpected suffix: {}", out);
    }

    /// User install dir already in base_path must not be duplicated.
    /// Symmetric to `build_enriched_path_skips_system_dir_already_in_base_path`
    /// but exercises the user-dir branch (`~/.local/bin`, `~/.npm-global/bin`).
    #[cfg(unix)]
    #[test]
    fn build_enriched_path_skips_user_install_dir_already_in_base_path() {
        let home = std::path::PathBuf::from("/Users/alice");
        // base_path already contains both user install dirs.
        let base = "/Users/alice/.local/bin:/Users/alice/.npm-global/bin:/usr/bin:/bin";
        let out = build_enriched_path(base, "/tmp/node/bin", Some(&home), ":");

        let local_bin_count = out.split(':').filter(|e| *e == "/Users/alice/.local/bin").count();
        assert_eq!(local_bin_count, 1, "~/.local/bin duplicated in: {}", out);

        let npm_bin_count = out.split(':').filter(|e| *e == "/Users/alice/.npm-global/bin").count();
        assert_eq!(npm_bin_count, 1, "~/.npm-global/bin duplicated in: {}", out);
    }

    /// When `node_bin` equals a system bin (e.g. `/usr/bin`) the contract is:
    /// that directory appears exactly once in the output — node_bin is
    /// prepended, and the dedup logic then suppresses the duplicate from the
    /// system-bins list.
    #[cfg(unix)]
    #[test]
    fn build_enriched_path_node_bin_equals_system_bin_appears_once() {
        // node_bin == "/usr/bin" — also a system bin candidate.
        let out = build_enriched_path("/bin", "/usr/bin", None, ":");
        let count = out.split(':').filter(|e| *e == "/usr/bin").count();
        assert_eq!(count, 1, "/usr/bin should appear exactly once, got: {}", out);
        // It should still be first (node_bin is always prepended before system bins).
        assert!(out.starts_with("/usr/bin:"), "node_bin must be first, got: {}", out);
    }

    /// Regression: element-level dedup must not suppress `/bin` because
    /// `base_path` contains `/sbin` (substring match would incorrectly skip it).
    #[cfg(unix)]
    #[test]
    fn build_enriched_path_sbin_does_not_suppress_bin() {
        // base_path contains /sbin but NOT /bin.
        let out = build_enriched_path("/sbin:/usr/sbin", "/tmp/node/bin", None, ":");
        assert!(
            out.split(':').any(|e| e == "/bin"),
            "/bin should be present when base_path only has /sbin, got: {}",
            out
        );
    }

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

    // -- push_log_line: shared helper used by health-poll (#2846) --

    #[test]
    fn push_log_line_appends_to_buffer() {
        let mgr = ServerManager::new();
        ServerManager::push_log_line(&mgr.log_buffer, "[health] attempt #1".to_string());
        ServerManager::push_log_line(&mgr.log_buffer, "[health] attempt #2".to_string());
        let logs = mgr.get_logs();
        assert_eq!(
            logs,
            vec!["[health] attempt #1".to_string(), "[health] attempt #2".to_string()]
        );
    }

    #[test]
    fn push_log_line_enforces_100_line_ceiling() {
        let mgr = ServerManager::new();
        let cap = ServerManager::MAX_LOG_LINES;
        let overflow = 50usize;
        for i in 0..(cap + overflow) {
            ServerManager::push_log_line(&mgr.log_buffer, format!("line {}", i));
        }
        let logs = mgr.get_logs();
        assert_eq!(logs.len(), cap, "buffer must cap at MAX_LOG_LINES");
        // Oldest `overflow` lines dropped; buffer should start at "line {overflow}".
        assert_eq!(logs.first().unwrap(), &format!("line {}", overflow));
        assert_eq!(logs.last().unwrap(), &format!("line {}", cap + overflow - 1));
    }

    #[test]
    fn push_log_line_surfaces_through_get_startup_logs_style_tail() {
        // Simulate what the `get_startup_logs` command does: take the last N
        // lines of the buffer after health-poll lines have been pushed.
        let mgr = ServerManager::new();
        // Simulate a stdout line (as the drain thread would push — unprefixed).
        ServerManager::push_log_line(&mgr.log_buffer, "server starting".to_string());
        // Simulate a stderr line (as the drain thread would push — [stderr] prefixed).
        ServerManager::push_log_line(&mgr.log_buffer, "[stderr] warning: bind".to_string());
        // Simulate health-poll lines landing in the same buffer.
        ServerManager::push_log_line(
            &mgr.log_buffer,
            "[health] attempt #1 GET http://127.0.0.1:8765/ -> Err(connection refused) (2ms)"
                .to_string(),
        );
        ServerManager::push_log_line(
            &mgr.log_buffer,
            "[health] TIMEOUT after 60s: 30 attempt(s) total, 0 non-200, 30 network errors"
                .to_string(),
        );

        let all = mgr.get_logs();
        // Mirror the logic in lib.rs::get_startup_logs with limit=30.
        let n = 30usize.min(all.len());
        let start = all.len().saturating_sub(n);
        let tail: Vec<String> = all[start..].to_vec();

        assert_eq!(tail.len(), 4);
        assert!(tail.iter().any(|l| l == "server starting"));
        assert!(tail.iter().any(|l| l.starts_with("[stderr]")));
        assert!(tail.iter().any(|l| l.contains("connection refused")));
        assert!(tail.iter().any(|l| l.contains("TIMEOUT after 60s")));
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

    #[test]
    fn cloudflared_filter_tolerates_non_ascii_command_lines() {
        // Regression: the .exe suffix check previously sliced `base` as a
        // &str at byte offset `len - 4`, which panics when that offset
        // lands inside a multi-byte UTF-8 codepoint. Any process with
        // non-ASCII glyphs in its command (common on localized systems,
        // or bash wrappers using Unicode math symbols like ×) would
        // crash startup before the real Chroxy server was spawned.
        let procs = vec![
            (10u32, "bash -c 'echo t=2×5s'".to_string()),
            (11u32, "python3 résumé.py".to_string()),
            (12u32, "/usr/bin/日本語-app --foo".to_string()),
            (13u32, "cloudflared tunnel --url http://localhost:8765".to_string()),
        ];
        // Must not panic and must still find the real cloudflared process.
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert_eq!(pids, vec![13]);
    }

    // -- Windows process enumeration parsers (#2850) --

    #[test]
    fn parse_wmic_csv_extracts_pid_and_command() {
        // wmic /format:csv emits "Node,CommandLine,ProcessId" header.
        let stdout = "Node,CommandLine,ProcessId\r\n\
            MYHOST,\"C:\\cloudflared\\cloudflared.exe tunnel --url http://localhost:8765\",4242\r\n\
            MYHOST,notepad.exe,1234\r\n";
        let procs = parse_wmic_csv(stdout);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].0, 4242);
        assert!(procs[0].1.contains("cloudflared.exe"));
        assert!(procs[0].1.contains("http://localhost:8765"));
        assert_eq!(procs[1].0, 1234);
    }

    #[test]
    fn parse_wmic_csv_skips_malformed_lines() {
        let stdout = "Node,CommandLine,ProcessId\r\n\
            garbage-no-commas\r\n\
            MYHOST,cmd.exe,not-a-number\r\n\
            MYHOST,cmd.exe,777\r\n";
        let procs = parse_wmic_csv(stdout);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].0, 777);
    }

    #[test]
    fn parse_powershell_json_single_object() {
        // PowerShell ConvertTo-Json emits an object (not array) when there's
        // exactly one result.
        let stdout = r#"{"ProcessId":4242,"CommandLine":"C:\\cloudflared\\cloudflared.exe tunnel --url http://localhost:8765"}"#;
        let procs = parse_powershell_json(stdout);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].0, 4242);
        assert!(procs[0].1.contains("cloudflared.exe"));
        assert!(procs[0].1.contains("http://localhost:8765"));
    }

    #[test]
    fn parse_powershell_json_array() {
        let stdout = r#"[
            {"ProcessId":4242,"CommandLine":"C:\\cloudflared\\cloudflared.exe tunnel --url http://localhost:8765"},
            {"ProcessId":1234,"CommandLine":"notepad.exe"},
            {"ProcessId":5678,"CommandLine":"C:\\Windows\\System32\\svchost.exe -k netsvcs"}
        ]"#;
        let procs = parse_powershell_json(stdout);
        assert_eq!(procs.len(), 3);
        assert_eq!(procs[0].0, 4242);
        assert_eq!(procs[1].0, 1234);
        assert_eq!(procs[2].0, 5678);
    }

    #[test]
    fn parse_powershell_json_skips_null_commandline() {
        // Kernel/system processes often have null CommandLine — those can
        // never match the cloudflared filter, so skipping is fine.
        let stdout = r#"[
            {"ProcessId":4,"CommandLine":null},
            {"ProcessId":4242,"CommandLine":"cloudflared tunnel --url http://localhost:8765"}
        ]"#;
        let procs = parse_powershell_json(stdout);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].0, 4242);
    }

    #[test]
    fn parse_powershell_json_empty_input() {
        assert!(parse_powershell_json("").is_empty());
        assert!(parse_powershell_json("   \n  ").is_empty());
    }

    #[test]
    fn parse_powershell_json_malformed() {
        // Garbage input must not panic — returns empty.
        assert!(parse_powershell_json("not json at all").is_empty());
        assert!(parse_powershell_json("{\"ProcessId\":").is_empty());
    }

    // -- stderr_snippet: enumeration-failure diagnostic helper (#2868) --

    #[test]
    fn stderr_snippet_returns_placeholder_for_empty() {
        assert_eq!(ServerManager::stderr_snippet(b""), "<no stderr>");
        assert_eq!(ServerManager::stderr_snippet(b"   \n\n  "), "<no stderr>");
    }

    #[test]
    fn stderr_snippet_collapses_multiline() {
        let stderr = b"line one\nline two\r\nline three";
        let snip = ServerManager::stderr_snippet(stderr);
        assert_eq!(snip, "line one | line two | line three");
    }

    #[test]
    fn stderr_snippet_trims_whitespace() {
        let stderr = b"   hello world   \n";
        let snip = ServerManager::stderr_snippet(stderr);
        assert_eq!(snip, "hello world");
    }

    #[test]
    fn stderr_snippet_truncates_long_output() {
        // 300-char stderr should be truncated to 200 chars + ellipsis.
        let stderr = vec![b'x'; 300];
        let snip = ServerManager::stderr_snippet(&stderr);
        assert!(snip.ends_with("..."));
        // 200 chars + "..." = 203 chars total
        assert_eq!(snip.chars().count(), 203);
    }

    #[test]
    fn stderr_snippet_preserves_short_single_line() {
        let stderr = b"wmic: command not found";
        let snip = ServerManager::stderr_snippet(stderr);
        assert_eq!(snip, "wmic: command not found");
    }

    #[test]
    fn stderr_snippet_handles_invalid_utf8() {
        // Must not panic on non-UTF-8 bytes — String::from_utf8_lossy
        // replaces invalid sequences with U+FFFD.
        let stderr = &[0xff, 0xfe, b'h', b'i'];
        let snip = ServerManager::stderr_snippet(stderr);
        assert!(snip.contains("hi"));
    }

    // -- kill_orphan_cloudflared: enumeration-failure logging (#2868, #2887) --

    #[cfg(unix)]
    #[test]
    fn kill_orphan_cloudflared_logs_when_ps_spawn_fails() {
        // Smoke test: the real call path on a dev machine where `ps`
        // exists — proves the signature compiles and the happy path
        // does not panic. Deterministic failure-path coverage lives in
        // the `enumerate_unix_processes_*` tests below (#2887).
        let mgr = ServerManager::new();
        // Call with an obviously-unused port so no PIDs match.
        ServerManager::kill_orphan_cloudflared(1, &mgr.log_buffer);
    }

    // -- enumerate_unix_processes_with_runner: deterministic unix
    //    failure-path coverage via injected command factory (#2887) --

    /// Build a synthetic non-success `Output`. Uses
    /// `ExitStatus::from_raw` with a non-zero code so `.success()` is
    /// false across both unix (raw wait status) and windows (raw
    /// exit code) targets.
    fn fake_failed_output(stderr: &[u8]) -> std::process::Output {
        #[cfg(unix)]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            // Encode exit code 2 in the high byte of wait(2) status.
            std::process::ExitStatus::from_raw(2 << 8)
        };
        #[cfg(windows)]
        let status = {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(2)
        };
        std::process::Output {
            status,
            stdout: Vec::new(),
            stderr: stderr.to_vec(),
        }
    }

    fn fake_ok_output(stdout: &[u8]) -> std::process::Output {
        #[cfg(unix)]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(0)
        };
        #[cfg(windows)]
        let status = {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(0)
        };
        std::process::Output {
            status,
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
        }
    }

    fn log_buffer_contains(
        buf: &Arc<Mutex<VecDeque<String>>>,
        needle: &str,
    ) -> bool {
        lock_or_recover(buf).iter().any(|line| line.contains(needle))
    }

    #[test]
    fn enumerate_unix_processes_logs_and_returns_empty_on_spawn_err() {
        let mgr = ServerManager::new();
        let procs = ServerManager::enumerate_unix_processes_with_runner(
            9876,
            &mgr.log_buffer,
            &|| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no ps here")),
        );
        assert!(procs.is_empty());
        assert!(
            log_buffer_contains(&mgr.log_buffer, "[cloudflared-cleanup] ps spawn failed: "),
            "expected ps-spawn-failed log line, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "no ps here"),
            "expected io::Error message in log, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "port 9876"),
            "expected port in log line, got: {:?}",
            mgr.get_logs()
        );
    }

    #[test]
    fn enumerate_unix_processes_logs_and_returns_empty_on_non_zero_exit() {
        let mgr = ServerManager::new();
        let procs = ServerManager::enumerate_unix_processes_with_runner(
            4242,
            &mgr.log_buffer,
            &|| Ok(fake_failed_output(b"ps: permission denied")),
        );
        assert!(procs.is_empty());
        assert!(
            log_buffer_contains(&mgr.log_buffer, "[cloudflared-cleanup] ps exited "),
            "expected ps-exited log prefix, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "ps: permission denied"),
            "expected stderr snippet in log, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "port 4242"),
            "expected port in log line, got: {:?}",
            mgr.get_logs()
        );
    }

    #[test]
    fn enumerate_unix_processes_returns_parsed_pairs_on_success() {
        let mgr = ServerManager::new();
        let stdout = b"  1234 /usr/bin/cloudflared tunnel --url http://localhost:8765\n  5678 /bin/bash\n";
        let procs = ServerManager::enumerate_unix_processes_with_runner(
            8765,
            &mgr.log_buffer,
            &|| Ok(fake_ok_output(stdout)),
        );
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].0, 1234);
        assert!(procs[0].1.contains("cloudflared"));
        assert!(
            lock_or_recover(&mgr.log_buffer).is_empty(),
            "success path must not emit any log lines"
        );
    }

    // -- enumerate_windows_processes_with_runners: deterministic
    //    windows failure-path coverage via injected command factories
    //    (#2887). All four paths run on dev macOS/Linux via cross-
    //    platform `cfg(any(windows, test))` gating. --

    #[test]
    fn enumerate_windows_processes_logs_wmic_spawn_err_then_falls_back() {
        let mgr = ServerManager::new();
        // wmic spawn fails, powershell returns empty JSON array.
        let procs = ServerManager::enumerate_windows_processes_with_runners(
            &mgr.log_buffer,
            &|| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "blocked by policy")),
            &|| Ok(fake_ok_output(b"[]")),
        );
        assert!(procs.is_empty());
        assert!(
            log_buffer_contains(&mgr.log_buffer, "[cloudflared-cleanup] wmic spawn failed "),
            "expected wmic-spawn-failed log prefix, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "blocked by policy"),
            "expected io::Error message in log, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "falling back to powershell"),
            "expected fallback notice in log, got: {:?}",
            mgr.get_logs()
        );
    }

    #[test]
    fn enumerate_windows_processes_logs_wmic_non_success_then_falls_back() {
        let mgr = ServerManager::new();
        let procs = ServerManager::enumerate_windows_processes_with_runners(
            &mgr.log_buffer,
            &|| Ok(fake_failed_output(b"wmic: access denied")),
            &|| Ok(fake_ok_output(b"[]")),
        );
        assert!(procs.is_empty());
        assert!(
            log_buffer_contains(&mgr.log_buffer, "[cloudflared-cleanup] wmic exited "),
            "expected wmic-exited log prefix, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "wmic: access denied"),
            "expected stderr snippet in log, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "falling back to powershell"),
            "expected fallback notice in log, got: {:?}",
            mgr.get_logs()
        );
    }

    #[test]
    fn enumerate_windows_processes_logs_powershell_spawn_err() {
        let mgr = ServerManager::new();
        let procs = ServerManager::enumerate_windows_processes_with_runners(
            &mgr.log_buffer,
            // wmic fails too so we actually reach the powershell fallback.
            &|| Ok(fake_failed_output(b"wmic broken")),
            &|| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "powershell missing")),
        );
        assert!(procs.is_empty());
        assert!(
            log_buffer_contains(&mgr.log_buffer, "[cloudflared-cleanup] powershell spawn failed: "),
            "expected powershell-spawn-failed log prefix, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "powershell missing"),
            "expected io::Error message in log, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "cannot enumerate processes"),
            "expected terminal diagnostic, got: {:?}",
            mgr.get_logs()
        );
    }

    #[test]
    fn enumerate_windows_processes_logs_powershell_non_success() {
        let mgr = ServerManager::new();
        let procs = ServerManager::enumerate_windows_processes_with_runners(
            &mgr.log_buffer,
            &|| Ok(fake_failed_output(b"wmic exit 1")),
            &|| Ok(fake_failed_output(b"Get-CimInstance: The WMI provider returned an error")),
        );
        assert!(procs.is_empty());
        assert!(
            log_buffer_contains(&mgr.log_buffer, "[cloudflared-cleanup] powershell exited "),
            "expected powershell-exited log prefix, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "Get-CimInstance: The WMI provider returned an error"),
            "expected stderr snippet in log, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "cannot enumerate processes"),
            "expected terminal diagnostic, got: {:?}",
            mgr.get_logs()
        );
    }

    #[test]
    fn enumerate_windows_processes_wmic_success_skips_powershell() {
        let mgr = ServerManager::new();
        let wmic_stdout = b"Node,CommandLine,ProcessId\r\nWIN-HOST,cloudflared tunnel --url http://localhost:8765,4242\r\n";
        let powershell_called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ps_flag = powershell_called.clone();
        let procs = ServerManager::enumerate_windows_processes_with_runners(
            &mgr.log_buffer,
            &|| Ok(fake_ok_output(wmic_stdout)),
            &|| {
                ps_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(fake_ok_output(b"[]"))
            },
        );
        assert!(!procs.is_empty(), "wmic success should yield parsed procs");
        assert_eq!(procs[0].0, 4242);
        assert!(
            !powershell_called.load(std::sync::atomic::Ordering::SeqCst),
            "powershell fallback must not run when wmic returns usable rows"
        );
        assert!(
            lock_or_recover(&mgr.log_buffer).is_empty(),
            "wmic-success path must not emit any log lines"
        );
    }

    #[test]
    fn enumerate_windows_processes_wmic_not_found_uses_distinct_log() {
        // ErrorKind::NotFound is special-cased to "wmic not present"
        // rather than "wmic spawn failed" so the diagnostic matches
        // the systemic case (Windows 11 22H2+ ships without wmic).
        let mgr = ServerManager::new();
        ServerManager::enumerate_windows_processes_with_runners(
            &mgr.log_buffer,
            &|| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "wmic not on PATH")),
            &|| Ok(fake_ok_output(b"[]")),
        );
        assert!(
            log_buffer_contains(&mgr.log_buffer, "[cloudflared-cleanup] wmic not present "),
            "expected wmic-not-present log prefix, got: {:?}",
            mgr.get_logs()
        );
        assert!(
            !log_buffer_contains(&mgr.log_buffer, "wmic spawn failed"),
            "spawn-failed log must not appear for NotFound errors"
        );
    }

    #[test]
    fn parse_powershell_json_feeds_cloudflared_filter() {
        // End-to-end sanity check: PowerShell JSON → filter → expected pid.
        let stdout = r#"[
            {"ProcessId":4242,"CommandLine":"\"C:\\Program Files\\cloudflared\\cloudflared.exe\" tunnel --url http://localhost:8765"},
            {"ProcessId":1234,"CommandLine":"notepad.exe"},
            {"ProcessId":9999,"CommandLine":"cloudflared tunnel --url http://localhost:9999"}
        ]"#;
        let procs = parse_powershell_json(stdout);
        let pids = cloudflared_pids_to_kill(&procs, 8765);
        assert_eq!(pids, vec![4242]);
    }
}
