//! macOS speech recognition via a bundled Swift helper process.
//!
//! Provides Tauri commands for streaming voice-to-text input.
//! Uses Apple's SFSpeechRecognizer — no API keys, works offline.
//!
//! Architecture: Rust spawns `speech-helper` (compiled Swift binary) as a
//! child process. The helper streams JSON lines to stdout for each partial
//! and final transcription. Sending "stop\n" to its stdin ends recording.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// How many trailing stderr lines from the helper to retain for error
/// surfacing — enough to capture a failure reason without unbounded growth.
const STDERR_TAIL_LINES: usize = 20;

/// Payload emitted as `voice_transcription` event.
#[derive(Clone, Serialize)]
pub struct TranscriptionEvent {
    pub text: String,
    pub is_final: bool,
}

/// Payload emitted as `voice_error` event.
#[derive(Clone, Serialize)]
pub struct VoiceErrorEvent {
    pub message: String,
}

/// JSON output from the Swift helper process.
#[derive(Deserialize)]
struct HelperOutput {
    text: Option<String>,
    is_final: Option<bool>,
    error: Option<String>,
    available: Option<bool>,
    #[allow(dead_code)]
    authorized: Option<bool>,
}

/// State for managing the speech helper process.
pub struct SpeechState {
    child: Arc<Mutex<Option<Child>>>,
    /// Set true when the user explicitly stops (or the 3s safety-net fires) so
    /// the reader thread doesn't surface a clean/forced shutdown as an error.
    /// Reset to false on each `start()`. (#5668)
    stopping: Arc<AtomicBool>,
}

impl SpeechState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Resolve the path to the speech-helper binary.
fn helper_path() -> std::path::PathBuf {
    // In a bundled app, the helper is in the Resources directory
    let exe = std::env::current_exe().unwrap_or_default();
    let bundle_dir = exe
        .parent() // MacOS/
        .and_then(|p| p.parent()) // Contents/
        .map(|p| p.join("Resources").join("speech-helper"));

    if let Some(ref path) = bundle_dir {
        if path.exists() {
            return path.clone()
        }
    }

    // Dev mode: look next to the swift source
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let dev_path = manifest_dir.join("swift").join("speech-helper");
    if dev_path.exists() {
        return dev_path
    }

    // Fallback: assume it's on PATH
    "speech-helper".into()
}

/// Check if speech recognition is available on this system.
pub fn is_available() -> bool {
    let path = helper_path();
    let output = Command::new(&path)
        .arg("check")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    match output {
        Ok(out) => {
            if let Ok(parsed) = serde_json::from_slice::<HelperOutput>(&out.stdout) {
                parsed.available.unwrap_or(false)
            } else {
                false
            }
        }
        Err(_) => false,
    }
}

/// Whether an unexpected helper death should be surfaced to the user as a
/// `voice_error`. Stays silent on the clean-stop / forced-kill path
/// (`user_requested_stop`), when the helper already reported an error on stdout
/// (`emitted_error`), and on a successful exit (`exit_failed == false`). (#5668)
fn should_surface_failure(
    emitted_error: bool,
    user_requested_stop: bool,
    exit_failed: bool,
    has_stderr: bool,
) -> bool {
    // #6636: a non-zero exit with EMPTY stderr and no stdout error is
    // indistinguishable from a benign no-speech / idle timeout, and the old
    // "reinstall Chroxy" copy scared users during a normal silent Control-hold.
    // Require actual diagnostic output before surfacing a helper failure — a
    // genuine crash (panic, assert, missing dylib) writes to stderr, while
    // permission / availability failures come through the stdout error path and
    // the `check` command instead of here.
    !emitted_error && !user_requested_stop && exit_failed && has_stderr
}

