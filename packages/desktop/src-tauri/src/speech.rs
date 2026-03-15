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
use std::sync::Mutex;
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
    authorized: Option<bool>,
}

/// State for managing the speech helper process.
pub struct SpeechState {
    child: Mutex<Option<Child>>,
}

unsafe impl Send for SpeechState {}
unsafe impl Sync for SpeechState {}

impl SpeechState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    pub fn is_recording(&self) -> bool {
        self.child.lock().unwrap().is_some()
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

    // Spawn reader thread to emit Tauri events from helper output
    let app_handle = app.clone();
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

        // Helper exited — emit a final empty transcription to signal end
        let _ = app_handle.emit("voice_stopped", ());
    });

    Ok(())
}

/// Stop recording and finalize recognition.
pub fn stop(state: &SpeechState) {
    let mut child_lock = state.child.lock().unwrap();
    if let Some(ref mut child) = *child_lock {
        // Send "stop" to the helper's stdin
        if let Some(ref mut stdin) = child.stdin {
            let _ = stdin.write_all(b"stop\n");
            let _ = stdin.flush();
        }

        // Give it a moment to clean up, then kill if needed
        let child_id = child.id();
        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_secs(2));
            // Kill if still running
            unsafe {
                libc::kill(child_id as i32, libc::SIGTERM);
            }
        });
    }
    *child_lock = None;
}
