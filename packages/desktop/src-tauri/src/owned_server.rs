//! Proof that the process holding the configured port is a server THIS app
//! spawned (#8388).
//!
//! A launch-time start used to SIGTERM (or `taskkill /F`) whatever node or chroxy
//! process held the port, to clear an orphan left by a previous run of the app.
//! That also stopped a launchd service or a `chroxy start` daemon the app has no
//! business touching. The only holder an automatic start may stop is one it can
//! PROVE it started, and a lookalike is not proof, so two independent facts must
//! both hold:
//!
//! 1. **A record.** When the app spawns its server it writes the child's pid to
//!    `desktop-server.pid` in the config dir. The holder's pid must equal it.
//!    This is what separates the app's orphan from an identical process somebody
//!    else started: nothing but this app ever writes the file.
//! 2. **A matching command line.** The holder's command line must be this app's
//!    own invocation (`<node> <cli.js> start --no-supervisor`, with the exact
//!    `cli.js` the app would spawn now). This guards the record against going
//!    stale: after a reboot the recorded pid can belong to anything.
//!
//! Anything short of both, including a missing file, an unreadable process table
//! or `lsof` being absent, reads as "not ours". That direction fails safe: a
//! daemon that is really an orphan of ours is adopted instead of replaced.
//!
//! The decisions are pure functions so they are unit-testable on any host; only
//! the three process-table helpers at the bottom are platform code.

use std::io;
use std::path::{Path, PathBuf};

const PID_FILE_NAME: &str = "desktop-server.pid";

/// Where the app records the pid of the server it spawned.
pub fn pid_file_path() -> Option<PathBuf> {
    crate::config::config_dir().map(|d| d.join(PID_FILE_NAME))
}

/// Record the pid of a server this app just spawned.
pub fn record_pid(path: &Path, pid: u32) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, format!("{}\n", pid))
}

/// The recorded pid, or `None` for a missing, empty or malformed file.
pub fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Delete the record, but only if it still names `pid`. A newer server's record
/// (or a test's fake child) must survive the death of an older one.
pub fn clear_pid_if(path: &Path, pid: u32) {
    if read_pid(path) == Some(pid) {
        let _ = std::fs::remove_file(path);
    }
}

/// True if `cmd` is the app's own server invocation for `cli_js`:
/// `<node> <cli_js> start ... --no-supervisor ...`.
///
/// Matches whole tokens. A substring test would accept `/y/x/cli.js` for
/// `/x/cli.js`, and `--no-supervisor-foo` for `--no-supervisor`; the path is
/// matched as a space-delimited run (the path itself may contain spaces, and
/// Windows quotes it), so it is searched for rather than split out.
pub fn is_own_server_command(cmd: &str, cli_js: &Path) -> bool {
    let cmd = cmd.replace('"', "");
    let needle = format!("{} start", cli_js.display());
    let at_a_boundary = cmd.match_indices(&needle).any(|(i, _)| {
        let before_ok = i == 0 || cmd[..i].ends_with(char::is_whitespace);
        let after = &cmd[i + needle.len()..];
        before_ok && (after.is_empty() || after.starts_with(char::is_whitespace))
    });
    at_a_boundary && cmd.split_whitespace().any(|t| t == "--no-supervisor")
}

/// The listeners that are provably this app's own server, or empty.
///
/// All-or-nothing: with no listener, or with any listener that does not satisfy
/// both facts, the answer is empty. A port with a mixed set of holders is not
/// one the app may clear.
pub fn own_holder_pids(
    listeners: &[u32],
    recorded: Option<u32>,
    command_of: impl Fn(u32) -> Option<String>,
    cli_js: &Path,
) -> Vec<u32> {
    let Some(recorded) = recorded else {
        return Vec::new();
    };
    let own = |pid: u32| {
        pid == recorded
            && command_of(pid)
                .map(|cmd| is_own_server_command(&cmd, cli_js))
                .unwrap_or(false)
    };
    if listeners.is_empty() || !listeners.iter().all(|&p| own(p)) {
        return Vec::new();
    }
    listeners.to_vec()
}

