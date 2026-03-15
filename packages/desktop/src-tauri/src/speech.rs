//! macOS speech recognition via a bundled Swift helper process.
//!
//! Provides Tauri commands for streaming voice-to-text input.
//! Uses Apple's SFSpeechRecognizer — no API keys, works offline.
//!
//! Architecture: Rust spawns `speech-helper` (compiled Swift binary) as a
//! child process. The helper streams JSON lines to stdout for each partial
//! and final transcription. Sending "stop\n" to its stdin ends recording.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

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
}

impl SpeechState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
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
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start speech helper: {}", e))?;

    let stdout = child.stdout.take()
        .ok_or("Failed to capture speech helper stdout")?;

    *child_lock = Some(child);
    drop(child_lock);

    // Spawn reader thread — clears child handle when helper exits
    let app_handle = app.clone();
    let child_ref = Arc::clone(&state.child);
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
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

        // Helper exited — reap the child process and clear the handle
        if let Ok(mut lock) = child_ref.lock() {
            if let Some(ref mut child) = *lock {
                let _ = child.wait();
            }
            *lock = None;
        }

        let _ = app_handle.emit("voice_stopped", ());
    });

    Ok(())
}

/// Stop recording and finalize recognition.
pub fn stop(state: &SpeechState) {
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
                            libc::kill(pid as i32, libc::SIGTERM);
                        }
                    }
                });
            }
        }
    }
}
