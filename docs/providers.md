# Providers

Chroxy runs AI coding sessions through pluggable **providers**. Each provider wraps a different AI backend (Claude Code, OpenAI Codex, Google Gemini) behind the same WebSocket/event contract, so the mobile app and desktop dashboard work identically regardless of which one you pick.

Five first-party providers ship built-in:

- `claude-sdk` — **default**. Claude Code via the `@anthropic-ai/claude-agent-sdk` (in-process).
- `claude-cli` — Legacy `claude -p` subprocess. Use if the SDK is unavailable or you need plan mode.
- `claude-tui` — Interactive `claude` TUI driven under a PTY. Bills as your Claude subscription's interactive allowance and bypasses the programmatic credit pool. See [Billing & API usage](../README.md#billing--api-usage).
- `gemini` — Google Gemini CLI (`gemini -p`).
- `codex` — OpenAI Codex CLI (`codex exec`).

Two additional providers register automatically when `environments.enabled=true` and Docker is available: `docker-cli` and `docker-sdk` (containerized wrappers of `claude-cli` / `claude-sdk`).

The registry lives in [`packages/server/src/providers.js`](../packages/server/src/providers.js) as a plain object literal mapping provider names to their session classes. To add a provider, edit that literal. Session classes must extend `EventEmitter` and expose `start`/`destroy`/`sendMessage`/`interrupt`/`setModel`/`setPermissionMode` plus a static `capabilities` getter — see [`sdk-session.js`](../packages/server/src/sdk-session.js) or [`cli-session.js`](../packages/server/src/cli-session.js) for a worked example.

## Provider table

| Provider | Binary / SDK | Env vars | Default model | Auth | Notes |
|----------|--------------|----------|---------------|------|-------|
| `claude-sdk` *(default)* | `@anthropic-ai/claude-agent-sdk` (npm) | `ANTHROPIC_API_KEY` (or inherits `claude` CLI login) | Deferred to SDK | Anthropic API key or subscription login | In-process, fastest startup, live model/mode switching, resume support |
| `claude-cli` | `claude` (Claude Code CLI) | `ANTHROPIC_API_KEY` (or `claude` CLI login) | Deferred to `claude` CLI | Anthropic API key or subscription login | Subprocess, required for plan mode; permission hook via HTTP |
| `claude-tui` | `claude` (Claude Code CLI, interactive TUI) | `claude` CLI login (rejects `ANTHROPIC_API_KEY` — strips it from spawn env) | Deferred to `claude` TUI | Subscription login only | Persistent PTY, one warmup per session; permission hook via HTTP; deliver-on-complete (no live streaming); bills as interactive subscription |
| `gemini` | `gemini` (Gemini CLI) | `GEMINI_API_KEY` | `gemini-2.5-pro` | Google AI Studio API key | No permissions, no plan mode, no resume, no attachments |
| `codex` | `codex` (OpenAI Codex CLI) | `OPENAI_API_KEY` | `gpt-5.4` | OpenAI API key | No permissions, no plan mode, no resume, no attachments |
| `docker-cli` | Docker image + `claude` inside | Inherits Claude env from container | Inherits `claude-cli` | Same as `claude-cli` | Only registered when `environments.enabled=true` and Docker daemon is reachable |
| `docker-sdk` | Docker image + SDK inside | Inherits Claude env from container | Inherits `claude-sdk` | Same as `claude-sdk` | Only registered when `environments.enabled=true` and Docker daemon is reachable |

> **Default model behaviour differs by provider.** Codex and Gemini have a `DEFAULT_MODEL` constant inside their session class (`gpt-5.4`, `gemini-2.5-pro`) — that's the value the provider actually passes when nothing is set. The Claude providers do NOT define an internal default: when `--model` / `CHROXY_MODEL` / `config.model` is unset, Chroxy passes `null` through `BaseSession` to the SDK or `claude` CLI, which then picks its own default (typically whatever the current Claude Code / SDK release ships with — often Sonnet, but subject to change upstream). The `claude-sonnet-4-6` string you'll see elsewhere in the code is the full ID the `sonnet` alias resolves to in `models.js`, not a hardcoded default.
>
> Mobile/desktop clients can switch models live on providers that report `modelSwitch: true`. Docker providers inherit `modelSwitch` from their underlying Claude provider (`DockerSession` spreads `CliSession.capabilities`, `DockerSdkSession` spreads `SdkSession.capabilities`), so they behave the same as `claude-cli` / `claude-sdk` for model switching.