/// Parse whitespace-separated pids (`lsof -t` output). Garbage is skipped.
#[cfg(any(unix, test))]
pub fn parse_pid_list(out: &str) -> Vec<u32> {
    out.split_whitespace().filter_map(|t| t.parse().ok()).collect()
}

/// Pids LISTENING on `port` in `netstat -ano -p tcp` output.
///
/// A listening row has a remote address of `...:0`, which holds on localised
/// Windows too (the state column is translated; `LISTENING` is not portable).
/// The local port is compared whole, so `:87650` and `:18765` are not `:8765`.
#[cfg(any(windows, test))]
pub fn parse_netstat_listeners(out: &str, port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in out.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 5 || !t[0].eq_ignore_ascii_case("tcp") {
            continue;
        }
        let port_of = |addr: &str| addr.rsplit_once(':').and_then(|(_, p)| p.parse::<u16>().ok());
        if port_of(t[1]) == Some(port) && port_of(t[2]) == Some(0) {
            if let Ok(pid) = t[t.len() - 1].parse::<u32>() {
                if !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
        }
    }
    pids
}

/// The uid in `ps -o uid= -p <pid>` output, or `None` when the output is not
/// exactly one unsigned number.
#[cfg(any(unix, test))]
pub fn parse_uid(out: &str) -> Option<u32> {
    out.trim().parse().ok()
}

/// Split one CSV line into fields. Quotes group a field (a field such as
/// `"50,000 K"` holds a comma) and a doubled quote inside one is a literal quote.
#[cfg(any(windows, test))]
fn split_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    fields.push(cur);
    fields
}

/// The user name column of `tasklist /v /fo csv /nh /fi "PID eq <pid>"` for
/// `pid`, or `None` if the row is missing, is another pid's, is short, or the
/// column reads `N/A` (a process of another user, as seen from a normal account).
#[cfg(any(windows, test))]
pub fn parse_tasklist_user(out: &str, pid: u32) -> Option<String> {
    let pid = pid.to_string();
    out.lines().find_map(|line| {
        let f = split_csv_line(line.trim());
        // Image Name, PID, Session Name, Session#, Mem Usage, Status, User Name, ...
        if f.len() < 7 || f[1] != pid {
            return None;
        }
        let user = f[6].trim();
        (!user.is_empty() && !user.eq_ignore_ascii_case("n/a")).then(|| user.to_string())
    })
}

/// True if a `DOMAIN\user` process owner is exactly the current `domain` and
/// `user`. Case-insensitive, as Windows account names are.
#[cfg(any(windows, test))]
pub fn windows_owner_is(owner: &str, domain: &str, user: &str) -> bool {
    !domain.is_empty()
        && !user.is_empty()
        && owner.eq_ignore_ascii_case(&format!("{}\\{}", domain, user))
}

/// True only when there is at least one listener and every one of them is
/// known to run as the current user. `runs_as_current_user` answers `None` when
/// the owner could not be determined, and that is the same as "not the current
/// user": an owner that cannot be proven is a foreign holder.
pub fn all_run_as_current_user(
    listeners: &[u32],
    runs_as_current_user: impl Fn(u32) -> Option<bool>,
) -> bool {
    !listeners.is_empty() && listeners.iter().all(|&p| runs_as_current_user(p) == Some(true))
}

/// True when every listener on `port` runs as the current user. A port with no
/// findable listener, or with one whose owner cannot be read, is not.
pub fn holders_run_as_current_user(port: u16) -> bool {
    all_run_as_current_user(&listener_pids(port), process_runs_as_current_user)
}

/// The provably-own listeners on `port`, per the on-disk record and the live
/// process table. Empty means "not ours" (or "cannot tell"), never "free".
pub fn find_own_holder_pids(port: u16, pid_file: Option<&Path>, cli_js: &Path) -> Vec<u32> {
    find_own_holder_pids_with(port, pid_file, cli_js, listener_pids, process_command)
}

/// [`find_own_holder_pids`] with the process table passed in.
pub fn find_own_holder_pids_with(
    port: u16,
    pid_file: Option<&Path>,
    cli_js: &Path,
    listeners_of: impl Fn(u16) -> Vec<u32>,
    command_of: impl Fn(u32) -> Option<String>,
) -> Vec<u32> {
    let Some(pid_file) = pid_file else {
        return Vec::new();
    };
    own_holder_pids(&listeners_of(port), read_pid(pid_file), command_of, cli_js)
}

