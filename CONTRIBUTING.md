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

3. **Set up the server**
   ```bash
   cd packages/server
   cp .env.example .env
   # Edit .env and generate an API token
   npm run dev
   ```

4. **Run the app** (in another terminal)
   ```bash
   cd packages/app
   npm run ios  # or android
   ```

## Project Structure

- `packages/server` — Node.js daemon with dual modes (CLI headless default, PTY/tmux opt-in) that exposes WebSocket API
- `packages/app` — React Native app with QR scanning, chat view with markdown rendering, and terminal view
- `docs/` — Architecture docs and guides
- `scripts/` — Helper scripts

## Making Changes

1. Create a branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Test both server and app
4. Commit with a clear message
5. Push and open a PR

## Code Style

- **TypeScript** for the app, **JavaScript (ES modules)** for the server
- Server: no semicolons, single quotes (ES modules, plain JavaScript)
- App: TypeScript strict, functional components, Zustand for state
- Meaningful variable names over comments
- Keep functions small and focused
- App state management: Zustand store
- Server: EventEmitter pattern for component communication

## Areas to Contribute

### Easy Wins
- Improve output parser patterns (`packages/server/src/output-parser.js`)
- Add more special key buttons to terminal view
- UI polish and animations
- Syntax highlighting for code blocks in chat

### Medium
- Enhanced markdown rendering features
- Better error handling and recovery
- Session history and search

### Larger Projects
- Proper xterm.js integration for terminal view (replace plain text display)
- Push notifications for long-running tasks
- Session recording and replay

## Questions?

Open an issue or start a discussion. We're friendly!
