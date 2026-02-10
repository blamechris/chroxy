# Contributing to Chroxy

Thanks for your interest in contributing! This document covers how to get started.

## Development Setup

1. **Fork and clone the repo**
   ```bash
   git clone https://github.com/YOUR-USERNAME/chroxy.git
   cd chroxy
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server** (Terminal 1)
   ```bash
   PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
   ```

4. **Start the app dev server** (Terminal 2)
   ```bash
   cd packages/app
   npx expo start
   ```

5. **Connect from your phone** — Open Expo Go, scan the Expo QR code, then scan the Chroxy server QR code inside the app.

## Project Structure

- `packages/server` — Node.js daemon with dual modes (CLI headless default, PTY/tmux opt-in) that exposes WebSocket API
- `packages/app` — React Native app with QR scanning, chat view with markdown rendering, and terminal view
- `docs/` — Architecture docs and guides
- `scripts/` — Helper scripts

## Making Changes

1. Create a branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Run server tests: `cd packages/server && PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test`
4. Run app type check: `cd packages/app && npx tsc --noEmit`
5. Commit with a clear message
6. Push and open a PR

## Code Style

- **TypeScript** for the app, **JavaScript (ES modules)** for the server
- Server: no semicolons, single quotes, plain JavaScript ES modules
- App: TypeScript strict, functional components, Zustand for state
- Meaningful variable names over comments
- Keep functions small and focused
- App state management: Zustand store
- Server: EventEmitter pattern for component communication

## Areas to Contribute

### Easy Wins
- UI polish and animations
- Improve output parser patterns (`packages/server/src/output-parser.js`) for PTY mode
- Better error messages and edge case handling
- Syntax highlighting for code blocks in chat

### Medium
- App-side test suite (component rendering, store logic)
- Plan mode UI (display Claude's plan steps)
- Settings page improvements

### Larger Projects
- xterm.js integration for terminal view (replace plain text display)
- Session recording and replay
- Tailscale support as tunnel alternative

## Questions?

Open an issue or start a discussion. We're friendly!