/// Bounded wait for the stderr drain thread to finish (#6281): poll `reader_done`
/// until it flips or `deadline` passes. The deadline is the load-bearing
/// invariant — a helper that closes stdout while holding stderr open never flips
/// `reader_done`, so without the deadline the reader would park forever.
/// Extracted from the reader thread so the timeout can be regression-tested
/// deterministically (#6362).
fn wait_for_drain(reader_done: &AtomicBool, deadline: std::time::Instant) {
    while !reader_done.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
        thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// The 3s safety-net decision (#6282): nudge a hung helper with SIGTERM, but ONLY
/// when we can take the child lock (`try_lock` succeeds → the reader is not
/// mid-reap) AND the `Child` is still present (the reader hasn't reaped it yet).
///
/// The supplied `kill` closure runs **while the lock is still held** — that is the
/// load-bearing invariant: holding the lock guarantees the reader can't reap
/// concurrently, so the pid handed to `kill` is still ours and can never be a
/// recycled pid. Returns the pid that was signalled, or `None` when the safety net
/// correctly did nothing (`Err(_)` from `try_lock` → reader mid-reap; `None` child
/// → already reaped). Extracted so the gate can be regression-tested without
/// spawning the real helper (#6362).
fn run_safety_net<F: FnOnce(u32)>(child: &Mutex<Option<Child>>, kill: F) -> Option<u32> {
    match child.try_lock() {
        Ok(guard) => match guard.as_ref() {
            Some(c) => {
                let pid = c.id();
                // Fired under the held lock — pid cannot have been recycled.
                kill(pid);
                Some(pid)
            }
            // try_lock succeeded but the reader already reaped → nothing to do.
            None => None,
        },
        // try_lock failed → the reader holds the lock mid-reap → leave it alone.
        Err(_) => None,
    }
}

/// Start recording and recognizing speech. Streams results as Tauri events.
pub fn start(state: &SpeechState, app: &tauri::AppHandle) -> Result<(), String> {
    let mut child_lock = state.child.lock().unwrap();
    if child_lock.is_some() {
        return Err("Already recording".into())
    }

    let path = helper_path();
    let mut child = Command::new(&path)
        .arg("start")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // #5668 — capture stderr instead of discarding it. If the helper spawns
        // OK but then dies writing its failure reason to stderr (rather than as
        // an error-JSON on stdout), this is the only place that reason survives.
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start speech helper: {}", e))?;

    let stdout = child.stdout.take()
        .ok_or("Failed to capture speech helper stdout")?;
    let stderr = child.stderr.take()
        .ok_or("Failed to capture speech helper stderr")?;

    // Fresh session — this run hasn't been asked to stop yet.
    state.stopping.store(false, Ordering::SeqCst);

    *child_lock = Some(child);
    drop(child_lock);

    // Drain stderr on its own thread into a SHARED bounded tail buffer (#6281).
    // A dedicated drainer means a chatty/crashing helper never blocks on a full
    // pipe, and the failure reason is retained for the exit handler below (#5668).
    // The reader SNAPSHOTS this buffer instead of join()ing the drain thread, so a
    // helper that closes stdout while holding stderr open can't park the reader on
    // an unbounded join — the drain thread exits on its own at stderr EOF.
    let stderr_tail_buf: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
    let stderr_done = Arc::new(AtomicBool::new(false));
    let drain_buf = Arc::clone(&stderr_tail_buf);
    let drain_done = Arc::clone(&stderr_done);
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if l.is_empty() {
                        continue
                    }
                    if let Ok(mut tail) = drain_buf.lock() {
                        if tail.len() >= STDERR_TAIL_LINES {
                            tail.pop_front();
                        }
                        tail.push_back(l);
                    }
                }
                Err(_) => break,
            }
        }
        drain_done.store(true, Ordering::SeqCst);
    });

    // Spawn reader thread — clears child handle when helper exits
    let app_handle = app.clone();
    let child_ref = Arc::clone(&state.child);
    let stopping = Arc::clone(&state.stopping);
    let reader_tail = Arc::clone(&stderr_tail_buf);
    let reader_done = Arc::clone(&stderr_done);
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut emitted_error = false;
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };

            if line.is_empty() {
                continue
            }

            match serde_json::from_str::<HelperOutput>(&line) {
                Ok(output) => {
                    if let Some(error) = output.error {
                        // #6634: an stdout error arriving while we're stopping is
                        // the recognizer's cancellation racing the user's stop —
                        // benign, don't raise a banner. A genuine error during
                        // active recording (stopping == false) still forwards.
                        if stopping.load(Ordering::SeqCst) {
                            // benign cancellation race — swallow it
                        } else {
                            emitted_error = true;
                            let _ = app_handle.emit("voice_error", VoiceErrorEvent {
                                message: error,
                            });
                        }
                    } else if let Some(text) = output.text {
                        let is_final = output.is_final.unwrap_or(false);
                        let _ = app_handle.emit("voice_transcription", TranscriptionEvent {
                            text,
                            is_final,
                        });
                    }
                }
                Err(_) => {
                    // Ignore malformed lines
                }
            }
        }

        // Helper exited — reap the child process, capture its exit status, and
        // clear the handle.
        let exit_status = if let Ok(mut lock) = child_ref.lock() {
            let status = lock.as_mut().and_then(|child| child.wait().ok());
            *lock = None;
            status
        } else {
            None
        };

        // #6281: snapshot the drained stderr tail WITHOUT an unbounded join. The
        // child is reaped above, so its stderr write-end is closed and the drain
        // thread reaches EOF shortly — poll its `done` flag with a short deadline
        // (so a helper that closes stdout but holds stderr open can't park the
        // reader forever), then snapshot whatever was drained.
        let stderr_deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(500);
        wait_for_drain(&reader_done, stderr_deadline);
        let stderr_tail = reader_tail
            .lock()
            .map(|t| t.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();

        // #5668 — surface an *unexpected* death so it isn't a silent button
        // revert. Only when: the helper exited on its own (not via stop() and
        // not the 3s safety-net SIGTERM), with a failure status, and it didn't
        // already report an error on stdout. This deliberately stays silent on
        // the clean-stop and forced-kill paths to avoid false positives.
        let user_requested_stop = stopping.load(Ordering::SeqCst);
        let failed = exit_status.map(|s| !s.success()).unwrap_or(false);
        // #6636: only surface a helper failure when there's real stderr
        // diagnostics — an empty-stderr non-zero exit is the benign no-speech /
        // idle-timeout path and must stay quiet (the `voice_stopped` event below
        // still reverts the mic). Genuine crashes carry a stderr reason.
        if should_surface_failure(emitted_error, user_requested_stop, failed, !stderr_tail.is_empty()) {
            let _ = app_handle.emit("voice_error", VoiceErrorEvent {
                message: format!("Voice helper failed: {}", stderr_tail),
            });
        }

        let _ = app_handle.emit("voice_stopped", ());
    });

    Ok(())
}

