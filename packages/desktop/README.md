# @chroxy/desktop

The Tauri desktop tray app — a native macOS/Windows/Linux shell (Rust) that wraps
the web [dashboard](../dashboard) and adds a system-tray menu, desktop
notifications, voice-to-text (macOS `SFSpeechRecognizer`), and a LAN client that
can discover and connect to Chroxy daemons on your network.

## Stack

Tauri v2 (Rust `src-tauri/`) + the bundled dashboard web UI. Requires the Rust
toolchain and `tauri-cli`.

## Scripts

```bash
npm run dev    -w packages/desktop   # cargo tauri dev  (hot-reloads the wrapped dashboard)
npm run build  -w packages/desktop   # cargo tauri build  (produces the .app / installer)
npm run check  -w packages/desktop   # cargo check (Rust type-check, no build)
```

## Notes

- **Prereqs:** `rustup` + `cargo install tauri-cli`. `cargo tauri build` needs
  `--bundles app` on tauri-cli ≥ 2.10 to produce the `.app` bundle.
- **Runs under launchd** — its working directory is `/`, so resource paths use
  `import.meta.url`, never `process.cwd()`.
- **Client mode:** the desktop app can either auto-start its own bundled server
  or attach to an already-running daemon (e.g. the dev daemon on `:8765`) as a
  LAN client — pick a server from the picker / mDNS discovery.
- Signing/notarization and release wiring live in `docs/release-signing.md`.