// ---- platform: process table -----------------------------------------------

/// Pids with a listening socket on loopback-reachable `port`.
#[cfg(unix)]
pub fn listener_pids(port: u16) -> Vec<u32> {
    std::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{}", port), "-sTCP:LISTEN", "-t"])
        .output()
        .map(|o| parse_pid_list(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(windows)]
pub fn listener_pids(port: u16) -> Vec<u32> {
    std::process::Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map(|o| parse_netstat_listeners(&String::from_utf8_lossy(&o.stdout), port))
        .unwrap_or_default()
}

/// A process command line from tool output: trimmed, and `None` when empty.
pub fn parse_command_output(out: &str) -> Option<String> {
    let cmd = out.trim();
    (!cmd.is_empty()).then(|| cmd.to_string())
}

/// The full command line of `pid`, or `None` if it cannot be read.
#[cfg(unix)]
pub fn process_command(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    parse_command_output(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(windows)]
pub fn process_command(pid: u32) -> Option<String> {
    let script = format!(
        "(Get-CimInstance Win32_Process -Filter 'ProcessId={}').CommandLine",
        pid
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    parse_command_output(&String::from_utf8_lossy(&out.stdout))
}

/// Whether `pid` runs as the current user: `Some(true)` or `Some(false)` when it
/// is known, `None` when it could not be determined.
#[cfg(unix)]
pub fn process_runs_as_current_user(pid: u32) -> Option<bool> {
    let out = std::process::Command::new("ps")
        .args(["-o", "uid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let uid = parse_uid(&String::from_utf8_lossy(&out.stdout))?;
    // SAFETY: `getuid` takes no arguments, has no preconditions and cannot fail.
    Some(uid == unsafe { libc::getuid() })
}

#[cfg(windows)]
pub fn process_runs_as_current_user(pid: u32) -> Option<bool> {
    let out = std::process::Command::new("tasklist")
        .args(["/v", "/fo", "csv", "/nh", "/fi", &format!("PID eq {}", pid)])
        .output()
        .ok()?;
    let owner = parse_tasklist_user(&String::from_utf8_lossy(&out.stdout), pid)?;
    let domain = std::env::var("USERDOMAIN").ok()?;
    let user = std::env::var("USERNAME").ok()?;
    Some(windows_owner_is(&owner, &domain, &user))
}

/// Ask each pid to exit (SIGTERM, or `taskkill /F` where there is no signal),
/// then give them a moment to release the port.
pub fn terminate(pids: &[u32]) {
    for &pid in pids {
        #[cfg(unix)]
        {
            // SAFETY: `pid` was verified as this app's own server a moment ago; a
            // reuse race in that window is bounded by the command-line check.
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output();
        }
    }
    if !pids.is_empty() {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const CLI: &str = "/Applications/Chroxy.app/Contents/Resources/server/src/cli.js";
    const OWN_CMD: &str =
        "/opt/homebrew/opt/node@22/bin/node /Applications/Chroxy.app/Contents/Resources/server/src/cli.js start --no-supervisor";

    fn cli() -> &'static Path {
        Path::new(CLI)
    }

    // --- is_own_server_command ---------------------------------------------

    #[test]
    fn the_apps_own_invocation_is_recognised() {
        assert!(is_own_server_command(OWN_CMD, cli()));
    }

    #[test]
    fn a_daemon_started_without_no_supervisor_is_not_ours() {
        let cmd = "/usr/local/bin/node /Applications/Chroxy.app/Contents/Resources/server/src/cli.js start";
        assert!(!is_own_server_command(cmd, cli()));
        // The flag has to be a token of its own.
        let cmd = format!("{} --no-supervisor-foo", cmd);
        assert!(!is_own_server_command(&cmd, cli()));
    }

    #[test]
    fn a_launchd_daemon_from_another_checkout_is_not_ours() {
        let cmd = "/opt/homebrew/bin/node /Users/me/Projects/chroxy-daemon/packages/server/src/cli.js start --no-supervisor";
        assert!(!is_own_server_command(cmd, cli()));
    }

    #[test]
    fn the_cli_path_must_match_whole_not_as_a_suffix_or_prefix() {
        let p = Path::new("/x/cli.js");
        assert!(is_own_server_command("node /x/cli.js start --no-supervisor", p));
        assert!(!is_own_server_command("node /y/x/cli.js start --no-supervisor", p), "suffix of a longer path");
        assert!(!is_own_server_command("node /x/cli.js.bak start --no-supervisor", p), "prefix of a longer name");
        assert!(!is_own_server_command("node /x/cli.js starts --no-supervisor", p), "start is a token");
    }

    #[test]
    fn a_path_with_spaces_and_a_quoted_windows_path_match() {
        let p = Path::new("/Applications/My Apps/Chroxy.app/server/src/cli.js");
        assert!(is_own_server_command(
            "node /Applications/My Apps/Chroxy.app/server/src/cli.js start --no-supervisor",
            p
        ));
        let w = Path::new(r"C:\Program Files\Chroxy\server\src\cli.js");
        assert!(is_own_server_command(
            r#""C:\Program Files\nodejs\node.exe" "C:\Program Files\Chroxy\server\src\cli.js" start --no-supervisor"#,
            w
        ));
    }

    // --- own_holder_pids ---------------------------------------------------

    fn table(entries: Vec<(u32, &'static str)>) -> impl Fn(u32) -> Option<String> {
        move |pid| entries.iter().find(|(p, _)| *p == pid).map(|(_, c)| c.to_string())
    }

    #[test]
    fn a_recorded_pid_with_the_matching_command_is_ours() {
        let got = own_holder_pids(&[42], Some(42), table(vec![(42, OWN_CMD)]), cli());
        assert_eq!(got, vec![42]);
    }

    #[test]
    fn without_a_record_a_lookalike_is_not_ours() {
        // Identical command line, but nothing the app wrote says it spawned it.
        assert!(own_holder_pids(&[42], None, table(vec![(42, OWN_CMD)]), cli()).is_empty());
    }

    #[test]
    fn a_holder_other_than_the_recorded_pid_is_not_ours() {
        assert!(own_holder_pids(&[43], Some(42), table(vec![(43, OWN_CMD)]), cli()).is_empty());
    }

    #[test]
    fn a_stale_record_whose_pid_was_reused_is_not_ours() {
        let reused = "/usr/sbin/httpd -D FOREGROUND";
        assert!(own_holder_pids(&[42], Some(42), table(vec![(42, reused)]), cli()).is_empty());
    }

    #[test]
    fn an_unreadable_process_or_no_listener_is_not_ours() {
        assert!(own_holder_pids(&[42], Some(42), |_| None, cli()).is_empty());
        assert!(own_holder_pids(&[], Some(42), table(vec![(42, OWN_CMD)]), cli()).is_empty());
    }

    #[test]
    fn a_port_with_a_foreign_co_listener_is_not_cleared() {
        let t = table(vec![(42, OWN_CMD), (99, "/usr/bin/python3 -m http.server")]);
        assert!(own_holder_pids(&[42, 99], Some(42), t, cli()).is_empty());
    }

    // --- pid file ----------------------------------------------------------

    #[test]
    fn the_pid_record_round_trips_and_creates_its_directory() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join(PID_FILE_NAME);
        assert_eq!(read_pid(&path), None, "missing file");
        record_pid(&path, 4242).unwrap();
        assert_eq!(read_pid(&path), Some(4242));
    }

    #[test]
    fn a_malformed_record_reads_as_no_record() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(PID_FILE_NAME);
        for junk in ["", "abc", "-5", "12 34"] {
            std::fs::write(&path, junk).unwrap();
            assert_eq!(read_pid(&path), None, "{:?}", junk);
        }
    }

    #[test]
    fn clearing_removes_only_the_record_it_was_asked_about() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(PID_FILE_NAME);
        record_pid(&path, 7).unwrap();
        clear_pid_if(&path, 8);
        assert_eq!(read_pid(&path), Some(7), "someone else's record must survive");
        clear_pid_if(&path, 7);
        assert!(!path.exists());
        clear_pid_if(&path, 7); // already gone: no panic
    }

    // --- parsers -----------------------------------------------------------

    #[test]
    fn lsof_pid_lists_parse_and_skip_garbage() {
        assert_eq!(parse_pid_list("123\n456\n"), vec![123, 456]);
        assert_eq!(parse_pid_list("lsof: WARNING\n7\n"), vec![7]);
        assert!(parse_pid_list("").is_empty());
    }

    #[test]
    fn netstat_listeners_are_found_by_whole_port() {
        let out = "\
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:8765           0.0.0.0:0              LISTENING       1234
  TCP    [::]:8765              [::]:0                 LISTENING       1234
  TCP    127.0.0.1:8765         127.0.0.1:51000        ESTABLISHED     1234
  TCP    127.0.0.1:51000        127.0.0.1:8765         ESTABLISHED     777
  TCP    0.0.0.0:87650          0.0.0.0:0              LISTENING       55
  TCP    0.0.0.0:18765          0.0.0.0:0              LISTENING       56
  TCP    0.0.0.0:8765           0.0.0.0:0              ABHOEREN        99
";
        assert_eq!(parse_netstat_listeners(out, 8765), vec![1234, 99]);
        assert!(parse_netstat_listeners(out, 9999).is_empty());
    }

    // --- who the holder runs as -------------------------------------------

    #[test]
    fn a_uid_is_one_unsigned_number() {
        assert_eq!(parse_uid("  501\n"), Some(501));
        assert_eq!(parse_uid("0"), Some(0));
        assert_eq!(parse_uid(""), None, "empty: the pid was not found");
        assert_eq!(parse_uid("\n"), None);
        assert_eq!(parse_uid("abc"), None);
        assert_eq!(parse_uid("-1"), None);
        assert_eq!(parse_uid("501 502"), None, "two numbers are not one uid");
    }

    #[test]
    fn listeners_all_owned_by_the_current_user_are_adoptable() {
        assert!(all_run_as_current_user(&[42], |_| Some(true)));
        assert!(all_run_as_current_user(&[42, 43], |_| Some(true)));
    }

    #[test]
    fn a_listener_run_by_another_user_is_not_adoptable() {
        assert!(!all_run_as_current_user(&[42], |_| Some(false)));
        // One foreign co-listener is enough.
        assert!(!all_run_as_current_user(&[42, 43], |p| Some(p == 42)));
    }

    #[test]
    fn an_owner_that_cannot_be_read_is_not_adoptable() {
        assert!(!all_run_as_current_user(&[42], |_| None));
        assert!(!all_run_as_current_user(&[42, 43], |p| (p == 42).then_some(true)));
    }

    #[test]
    fn a_port_with_no_listener_found_is_not_adoptable() {
        assert!(!all_run_as_current_user(&[], |_| Some(true)));
    }

    #[test]
    fn a_tasklist_row_yields_the_owner_of_that_pid() {
        let row = r#""node.exe","1234","Console","1","50,000 K","Running","DESKTOP-AB1\chris","0:00:03","N/A""#;
        assert_eq!(parse_tasklist_user(row, 1234).as_deref(), Some("DESKTOP-AB1\\chris"));
        assert_eq!(parse_tasklist_user(&format!("{}\r\n", row), 1234).as_deref(), Some("DESKTOP-AB1\\chris"));
        assert_eq!(parse_tasklist_user(row, 123), None, "a different pid");
    }

    #[test]
    fn a_tasklist_owner_that_is_unavailable_or_unparseable_is_none() {
        let na = r#""node.exe","1234","Services","0","50,000 K","Unknown","N/A","0:00:03","N/A""#;
        assert_eq!(parse_tasklist_user(na, 1234), None, "another user's process");
        let na_lower = na.replace("N/A\",\"0:00", "n/a\",\"0:00");
        assert_eq!(parse_tasklist_user(&na_lower, 1234), None);
        assert_eq!(parse_tasklist_user("INFO: No tasks are running which match the specified criteria.", 1234), None);
        assert_eq!(parse_tasklist_user("", 1234), None);
        assert_eq!(parse_tasklist_user(r#""node.exe","1234""#, 1234), None, "short row");
        assert_eq!(parse_tasklist_user(r#""node.exe","1234","Console","1","1 K","Running","","0:00:03","N/A""#, 1234), None, "empty owner");
    }

    #[test]
    fn a_windows_owner_must_be_the_current_domain_and_user() {
        assert!(windows_owner_is("DESKTOP-AB1\\chris", "DESKTOP-AB1", "chris"));
        assert!(windows_owner_is("desktop-ab1\\CHRIS", "DESKTOP-AB1", "chris"), "case-insensitive");
        assert!(!windows_owner_is("DESKTOP-AB1\\other", "DESKTOP-AB1", "chris"));
        assert!(!windows_owner_is("OTHERBOX\\chris", "DESKTOP-AB1", "chris"));
        assert!(!windows_owner_is("NT AUTHORITY\\SYSTEM", "DESKTOP-AB1", "chris"));
        assert!(!windows_owner_is("DESKTOP-AB1\\chris", "", "chris"), "unknown domain");
        assert!(!windows_owner_is("\\", "", ""), "unknown account");
    }

    // --- command output and the injected process table ---------------------

    #[test]
    fn a_command_line_is_trimmed_and_empty_output_is_none() {
        assert_eq!(parse_command_output("  node cli.js start\n").as_deref(), Some("node cli.js start"));
        assert_eq!(parse_command_output(""), None);
        assert_eq!(parse_command_output(" \n"), None);
    }

    #[test]
    fn find_own_holder_pids_reads_the_record_and_the_given_process_table() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(PID_FILE_NAME);
        let listeners = |port: u16| if port == 8765 { vec![42] } else { vec![] };
        let commands = |pid: u32| (pid == 42).then(|| OWN_CMD.to_string());

        // No record yet: the lookalike is not ours.
        assert!(find_own_holder_pids_with(8765, Some(&path), cli(), listeners, commands).is_empty());
        record_pid(&path, 42).unwrap();
        assert_eq!(find_own_holder_pids_with(8765, Some(&path), cli(), listeners, commands), vec![42]);
        // The port is the one asked about.
        assert!(find_own_holder_pids_with(9000, Some(&path), cli(), listeners, commands).is_empty());
        // No pid file location at all.
        assert!(find_own_holder_pids_with(8765, None, cli(), listeners, commands).is_empty());
        // The record names another pid.
        record_pid(&path, 41).unwrap();
        assert!(find_own_holder_pids_with(8765, Some(&path), cli(), listeners, commands).is_empty());
    }

    #[test]
    fn a_tasklist_quoted_field_with_a_comma_stays_one_field() {
        assert_eq!(
            split_csv_line(r#""a","50,000 K","say ""hi""",z"#),
            vec!["a", "50,000 K", "say \"hi\"", "z"]
        );
    }

    // --- the live process table (unix: lsof and ps) -------------------------

    #[cfg(unix)]
    mod live {
        use super::*;
        use std::net::TcpListener;

        fn me() -> u32 {
            std::process::id()
        }

        #[test]
        fn a_listening_socket_is_found_under_its_owning_pid() {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            assert!(listener_pids(port).contains(&me()), "{:?}", listener_pids(port));
            drop(l);
            assert!(!listener_pids(port).contains(&me()), "a closed port has no listener");
        }

        #[test]
        fn a_running_process_has_a_command_line_and_a_missing_one_has_none() {
            let cmd = process_command(me()).expect("own command line");
            assert!(!cmd.is_empty());
            assert_eq!(process_command(2_000_000_000), None);
        }

        #[test]
        fn this_process_runs_as_the_current_user_and_a_missing_pid_is_unknown() {
            assert_eq!(process_runs_as_current_user(me()), Some(true));
            assert_eq!(process_runs_as_current_user(2_000_000_000), None);
        }

        #[test]
        fn pid_1_is_not_run_by_an_ordinary_user() {
            // SAFETY: `getuid` takes no arguments and cannot fail.
            if unsafe { libc::getuid() } == 0 {
                return; // root runs as pid 1's owner; nothing to tell apart
            }
            assert_eq!(process_runs_as_current_user(1), Some(false));
        }

        #[test]
        fn a_port_this_process_listens_on_is_run_by_the_current_user() {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            assert!(holders_run_as_current_user(port));
            drop(l);
            assert!(!holders_run_as_current_user(port), "no listener found");
        }
    }
}
