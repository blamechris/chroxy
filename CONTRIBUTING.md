# Contributing to Chroxy

Thanks for your interest in contributing! This document covers how to get started.

## What to expect

- All changes go through a PR; `main` is protected.
- CI runs lint, type-check, and tests across the `server`, `dashboard`, `app`, `store-core`, and `protocol` packages — these must pass before merge.
- We squash-merge to keep history linear.
- Be patient on review turnaround — this is a solo-maintained project.
- For non-trivial changes, open an issue first so we can agree on the approach before you spend time on it.

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

5. **Connect from your phone** — The app requires a custom dev build (not Expo Go) due to native modules. See `packages/app/README.md` for build instructions.

## Project Structure

- `packages/server` — Node.js daemon (CLI headless mode) with WebSocket API and web dashboard
- `packages/app` — React Native app (TypeScript, Expo 54) with chat view, xterm.js terminal, voice input, and plan mode UI
- `packages/desktop` — Tauri tray app (Rust + web dashboard) with voice-to-text and system integration
- `packages/protocol` — Shared WebSocket protocol types and Zod schemas (`@chroxy/protocol`)
- `packages/store-core` — Shared store logic and crypto utilities (`@chroxy/store-core`)
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
- Better error messages and edge case handling

### Medium
- App-side test suite (component rendering, store logic)
- Settings page improvements
- Maestro E2E test flows for new features

### Larger Projects
- Session recording and replay
- Tailscale support as tunnel alternative
- Additional session providers via the provider adapter interface

## Questions?

Open an issue or start a discussion. We're friendly!

## Stale PR policy

To keep the PR queue manageable, external contributions follow an automated stale policy:

- **7 days** without contributor activity (commits, comments, or pushes) — a friendly reminder comment is posted and the PR is labeled `stale`.
- **14 days** without contributor activity (7 days after the reminder) — the PR is closed with a "feel free to reopen" message.

PRs from the repo owner are exempt. Issues are not affected by this policy.

### How to keep your PR open

Just comment on the PR (anything works — a status update, a question, or a "still working on this") to reset the timer. Pushing new commits also counts as activity.

If your PR is closed and you come back to it later, you can reopen it directly on GitHub — no need to file a new one.

The policy is automated via [`.github/workflows/stale.yml`](.github/workflows/stale.yml).
