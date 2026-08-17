# @chroxy/claude-hooks

Stateless Claude Code hook emitters for chroxy's event ingest (`POST /api/events`, #5413 Phase 4).

Each registered hook reads its stdin payload, builds the normalized envelope
`{ source, project, sessionId?, type, data, ts }` (validated server-side against
`IngestEventSchema` in `@chroxy/protocol`), POSTs it to the local chroxy daemon with the
ingest secret as a bearer token, and exits 0 — always. Fail-fast and fail-silent: if the
daemon is down the hook is a sub-100ms no-op. No state, no spool, no fallback path.

## Install

```bash
node packages/claude-hooks/bin/chroxy-hooks.js install
```

Registers `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `Notification`
(`idle_prompt` + `permission_prompt` matchers), `PostToolUse`, `UserPromptSubmit`, and
`Stop` hooks in `~/.claude/settings.json`. The registered command embeds the absolute node
binary and script path, so hooks don't depend on the hook environment's PATH and skip npx
resolution.

- **Idempotent** — safe to re-run; converges to exactly one entry per event and migrates
  entries from a previous checkout path.
- **Surgical** — never touches hooks it didn't add; an unparseable `settings.json` aborts
  the install instead of being overwritten.

```bash
node packages/claude-hooks/bin/chroxy-hooks.js uninstall   # removes ONLY chroxy-hooks entries
```

## Configuration

Everything resolves automatically from the chroxy daemon's config; env vars override:

| Env var | Default |
|---|---|
| `CHROXY_CONFIG_DIR` | `~/.chroxy` — the daemon's config/state root. **The three defaults below marked `<configDir>` derive from this**, so relocating the root moves them too; it must be absolute or it is ignored ([CONFIG.md](../server/CONFIG.md#the-config-root-chroxy_config_dir)) |
| `CHROXY_INGEST_URL` | `http://127.0.0.1:<port>/api/events` (`port` from `<configDir>/config.json`, else 8765) |
| `CHROXY_INGEST_SECRET` | contents of `<configDir>/ingest-secret` (provisioned by the daemon at startup) |
| `CHROXY_HOOKS_CHROXY_WORKTREES_ROOT` | `<configDir>/worktrees` (chroxy session-worktree root; test-surface override) |
| `CHROXY_HOOKS_SETTINGS_PATH` | `~/.claude/settings.json` (install/uninstall target — Claude Code's own root, **not** chroxy's, and unaffected by `CHROXY_CONFIG_DIR`) |
| `CHROXY_HOOKS_DEBUG=1` | stderr diagnostics from `emit` (silent otherwise) |
| `CHROXY_HOOKS_SKIP_CWD_FILTER=1` | bypass the non-project cwd filter (tests/debugging) |

The emitters must agree with the daemon on where that root is: a hook that resolved
`$HOME/.chroxy/worktrees` while the daemon used a relocated root would stop recognising a
chroxy session worktree and mint a Discord embed named after its opaque hex id instead of
suppressing it (the #5464 regression — see the `#7052` note in
[`protocol/src/project.ts`](../protocol/src/project.ts)). This package is deliberately
zero-runtime-dependency and so cannot import the server's `configPath()`; it carries one
reviewed copy of the same `||` fallback, and `packages/server/scripts/lint-config-dir.mjs`
now scans this tree so a **second** copy is caught (#7239).

`project` is derived hook-side (worktree-parent remap for `.claude/worktrees/*` checkouts
and for chroxy session worktrees under `<configDir>/worktrees/<id>` — parsed back to the
parent repo via the worktree `.git` file's `gitdir:` since the id basename is opaque —
then cwd → nearest `.git`, then `$CLAUDE_PROJECT_DIR`) and sent explicitly; the server's
cwd derivation is fallback only.

Non-project sessions are filtered hook-side (#5439, #5464): temp-dir (`/tmp`, `/var/tmp`)
and home-root cwds emit nothing; worktree cwds (both sources) emit only subagent events,
attributed to the parent project. The `Notification` emitter forwards `notification_type`
(`idle_prompt` / `permission_prompt`) so the server can distinguish "ready for input"
from "needs approval".

Subagent counting is server-side: the daemon aggregates `subagent_start` / `subagent_stop`
per (source, sessionId) and surfaces active counts in notification text — emitters carry
no state.

Turn edges (#5541): `UserPromptSubmit` emits `user_prompt_submit` (authoritative turn
start) and `Stop` emits `stop` (authoritative turn end). The server uses these to flip the
embed online while subagents run and to ping "Ready for input" the moment a turn ends. The
`user_prompt_submit` data bag carries the `cwd` ONLY — the raw prompt text is NEVER
forwarded (privacy).

## Tests

```bash
cd packages/claude-hooks && npm test
```

Tests run under a sandboxed temp HOME and env-injected paths — they never read or write
the real `~/.chroxy` or `~/.claude`.