## Claude (SDK, CLI, TUI)

The Claude Code providers are the primary, most-featured backends. All three use the same `claude` credentials; they differ in transport, billing surface, and capabilities.

### Install

```bash
# 1. Install Claude Code CLI (required by both providers — see below)
# Follow https://docs.claude.com/claude-code for the current installer
# Typical install paths Chroxy searches automatically:
#   ~/.local/bin/claude
#   /opt/homebrew/bin/claude
#   /usr/local/bin/claude
#   ~/.claude/local/node_modules/.bin/claude
#   ~/.npm-global/bin/claude

# 2. Verify it's on PATH
claude --version
```

The SDK provider (`claude-sdk`) does not shell out to the `claude` binary for message handling — it imports `@anthropic-ai/claude-agent-sdk` directly. However, `claude doctor`'s CLI still needs to be installed (the `chroxy doctor` preflight checks for it), and many users authenticate via `claude login`, which the SDK then inherits.

### Where to get an API key

- **Anthropic API key** (recommended for API-billed usage): https://console.anthropic.com/settings/keys — set `ANTHROPIC_API_KEY=sk-ant-...`
- **Subscription login** (Claude.ai Pro / Max / Team plans): run `claude login` in a terminal. Both providers inherit the login session automatically.

### Verify

```bash
npx chroxy doctor
```

Expected output includes:
- `Node.js     v22.x.x`
- `claude      <version string>`
- `cloudflared <version string>`

If `claude` is reported "Not found", ensure it's in one of the paths listed above. Under a GUI-launched server (e.g. the Tauri desktop app), `PATH` is minimal on macOS — Chroxy probes known install locations, but a Homebrew or npm-global install that's neither on `PATH` nor in the probe list will be missed.

### Choose between SDK, CLI, and TUI

| Feature | `claude-sdk` | `claude-cli` | `claude-tui` |
|---------|--------------|--------------|--------------|
| In-process permissions (`canUseTool`) | Yes | No (HTTP hook) | No (HTTP hook) |
| Live `setModel` | Yes | Yes (restart) | — |
| Live `setPermissionMode` | Yes | Yes (restart) | — |
| Plan mode | No | **Yes** | No |
| Resume (`resumeSessionId`) | Yes | No | No |
| Thinking level control | Yes | No | No |
| Live streaming (`stream_delta`) | Yes | Yes | No (deliver-on-complete) |
| Auth | API key or `claude login` | API key or `claude login` | `claude login` only (`ANTHROPIC_API_KEY` rejected) |
| Billing | Programmatic credits / API | Programmatic credits / API | **Subscription interactive allowance** |
| Startup overhead | None (in-process) | One `claude -p` spawn per session | One `claude` PTY warmup (~3.5s) per session |

Pick by billing surface and required features:

