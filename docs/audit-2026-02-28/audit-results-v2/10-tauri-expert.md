# Tauri Expert's Audit: Desktop Architecture Audit

**Agent**: Tauri Expert -- Domain expert in Tauri framework, Rust systems programming, and desktop app architecture
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

| Section | Rating | Key Issue |
|---------|--------|-----------|
| Message Synchronization | 3/5 | "Skip JSON serialization" is impossible in Tauri; "shared memory" doesn't exist |
| Repository & Session Mgmt | 4/5 | Accurate; needs Tauri commands before "desktop owns lifecycle" is feasible |
| Tunnel Implementation | 4/5 | Recommendations feasible; correct pattern is `app.emit()` events, not commands |
| WebSocket Layer | 3/5 | Binary serialization doesn't help Rust-to-WebView leg (still JSON) |
| Data Flow Diagram | 4/5 | Accurate depiction of current architecture |
| Proposed Protocol | 2/5 | Two fundamental technical errors about Tauri capabilities |
| Appendix | 5/5 | Highly accurate inventory of existing Rust code |

## Top 5 Findings

### 1. "Skip JSON Serialization" Is Impossible in Tauri IPC (HIGH)
Tauri 2's `invoke()` and `emit()` both use JSON via `serde_json`. Every value crossing the WebView-Rust boundary is JSON-serialized. `Vec<u8>` becomes base64 (33% overhead). There is no raw byte channel. The performance benefit of IPC over WebSocket is real but overstated.

### 2. "Direct Memory Sharing" Does Not Exist in Tauri (HIGH)
WebView runs in a separate OS process (WKWebView on macOS). No shared memory mechanism exists. No `tauri-plugin-ipc` for this. Closest alternatives: custom protocol handlers, temp files, or base64 over IPC.

### 3. Zero `#[tauri::command]` Handlers -- Everything Must Be Built
Confirmed: no command definitions in the entire codebase. `withGlobalTauri: false` in `tauri.conf.json`. The app uses only tray menu events and `win.eval()`. Every proposed feature requires the command/event bridge built from scratch.

### 4. Document Never Mentions Tauri Events (Missing Key Primitive)
For streaming data (deltas at 20/sec), the correct Tauri pattern is `app.emit()` events, not `invoke()` commands. Commands are request-response. Events are fire-and-forget push. The document treats the command bridge as a generic high-performance channel without understanding the distinction.

### 5. Current Rust Code Uses Anti-Patterns (LOW severity)
- `win.eval()` for Rust-to-frontend communication (`window.rs:85`) -- should be `app.emit()` events
- Nested `Arc<Mutex<T>>` (status, log_buffer, health_running inside Mutex'd ServerManager) -- deadlock risk
- `std::thread` for background polling when Tauri 2 provides async runtime via tokio
- `lock_or_recover` masks mutex poisoning bugs

## Feasibility Assessment

| Feature | Feasible? | Correct Pattern | Effort |
|---------|-----------|----------------|--------|
| IPC bypass of WebSocket | Yes (with caveats) | Rust reads Node stdout, emits events; frontend invokes commands | Medium-High |
| Skip JSON serialization | **No** | N/A | N/A |
| Direct memory sharing | **No** | Temp files + custom protocol | N/A |
| React frontend with Vite | Yes | Standard Vite + `@tauri-apps/api` setup | Low-Medium |
| Tunnel status in UI | Yes | `app.emit("tunnel-status", ...)` | Low |
| Session orchestration | Yes | Commands for CRUD, events for state | Medium-High |

## Missing Plugins That Would Help

| Plugin | Purpose | Current Workaround |
|--------|---------|-------------------|
| `tauri-plugin-store` | Structured key-value settings | Manual `fs::write()` in settings.rs |
| `tauri-plugin-log` | Structured logging | `eprintln!()` lost in production |
| `tauri-plugin-process` | App relaunch | Manual process management |
| `tauri-plugin-dialog` | File pickers | Not available |

## Verdict
Good server-side analysis, but Tauri-specific proposals contain two fundamental technical errors (no JSON-free IPC, no shared memory) and miss the key distinction between commands (request-response) and events (streaming push). The existing Rust code is well-structured for a tray app. Next steps: (1) add command/event bridge, (2) set up Vite + React, (3) replace `win.eval()` with events, (4) wire tunnel status via `app.emit()`.
