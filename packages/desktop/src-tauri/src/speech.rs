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
fn should_surface_failure(emitted_error: bool, user_requested_stop: bool, exit_failed: bool) -> bool {
    !emitted_error && !user_requested_stop && exit_failed
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

    // Drain stderr on its own thread into a bounded tail buffer. A dedicated
    // drainer means a chatty/crashing helper never blocks on a full pipe, and
    // the failure reason is retained for the exit handler below. (#5668)
    let stderr_handle = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut tail: VecDeque<String> = VecDeque::with_capacity(STDERR_TAIL_LINES);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if l.is_empty() {
                        continue
                    }
                    if tail.len() >= STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(l);
                }
                Err(_) => break,
            }
        }
        tail.into_iter().collect::<Vec<_>>().join("\n")
    });

    // Spawn reader thread — clears child handle when helper exits
    let app_handle = app.clone();
    let child_ref = Arc::clone(&state.child);
    let stopping = Arc::clone(&state.stopping);
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
                        emitted_error = true;
                        let _ = app_handle.emit("voice_error", VoiceErrorEvent {
                            message: error,
                        });
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

        // Collect whatever the helper wrote to stderr before exiting.
        let stderr_tail = stderr_handle.join().unwrap_or_default();

        // #5668 — surface an *unexpected* death so it isn't a silent button
        // revert. Only when: the helper exited on its own (not via stop() and
        // not the 3s safety-net SIGTERM), with a failure status, and it didn't
        // already report an error on stdout. This deliberately stays silent on
        // the clean-stop and forced-kill paths to avoid false positives.
        let user_requested_stop = stopping.load(Ordering::SeqCst);
        let failed = exit_status.map(|s| !s.success()).unwrap_or(false);
        if should_surface_failure(emitted_error, user_requested_stop, failed) {
            let message = if stderr_tail.is_empty() {
                "Voice helper exited unexpectedly. Speech recognition may be unavailable — try reinstalling Chroxy."
                    .to_string()
            } else {
                format!("Voice helper failed: {}", stderr_tail)
            };
            let _ = app_handle.emit("voice_error", VoiceErrorEvent { message });
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

        // Wait briefly for clean exit, then force kill if needed
        let pid = child.id();
        match child.try_wait() {
            Ok(Some(_)) => {
                // Already exited
                *child_lock = None;
            }
            _ => {
                // Still running — the reader thread will reap it after the
                // helper responds to the "stop" command. If it hangs,
                // the reader thread will see EOF when we drop stdin above.
                // Leave child_lock populated — reader thread clears it.
                drop(child_lock);

                // Safety net: kill after 3 seconds if still alive
                thread::spawn(move || {
                    thread::sleep(std::time::Duration::from_secs(3));
                    // Check if the process is still around before killing.
                    // waitpid with WNOHANG: 0 = still running
                    unsafe {
                        let status = libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG);
                        if status == 0 {
                            // #4986 — the helper ignored the clean "stop\n"
                            // signal AND the EOF on stdin. Log loudly so
                            // future regressions like #4985 (where the
                            // helper was silently SIGTERM'd every session
                            // since 0.8.x and voice never actually
                            // transcribed) surface instead of hiding behind
                            // a "graceful" kill. The no-op branch (process
                            // already exited cleanly) stays silent.
                            eprintln!(
                                "[speech] WARN: helper (pid {}) did not exit within 3s of clean shutdown; sending SIGTERM. \
This usually means the helper crashed or hung — voice transcription may have silently failed for this session.",
                                pid
                            );
                            libc::kill(pid as i32, libc::SIGTERM);
                        }
                    }
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::should_surface_failure;

    #[test]
    fn surfaces_unexpected_failure() {
        // Helper died on its own with a failure status and no prior error.
        assert!(should_surface_failure(false, false, true));
    }

    #[test]
    fn silent_on_user_requested_stop() {
        // A clean stop (or the 3s safety-net SIGTERM) must never raise an error,
        // even though the forced exit reports as a failure.
        assert!(!should_surface_failure(false, true, true));
    }

    #[test]
    fn silent_when_error_already_emitted() {
        // The helper already reported its error on stdout — don't double-report.
        assert!(!should_surface_failure(true, false, true));
    }

    #[test]
    fn silent_on_clean_exit() {
        // Exited successfully on its own — nothing to surface.
        assert!(!should_surface_failure(false, false, false));
    }
}
