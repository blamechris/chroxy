# Chroxy

> Remote terminal for Claude Code from your phone.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

Run a lightweight daemon on your dev machine. Connect from anywhere via your phone. Get both a full terminal view and a clean chat-like UI that parses Claude Code's output into readable messages.

```
┌─────────────┐                        ┌──────────────────┐
│  📱 Phone   │◄───── secure tunnel ──►│  💻 Your Mac     │
│             │                        │                  │
│ ┌─────────┐ │                        │ ┌──────────────┐ │
│ │Chat View│ │◄── parsed messages ────│ │ Chroxy Server│ │
│ └─────────┘ │                        │ └──────┬───────┘ │
│ ┌─────────┐ │                        │ ┌──────┴───────┐ │
│ │Terminal │ │◄── raw PTY stream ─────│ │tmux + Claude │ │
│ └─────────┘ │                        │ │    Code      │ │
└─────────────┘                        └──────────────────┘
```

## Why Chroxy?

- **Persistent sessions** — Your Claude Code session lives in tmux. Disconnect and reconnect anytime.
- **Two views, one session** — Swipe between a clean chat UI and raw terminal access.
- **Privacy-first** — Your machine, your tunnel. No cloud middleman storing your code.
- **Open source** — MIT licensed. Audit it, fork it, improve it.

## Quick Start

### Server (on your Mac)

```bash
# Install and configure
npx chroxy init

# Start the server
npx chroxy start
```

The server prints a QR code. Scan it with the Chroxy app.

### App (on your phone)

Download from [TestFlight](#) (iOS) or [Play Store](#) (Android).

Or build from source:
```bash
cd packages/app
npm install
npm run ios   # or npm run android
```

## How It Works

1. **Server** spawns (or attaches to) a tmux session running Claude Code
2. **Output parser** converts terminal output into structured messages
3. **WebSocket server** streams both raw and parsed output to connected clients
4. **ngrok tunnel** provides secure remote access without port forwarding
5. **Mobile app** renders the dual-view UI and sends your input back

## Project Structure

```
chroxy/
├── packages/
│   ├── server/     # Node.js daemon + CLI
│   └── app/        # React Native mobile app
├── docs/           # Setup guides, architecture
└── scripts/        # Install helpers
```

## Development

```bash
# Clone the repo
git clone https://github.com/blamechris/chroxy.git
cd chroxy

# Install all dependencies
npm install

# Run the server in dev mode
npm run server:dev

# Run the app (in another terminal)
npm run app:ios
```

## Roadmap

- [x] Core server daemon with PTY management
- [x] Output parser for Claude Code patterns
- [x] WebSocket protocol with auth
- [x] ngrok tunnel integration
- [ ] CLI with `init` and `start` commands
- [ ] QR code generation for easy app pairing
- [ ] React Native app shell
- [ ] Terminal view with xterm.js
- [ ] Chat view with parsed messages
- [ ] Scrollback buffer on reconnect
- [ ] TestFlight / Play Store release
- [ ] Tailscale support as ngrok alternative
- [ ] Session recording and replay

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.

## License

MIT © [blamechris](https://github.com/blamechris)
