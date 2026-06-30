# Agent Instructions

Canonical instructions for coding agents working in this repository. Agent-specific files should point here instead of duplicating these notes.

## Project Snapshot

Chroxy is a monorepo for a remote terminal/chat UI around Claude Code, Gemini, Codex, and related providers.

- `packages/server`: Node.js daemon and CLI, ES modules, plain JavaScript.
- `packages/dashboard`: React/Vite web dashboard served by the server.
- `packages/app`: React Native/Expo mobile app, TypeScript.
- `packages/desktop`: Tauri desktop wrapper.
- `packages/protocol`: shared protocol types and Zod schemas.
- `packages/store-core`: shared store logic and crypto.
- `packages/claude-hooks`: hooks for external Claude Code sessions.

Use Node.js 22+ for server and package commands.

## First Steps

1. Read this file.
2. Run `git status -sb` before editing.
3. Inspect the relevant code before changing it.
4. Keep unrelated dirty worktree changes intact.
5. Prefer focused tests that cover the touched code.

## Git Rules

- Never commit directly to `main`.
- Work on a feature branch and open a PR.
- Stage only files that belong to the task.
- Do not revert or overwrite unrelated local changes.
- Do not merge a PR without explicit user approval unless a separate autonomous workflow explicitly grants that authority.

Commit messages should be clean and professional. Do not add AI attribution, co-author trailers, generated-by text, or vendor/tool branding.

## Code Style

- Server code uses ES modules, plain JavaScript, single quotes, and no semicolons.
- Dashboard and mobile code use TypeScript/React conventions already present in the package.
- Prefer existing helpers, patterns, and package boundaries.
- Keep changes scoped. Avoid broad refactors unless they are required for the task.
- Add comments only when they clarify non-obvious behavior.

## Testing

Use the smallest reliable test set that proves the change.

Common server checks:

```bash
node --import ./packages/server/tests/_setup.mjs --test ./packages/server/tests/<test-file>.js
```

Some server tests using module mocks need:

```bash
node --import ./packages/server/tests/_setup.mjs --experimental-test-module-mocks --test ./packages/server/tests/<test-file>.js
```

For `@chroxy/store-core` crypto changes:

```bash
npm run build:crypto -w @chroxy/store-core
```

Tests must not write to real user state. Server tests should use `packages/server/tests/_setup.mjs`, which guards against writes to the real `~/.chroxy/` and `~/.claude/` trees.

## Security Notes

- Treat API tokens, hook secrets, pairing tokens, tunnel URLs with embedded credentials, and provider keys as secrets.
- Do not print or commit raw tokens.
- Before changing auth, pairing, or privileged HTTP routes, read:
  - `docs/security/bearer-token-authority.md`
  - `docs/security/encryption-threat-model.md`

## Provider And Session Notes

Provider session classes must forward all base session options. Prefer the existing `buildBaseSessionOpts` pattern over hand-maintained option lists.

When adding a new `BaseSession` option, update both the constructor destructure and `BASE_SESSION_OPT_KEYS` in the same change.

## Windows Notes

Chroxy should run on Windows PowerShell with Node 22+.

- Use `where.exe` semantics for PATH lookup on Windows, not POSIX-only `which`.
- Account for `PATHEXT` when resolving extensionless executable candidates.
- Avoid POSIX-only path containment checks; use `path.relative` or equivalent.
- Do not assume POSIX chmod mode bits behave the same way on Windows.

## Documentation

When setup behavior changes, update `README.md` or the relevant `docs/` page in the same PR. Keep onboarding docs copy-pastable for macOS, Windows, and Linux where applicable.