/// Stop recording and finalize recognition.
pub fn stop(state: &SpeechState) {
    // Mark this as an intentional stop so the reader thread treats the
    // resulting exit (clean, or a 3s safety-net SIGTERM) as expected and does
    // not surface it as a voice_error. (#5668)
    state.stopping.store(true, Ordering::SeqCst);
    let mut child_lock = state.child.lock().unwrap();
    if let Some(ref mut child) = *child_lock {
        // Send "stop" to the helper's stdin — triggers clean shutdown
        if let Some(ref mut stdin) = child.stdin {
            let _ = stdin.write_all(b"stop\n");
            let _ = stdin.flush();
        }
        // Drop stdin to signal EOF as a fallback
        child.stdin.take();

        // Wait briefly for clean exit, then nudge with SIGTERM if still hung.
        match child.try_wait() {
            Ok(Some(_)) => {
                // Already exited — reaped here under the lock; clear the handle.
                *child_lock = None;
            }
            _ => {
                // Still running — the reader thread's child.wait() will reap it
                // after the helper responds to "stop" (or sees stdin EOF). Leave
                // child_lock populated; the reader clears it.
                drop(child_lock);

                // Safety net (#6282): 3s after a clean stop, if the reader STILL
                // hasn't reaped the helper, nudge it with SIGTERM — but do NOT
                // waitpid here. The reader's child.wait() is the SOLE reaper, so
                // there is no double-reap; and we only signal while holding the
                // child Mutex with the Child still present, which guarantees the
                // reader hasn't reaped it (the pid is still ours, never a recycled
                // one). A hung helper keeps stdout open, so the reader is parked in
                // reader.lines() with the Mutex FREE → try_lock succeeds and the
                // SIGTERM fires (#4986: surface the hang loudly rather than hide
                // behind a silent kill); a reader already mid-wait() holds the lock
                // → try_lock fails and we correctly leave the in-progress reap alone.
                let child_ref = Arc::clone(&state.child);
                thread::spawn(move || {
                    thread::sleep(std::time::Duration::from_secs(3));
                    // run_safety_net fires the closure only while it holds the
                    // child lock with the Child present, so the SIGTERM below
                    // targets a pid that cannot have been recycled (#6282).
                    run_safety_net(&child_ref, |pid| {
                        eprintln!(
                            "[speech] WARN: helper (pid {}) did not exit within 3s of clean shutdown; sending SIGTERM. \
This usually means the helper crashed or hung — voice transcription may have silently failed for this session.",
                            pid
                        );
                        unsafe {
                            libc::kill(pid as i32, libc::SIGTERM);
                        }
                    });
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{run_safety_net, should_surface_failure, wait_for_drain};
    use std::process::{Child, Command};
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    #[test]
    fn surfaces_unexpected_failure() {
        // Helper died on its own with a failure status, no prior error, AND left
        // a stderr reason — a genuine crash worth surfacing.
        assert!(should_surface_failure(false, false, true, true));
    }

    #[test]
    fn silent_on_empty_stderr_failure() {
        // #6636: a non-zero exit with NO stderr diagnostics is the benign
        // no-speech / idle-timeout path — must stay quiet (no scary reinstall
        // banner during a normal silent Control-hold).
        assert!(!should_surface_failure(false, false, true, false));
    }

    #[test]
    fn silent_on_user_requested_stop() {
        // A clean stop (or the 3s safety-net SIGTERM) must never raise an error,
        // even though the forced exit reports as a failure with stderr.
        assert!(!should_surface_failure(false, true, true, true));
    }

    #[test]
    fn silent_when_error_already_emitted() {
        // The helper already reported its error on stdout — don't double-report.
        assert!(!should_surface_failure(true, false, true, true));
    }

    #[test]
    fn silent_on_clean_exit() {
        // Exited successfully on its own — nothing to surface.
        assert!(!should_surface_failure(false, false, false, true));
    }

    // #6362 — stderr-drain deadline (#6281). The reader must never park forever
    // waiting on the drain thread; the deadline bounds the wait.

    #[test]
    fn drain_wait_returns_at_deadline_when_reader_never_finishes() {
        // reader_done never flips (stdout-closed/stderr-open case) → the loop must
        // exit when the deadline passes, not hang.
        let never = AtomicBool::new(false);
        let start = Instant::now();
        wait_for_drain(&never, start + Duration::from_millis(150));
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_millis(150), "returned before the deadline: {:?}", elapsed);
        assert!(elapsed < Duration::from_millis(600), "overran the deadline: {:?}", elapsed);
    }

    #[test]
    fn drain_wait_returns_promptly_when_reader_done() {
        // Already drained → return immediately, far short of a 30s deadline.
        let done = AtomicBool::new(true);
        let start = Instant::now();
        wait_for_drain(&done, start + Duration::from_secs(30));
        assert!(start.elapsed() < Duration::from_millis(100), "should return immediately when already done");
    }

    // #6362 — single-owner reaping safety net (#6282). The 3s SIGTERM fires ONLY
    // when the lock is takeable AND the Child is present, and always under the
    // held lock (so the pid can't be recycled).

    #[test]
    fn safety_net_skips_while_reader_holds_lock() {
        // Reader mid-reap = lock held → try_lock fails → leave the in-progress
        // reap alone, never signal.
        let child: Mutex<Option<Child>> = Mutex::new(None);
        let _held = child.lock().unwrap(); // simulate the reader holding the lock
        let mut killed = false;
        let pid = run_safety_net(&child, |_p| killed = true);
        assert_eq!(pid, None);
        assert!(!killed, "must NOT signal while the reader holds the lock (recycled-pid race)");
    }

    #[test]
    fn safety_net_skips_when_child_already_reaped() {
        // try_lock succeeds but the Child is None (reader already reaped) → no-op.
        let child: Mutex<Option<Child>> = Mutex::new(None);
        let mut killed = false;
        let pid = run_safety_net(&child, |_p| killed = true);
        assert_eq!(pid, None);
        assert!(!killed, "must NOT signal when the child was already reaped");
    }

    #[test]
    fn safety_net_signals_live_child_pid_under_lock() {
        // try_lock succeeds AND the Child is present → the closure fires exactly
        // once with the live child's pid. A real benign long-lived process gives a
        // real pid; the injected closure records it instead of signalling, and we
        // reap the helper ourselves afterwards.
        let sleeper = Command::new("sleep").arg("30").spawn().expect("spawn sleep helper");
        let expected_pid = sleeper.id();
        let child: Mutex<Option<Child>> = Mutex::new(Some(sleeper));

        let mut calls = 0;
        let mut seen_pid = None;
        let pid = run_safety_net(&child, |p| {
            calls += 1;
            seen_pid = Some(p);
        });

        assert_eq!(pid, Some(expected_pid));
        assert_eq!(calls, 1, "safety net must fire exactly once");
        assert_eq!(seen_pid, Some(expected_pid), "kill must receive the live child's pid");

        // Clean up the real process we spawned. Bind the take() into its own
        // statement so the temporary MutexGuard drops before `child` does.
        let leftover = child.lock().unwrap().take();
        if let Some(mut c) = leftover {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