- **`claude-sdk` (default)** — the right choice for most users. Programmatic billing, fastest startup, live model/mode switching, resume, thinking-level control.
- **`claude-cli`** — pick this only when you need plan mode. Same billing as the SDK, but a `claude -p` subprocess per session.
- **`claude-tui`** — pick this when you want sessions to bill against your Claude.ai Pro / Max / Team subscription instead of programmatic credits. Trade-offs: no live streaming (responses arrive as one burst at turn end), no live model switch, no plan mode, no permission-mode switch, no resume, no attachments, no agent tracking, no cost reporting. See [Known limits → `claude-tui`](#claude-tui) for the full list, and [Billing & API usage](../README.md#billing--api-usage) for the billing distinction.

### Common pitfalls

- **GUI launch on macOS**: Tauri-spawned servers start with `cwd=/` and a minimal PATH. Chroxy probes absolute paths, but custom install locations need `ANTHROPIC_API_KEY` or a working `claude login` — don't rely on shell rc files.
- **Model names**: pass short aliases (`sonnet`, `opus`, `haiku`) or full IDs (`claude-sonnet-4-6`). Aliases are resolved to their full ID by `resolveModelId()` in `models.js` — but note this only runs in `BaseSession.setModel()` (i.e. live `set_model` messages from the mobile app / dashboard). On initial session creation, whatever string you set via `--model` / config is forwarded to the provider verbatim. Both the SDK and the `claude` CLI accept aliases directly, so this is fine in practice — but if you're writing a custom provider that doesn't accept aliases, canonicalize in the constructor.
- **Permission prompts never arrive (claude-cli only)**: the PreToolUse hook requires `CHROXY_PORT` and the per-session hook secret injected via `~/.claude/settings.json`. Restarting the server re-registers it.

## Codex

OpenAI's Codex CLI wrapper.

### Install

Install the `codex` CLI per OpenAI's documentation. Chroxy looks for it in:
- `/opt/homebrew/bin/codex`
- `/usr/local/bin/codex`
- `/usr/bin/codex`

```bash
codex --version
```

### Where to get an API key

https://platform.openai.com/api-keys — export `OPENAI_API_KEY=sk-...`.

The provider hard-fails at `start()` with `OPENAI_API_KEY environment variable is not set` if the var is missing.

### Verify

```bash
# Confirm the binary works standalone
codex exec "hello" --json

# Start Chroxy with the codex provider
OPENAI_API_KEY=sk-... npx chroxy start --provider codex
```

`chroxy doctor` does **not** currently probe for `codex` or `gemini` binaries — it only checks `node`, `cloudflared`, and `claude`. Verify third-party binaries manually.

### Common pitfalls

- **Empty streams on stderr warnings**: Codex writes occasional `WARN`/`ERROR` lines to stderr that Chroxy logs but doesn't propagate as session errors unless the process exits non-zero.
- **No conversation memory**: Codex sessions do not carry state between messages. Each `sendMessage` is a fresh `codex exec`. See "Known limits".
- **Model flag format**: Chroxy passes `-c 'model="<id>"'` to Codex — changing `this.model` takes effect on the next message (no process to restart).

### Sandbox & write surfaces

Codex sessions default to `--sandbox workspace-write` (#3846). Per the
Codex source policy (`codex-rs/protocol/src/permissions.rs::workspace_write`
in `openai/codex`), that policy permits the model to write to **four
distinct surfaces** — not just the session cwd:

1. **The session `cwd` / `project_roots`** — the directory you picked
   when starting the session. Bounded by Chroxy's `validateCwdAllowed`
   workspace allowlist (see
   [`handler-utils.js:259-320`](../packages/server/src/handler-utils.js#L259-L320)).
   The policy itself also appends read-only protections for `.git`,
   `.agents`, and `.codex` under this root.
2. **`/tmp`** — the system temp root. On macOS `/tmp` is a symlink to
   `/private/tmp`, and the Seatbelt profile also grants `/var/tmp` and
   `/private/var/tmp`. Override via `sandbox_workspace_write.exclude_slash_tmp`.
3. **`$TMPDIR`** — the per-process temp directory, resolved by the
   spawned `codex` process (may differ from Chroxy's environment).
   Override via `sandbox_workspace_write.exclude_tmpdir_env_var`.
4. **`writable_roots` / `--add-dir`** — user-supplied additional
   writable roots, set in Codex's own config
   (`~/.codex/config.toml`'s `[sandbox_workspace_write] writable_roots = [...]`)
   or via the `--add-dir` CLI flag. The spawned `codex` process loads
   its user config unless `--ignore-user-config` is passed — Chroxy
   does **not** pass that flag today, so this surface can be silently
   broadened by the operator's Codex config.

Items 2–4 mean "the workspace" is **broader than the chroxy session
cwd**. Chroxy's session-trust gate only constrains item 1. If you need
a hard read-only session, the per-session sandbox selector tracked in
#3837 is the user-facing override — until that lands, set
`CHROXY_CODEX_SANDBOX=read-only` server-wide (planned in #3847).

Separately, Codex maintains an internal memory store at
`$HOME/.codex/memories`. This is written by Codex's own in-process
memory tooling, **not** by the sandboxed shell/exec policy above —
`--sandbox` does not constrain it, and Chroxy has no mechanism to gate
it. If a Chroxy operator wants to disable persistent cross-session
memory entirely, that has to happen in Codex's own config.

Source: the `workspace_write` policy in `openai/codex`
[`codex-rs/protocol/src/permissions.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/permissions.rs).
The public Codex config reference at developers.openai.com/codex
documents the override keys (`exclude_slash_tmp`, `exclude_tmpdir_env_var`,
`writable_roots`) but not the full default policy — re-verify against
the source if Codex versions change.

## Gemini

Google Gemini CLI.

### Install

Install the Gemini CLI per Google's documentation. Chroxy looks for it in:
- `/opt/homebrew/bin/gemini`
- `/usr/local/bin/gemini`
- `/usr/bin/gemini`

```bash
gemini --version
```

### Where to get an API key

https://aistudio.google.com/apikey — export `GEMINI_API_KEY=...`.

The provider hard-fails at `start()` with `GEMINI_API_KEY environment variable is not set` if the var is missing.

### Verify

```bash
gemini -p "hello" --output-format stream-json -y

GEMINI_API_KEY=... npx chroxy start --provider gemini
```

### Common pitfalls

- **`-y` (auto-approve) is always passed**: Chroxy invokes Gemini non-interactively. Permission handling is entirely bypassed — there are no Chroxy permission prompts because Gemini itself isn't asked.
- **Attachments error out**: sending a message with attachments emits a session-level error (`Gemini provider does not support attachments`).
- **Event format drift**: the `gemini-session.js` handler maps the most common `assistant` / `tool_result` / `result` events. Newer Gemini CLI releases may emit additional event types that Chroxy currently ignores.

## Selecting a provider

Precedence (highest first): CLI flag > environment variable > config file > default (`claude-sdk`).

### CLI flag

```bash
npx chroxy start --provider claude-cli
npx chroxy start --provider gemini
npx chroxy start --provider codex
```

### Environment variable

```bash
CHROXY_PROVIDER=gemini npx chroxy start
```

### Config file

`~/.chroxy/config.json`:

```json
{
  "apiToken": "...",
  "port": 8765,
  "provider": "claude-sdk"
}
```

### Legacy `legacyCli` flag

Older configs use `legacyCli: true` to force the `claude-cli` provider. This still works — it's mapped to `provider: "claude-cli"` at load time — but prefer `provider` in new configs.

## Capability matrix

Rows marked **(capability)** come directly from each session class's `static get capabilities()` object — those are the keys the provider registry inspects at runtime. The remaining rows are **(behavioural)** — derived from reading the session class's implementation (attachment handling, agent-tracking events, cost parsing, continuity across `sendMessage` calls). Behavioural rows are not currently part of the `capabilities` contract and may change if the class is refactored.

| Capability | `claude-sdk` | `claude-cli` | `claude-tui` | `codex` | `gemini` |
|------------|:-:|:-:|:-:|:-:|:-:|
| **(capability)** Permissions (`canUseTool` / hook) | Yes | Yes | Yes (HTTP hook) | — | — |
| **(capability)** In-process permissions | Yes | — | — | — | — |
| **(capability)** Live model switch | Yes | Yes | — | Yes | Yes |
| **(capability)** Live permission-mode switch | Yes | Yes | — | — | — |
| **(capability)** Plan mode | — | **Yes** | — | — | — |
| **(capability)** Resume (`resumeSessionId`) | Yes | — | — | — | — |
| **(capability)** Terminal (raw PTY) | — | — | — | — | — |
| **(capability)** Thinking level control | Yes | — | — | — | — |
| **(capability)** Live streaming (`stream_delta`) | Yes | Yes | **No** (deliver-on-complete) | Yes | Yes |
| **(behavioural)** Attachments (images, files) | Yes | Yes | — | — | — |
| **(behavioural)** Agent tracking (spawned/completed) | Yes | Yes | — | — | — |
| **(behavioural)** Cost reporting (`result.cost`) | Yes | Yes | — | — | — |
| **(behavioural)** Multi-session (SessionManager) | Yes | Yes | Yes | Yes | Yes |
| **(behavioural)** Conversation continuity across messages | Yes (SDK state) | Yes (persistent process) | Yes (persistent PTY) | **No** | **No** |

For capability rows, "—" means the provider's `capabilities` object reports `false`. For behavioural rows, "—" means the feature is unimplemented (the session class throws or emits a `not supported` error, or silently no-ops). Most provider-agnostic UI (session tabs, chat/terminal dual view, push notifications, conversation search, web dashboard) works across all providers.

## Known limits

### `claude-sdk`

- **No plan mode** — use `claude-cli` instead.
- Depends on `@anthropic-ai/claude-agent-sdk` being installed (comes with `packages/server` dependencies by default).

### `claude-cli`

- **No resume** — each new session starts fresh; history replay is driven by Chroxy's own `session-manager.js`, not by `claude`.
- **No thinking-level control** — SDK-only feature.
- Requires the `claude` binary to be installed and executable.

### `claude-tui`

- **Subscription only** — `ANTHROPIC_API_KEY` is explicitly stripped from the spawn env. Auth via `claude login`; no API-key fallback.
- **No live streaming** — the response is delivered as one `stream_start` → `stream_delta` → `stream_end` burst when Claude's `Stop` hook fires. No incremental token streaming inside a turn.
- **No live model switch, no plan mode, no permission-mode switch, no resume, no thinking-level control, no attachments, no agent tracking, no cost reporting** — `result.cost` is emitted as `0` (a placeholder, not parsed from the Stop hook) and `result.usage` is `null` (the Stop hook payload doesn't expose either).
- **One PTY per session** — pays a ~3.5s warmup cost on `start()`, then every `sendMessage` writes to the same PTY. Concurrent sessions in the same `cwd` are not protected against each other; treat as one session per repo.
- **Tool events are reconstructed from `PreToolUse` / `PostToolUse` hooks** — `tool_use_id` is taken from the hook payload when present, otherwise synthesized per turn (`<messageId>-tool-N`). Pre/Post pairing breaks if tool calls overlap or a Pre fires without a matching Post.
- **Hook payloads write to a per-session directory under `tmpdir()/chroxy-claude-tui/s-<uuid>/`**. Cleaned up on `destroy()`.

### `codex`

- **No conversation continuity** — Codex is invoked as a one-shot `codex exec` per message. No system prompt, no persistent context, no resume.
- **No permission handling** — the provider reports `permissions: false`. Tools run under whatever policy Codex itself enforces.
- **No plan mode, no attachments, no agent tracking.**
- **No cost reporting** — `result.cost` is always `null`. Usage tokens are emitted if present in Codex's `turn.completed` event.
- **Session ID is always `null`** — downstream features that key off `sessionId` (e.g. resume) are unavailable.

### `gemini`

- **No conversation continuity** — each `sendMessage` spawns a fresh `gemini -p`. No persistent context across turns.
- **No permission handling** — `-y` is always passed to Gemini. The provider reports `permissions: false`.
- **No plan mode, no attachments, no agent tracking.**
- **No cost reporting** — `result.cost` is always `null`. Token counts may be emitted when present.
- **Session ID is always `null`.**
- **Event shape drift** — only `assistant`, `tool_result`, and `result` events are mapped; future CLI versions may emit events that Chroxy silently ignores.

### `docker-cli` / `docker-sdk`

- Only registered when `environments.enabled=true` in config AND `docker info` succeeds at server startup.
- Inherits all capabilities of the underlying Claude provider. Model default and env requirements are resolved inside the container.
- See [`docs/guides/`](guides/) for environment/container setup.

## See also

- [`packages/server/CONFIG.md`](../packages/server/CONFIG.md) — full list of config keys and precedence rules.
- [`docs/feature-matrix.md`](feature-matrix.md) — client-side feature availability across Mobile / Desktop / Server.
- [`docs/troubleshooting.md`](troubleshooting.md) — connection, tunnel, and permission-hook issues.
- [`packages/server/src/providers.js`](../packages/server/src/providers.js) — provider registry (literal map of built-ins).
