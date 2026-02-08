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

- `packages/server` — Node.js daemon that manages tmux/PTY and exposes WebSocket API
- `packages/app` — React Native app with chat and terminal views
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
- No semicolons (we use Prettier defaults)
- Meaningful variable names over comments
- Keep functions small and focused

## Areas to Contribute

### Easy Wins
- Improve output parser patterns (`packages/server/src/output-parser.js`)
- Add more special key buttons to terminal view
- UI polish and animations

### Medium
- Implement QR code scanning
- Add markdown rendering for chat messages
- Syntax highlighting for diffs

### Larger Projects
- Proper xterm.js integration for terminal view
- Session recording and replay

## Questions?

Open an issue or start a discussion. We're friendly!
