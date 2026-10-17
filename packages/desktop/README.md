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

## Isolated native notification smoke

The fixture below exposes a tiny loopback page with a reachable native trigger.
It does not start the Chroxy daemon or send any provider input. It generates its
own token, config and desktop settings in a private absolute temporary directory;
never copy production config or credentials into that directory. Use Node 22:

```bash
/opt/homebrew/opt/node@22/bin/node packages/desktop/scripts/native-notification-smoke.mjs serve
```

The JSON output contains only `root`, `port`, `pid` and `lifetimeSeconds`. The
fixture binds `127.0.0.1` on an ephemeral port, refuses common production ports,
and stops after ten minutes or SIGTERM/SIGINT. Keep its PID for cleanup. The root
contains private `config.json`, `desktop-settings.json`, `control.json` and
`receipt.json`; do not publish those files or a dashboard URL containing a token.
The settings disable auto-start and enable notifications, with no tunnel or LAN
exposure. `encryptLocalhost` remains enabled.

Launch an isolated copy of the native application binary with
`CHROXY_CONFIG_DIR` set to the printed root, `CHROXY_DISABLE_KEYCHAIN=1` and
`CHROXY_CRED_DISABLE_KEYCHAIN=1`. Choose the binary deliberately: this command
does not launch or stop an app, mutate production state, or change OS notification
permissions. The native app's existing health challenge adopts this fixture and
loads `/dashboard`; no dashboard WebSocket/store/provider is used. The fixture
serves external same-origin JavaScript for compatibility with the native CSP.

Read `receipt.json` locally and wait for `READY`. This requires successful native
IPC via Tauri v2's injected bridge (`get_server_info`); the probe response is
never recorded. Ordinary browser loading explicitly fails. Move the application
to the background if checking background delivery, then arm once:

```bash
/opt/homebrew/opt/node@22/bin/node packages/desktop/scripts/native-notification-smoke.mjs arm /absolute/printed/root
```

Arming before readiness or a second time fails. The page claims a single durable
admission before invoking the existing `send_session_notification` command once,
using the fixed title **Chroxy isolated smoke** and body **Native notification
delivery check**, without a session ID. Reloading or another poll cannot replay
it. Missing bridge, rejected/expired IPC, a false native-route response and a
missing receipt produce `FAILED`.

`SUBMITTED` means the native command acknowledged the macOS native route. It is
**not an OS-delivery pass**: `osDelivery` remains `UNVERIFIED`. Observe and record
the actual OS notification card separately, including whether the app was in the
foreground/background and whether its notification permission was enabled. Stop
only this fixture PID and the owned application copy afterward; retain private
receipts only as needed, then remove the generated root. No notification is
armed by starting the fixture alone.

Executable fixture/client coverage runs in the server CI test inventory:

```bash
cd packages/server
/opt/homebrew/opt/node@22/bin/node --import ./tests/_setup.mjs --experimental-test-module-mocks --test tests/native-notification-smoke.test.js
```
