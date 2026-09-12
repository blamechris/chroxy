# Providers

Chroxy runs AI coding sessions through pluggable **providers**. Each provider wraps a different AI backend (Claude Code, the Anthropic API directly, DeepSeek, local Ollama models, Google Gemini, OpenAI Codex) behind the same WebSocket/event contract, so the mobile app and desktop dashboard work identically regardless of which one you pick.

Nine first-party providers ship built-in (one, `claude-channel`, is a research-preview scaffold):

- `claude-sdk` — Claude Code via the `@anthropic-ai/claude-agent-sdk` (in-process). Fastest, most feature-rich (live streaming, model/mode switching, resume), but on/after 2026-06-15 UTC its subscription login draws Anthropic's metered programmatic-credit pool. Was the previous default (see #5819).
- `claude-cli` — Legacy `claude -p` subprocess. Use if the SDK is unavailable or you need plan mode.
- `claude-tui` — **default** (see #5819). Interactive `claude` TUI driven under a PTY. Drives the interactive CLI, which **today** bills against your Claude subscription's interactive allowance rather than the programmatic credit pool — a best-effort bet, not a guarantee: Anthropic may reclassify or enforce against third-party apps that drive a subscription login programmatically. Chosen as the default to keep a zero-config setup off the metered credit pool at the 2026-06-15 cutover; trades away live streaming, live model switch, plan mode, attachments, agent tracking, and cost reporting (see [Known limits → `claude-tui`](#claude-tui)). See [Billing & API usage](../README.md#billing--api-usage).
- `claude-channel` — **Research preview, scaffold only (not yet runnable).** Will drive Claude through Anthropic's first-party channels MCP protocol (`claude --channels`): same subscription billing as `claude-tui`, but a documented protocol instead of a TUI scrape, and — once the backend lands — live streaming plus a first-party permission relay. See [`claude-channel`](#claude-channel-research-preview).
- `claude-byok` — "Bring your own key": the Anthropic Messages API driven directly via `@anthropic-ai/sdk`, no `claude` binary. Chroxy's own in-process agent loop (streaming, tools, in-process permissions, MCP servers).
- `deepseek` — DeepSeek's Anthropic-compatible API. A subclass of `claude-byok` — same agent loop, DeepSeek credentials/endpoint/pricing.
- `ollama` — Local models via Ollama's Anthropic-compatible API (v0.14+). Same agent loop, no API key, cost always $0. See [Ollama (local models)](#ollama-local-models).
- `gemini` — Google Gemini CLI (`gemini -p`).
- `codex` — OpenAI Codex CLI (`codex exec`).

Three additional providers register automatically when `environments.enabled=true` and Docker is available: `docker-cli` and `docker-sdk` run their `claude-cli` / `claude-sdk` provider inside the container, while `docker-byok` keeps the `claude-byok` agent loop on the host and redirects only built-in tool execution (Read/Write/Edit/Bash/Glob/Grep) into the container.

Beyond the built-ins, any service or local server that exposes an **Anthropic-compatible Messages API** (Z.ai GLM, Moonshot Kimi, MiniMax, LM Studio, llama.cpp server, vLLM, OpenRouter, custom proxies) can be registered straight from `config.json` — no code required. See [Anthropic-compatible endpoints (config-driven)](#anthropic-compatible-endpoints-config-driven). Endpoints that speak the **OpenAI Chat Completions API** instead (OpenAI, OpenRouter, LM Studio, vLLM, Together, Groq, …) register the same way under a sibling block — see [OpenAI-compatible endpoints (config-driven)](#openai-compatible-endpoints-config-driven).

Regardless of provider, every session's environment carries Chroxy's own **host identity** (`CHROXY_HOST_VERSION`, `CHROXY_HOST_GIT_SHA`, `CHROXY_HOST_CHANNEL`, …) so an agent can confirm the exact running build — see [Chroxy host metadata](guides/host-metadata.md).

## Setting credentials from the dashboard

The **primary** way to supply provider credentials is the **Settings → Provider Credentials** pane in the desktop dashboard (and the browser dashboard — same authenticated WebSocket path). It lets you view, set, rotate, test, and remove an API key per provider without dropping to a terminal to export environment variables:

- Supported keys: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GEMINI_API_KEY`, `OPENAI_API_KEY`.
- Keys are saved to `~/.chroxy/credentials.json` (mode `0600`, owner-only) and are never shown again after saving — only a masked preview (a short leading prefix followed by `…[N chars redacted]`). Chroxy refuses to read the file unless its mode is exactly `0600`.
- **Resolution order is env > store > unset.** An exported shell environment variable always wins over a stored value, so power users keep full control; the store fills the gap when no env var is exported.
- OAuth status (`claude login`) is shown read-only — Chroxy does not manage the OAuth flow from the dashboard. Run `claude login` in a terminal for the subscription path.
- This retires the macOS GUI-launch footgun below for most users: a Tauri/launchd-spawned server (`cwd=/`, minimal PATH, no shell rc sourced) can spawn a working session from stored credentials alone, because Chroxy injects them into the spawned child env when the shell hasn't exported them. (`ANTHROPIC_API_KEY` stays stripped for the Claude CLI/TUI providers so they keep using subscription/OAuth auth.)

The registry lives in [`packages/server/src/providers.js`](../packages/server/src/providers.js) as a plain object literal mapping provider names to their session classes. To add a provider, edit that literal. Session classes must extend `EventEmitter` and expose `start`/`destroy`/`sendMessage`/`interrupt`/`setModel`/`setPermissionMode` plus a static `capabilities` getter — see [`sdk-session.js`](../packages/server/src/sdk-session.js) or [`cli-session.js`](../packages/server/src/cli-session.js) for a worked example.

## Provider table

| Provider | Binary / SDK | Env vars | Default model | Auth | Notes |
|----------|--------------|----------|---------------|------|-------|
| `claude-sdk` | `@anthropic-ai/claude-agent-sdk` (npm) | `ANTHROPIC_API_KEY` (or inherits `claude` CLI login) | Deferred to SDK | Anthropic API key or subscription login | In-process, fastest startup, live model/mode switching, resume support. **Billing class (#5629):** explicit `ANTHROPIC_API_KEY` → raw API (per-token, api-key). OAuth/subscription login (`claude login`) → a flat Claude **subscription before 2026-06-15 UTC**, and Anthropic's monthly **programmatic credit pool on/after** that date. |
| `claude-cli` | `claude` (Claude Code CLI) | `ANTHROPIC_API_KEY` (or `claude` CLI login) | Deferred to `claude` CLI | Anthropic API key or subscription login | Subprocess, required for plan mode; permission hook via HTTP. **Billing class (#5629):** the CLI strips `ANTHROPIC_API_KEY` before spawn, so it always auths via the host pool — a flat Claude **subscription before 2026-06-15 UTC**, and the monthly **programmatic credit pool on/after** that date. |
| `claude-tui` *(default)* | `claude` (Claude Code CLI, interactive TUI) | `claude` CLI login (rejects `ANTHROPIC_API_KEY` — strips it from spawn env) | Deferred to `claude` TUI | Subscription login only | Persistent PTY, one warmup per session; permission hook via HTTP; deliver-on-complete (no live streaming); bills as interactive subscription. The zero-config default (see #5819), to keep setups off the metered programmatic-credit pool. |
| `claude-channel` *(research preview)* | `claude --channels` (Claude Code CLI, MCP channel transport) | `claude` CLI login (rejects `ANTHROPIC_API_KEY`). Requires `claude` ≥ 2.1.80 + `--dangerously-load-development-channels` | Deferred to `claude` | Subscription login only | **Scaffold — not yet runnable** (`start()` throws; bridge in #3954). Documented MCP contract instead of TUI scrape; live streaming; first-party permission relay; bills as interactive subscription |
| `gemini` | `gemini` (Gemini CLI) | `GEMINI_API_KEY` / `GOOGLE_API_KEY`, **or** `gemini login` OAuth | `gemini-2.5-pro` | Google AI Studio API key or a `gemini login` session | No permissions, no plan mode, no resume, no attachments |
| `codex` | `codex` (OpenAI Codex CLI) | `OPENAI_API_KEY`, **or** `codex login` OAuth | CLI default (`~/.codex/config.toml`) | OpenAI API key or a `codex login` session | **Default (app-server, #6616):** approvals + permission-mode switching + attachments (image vision + document/file references) + intra-session memory; no plan mode, no resume yet. Opt out with `CHROXY_CODEX_APPSERVER=0` → legacy `codex exec` (no permissions, no attachments) |
| `claude-byok` | `@anthropic-ai/sdk` (npm) → Anthropic Messages API | `ANTHROPIC_API_KEY` (or `anthropicApiKey` in `~/.chroxy/credentials.json`) | `claude-opus-4-8` | Anthropic API key (per-token billing) | No `claude` binary — Chroxy's own in-process agent loop (streaming, tools, in-process permissions, MCP); no cross-restart resume (#4047) |
| `deepseek` | `@anthropic-ai/sdk` → DeepSeek's Anthropic-compatible endpoint | `DEEPSEEK_API_KEY` (or `deepseekApiKey` in `~/.chroxy/credentials.json`); `DEEPSEEK_BASE_URL` (optional endpoint override) | `deepseek-chat` | DeepSeek API key (per-token billing) | Subclass of `claude-byok` — same agent loop with DeepSeek credentials, endpoint, and pricing |
| `ollama` | `@anthropic-ai/sdk` → local Ollama daemon (v0.14+) | `CHROXY_OLLAMA_BASE_URL` / `OLLAMA_HOST` (optional endpoint overrides) | `qwen3-coder` | None — local inference | Local models via Ollama's Anthropic-compatible API; full BYOK agent loop (tools, permissions, MCP); cost always $0; any `ollama pull`ed model id accepted |
| *(config-driven)* | `@anthropic-ai/sdk` → any Anthropic-compatible endpoint | Entry's `apiKeyEnv` (or `credentialsKey` in `~/.chroxy/credentials.json`) | Entry's `defaultModel` | Per-entry API key, or none (local servers) | Declared in `providers.anthropicCompatible` (config.json): Z.ai GLM, Moonshot Kimi, MiniMax, LM Studio, llama.cpp, vLLM, OpenRouter, custom. Full BYOK agent loop. See [below](#anthropic-compatible-endpoints-config-driven) |
| *(config-driven)* | `openai` SDK → any OpenAI chat-completions endpoint | Entry's `apiKeyEnv` (or `credentialsKey` in `~/.chroxy/credentials.json`) | Entry's `defaultModel` | Per-entry API key, or none (local servers) | Declared in `providers.openaiCompatible` (config.json): OpenAI, OpenRouter, LM Studio, vLLM, llama.cpp, Together, Groq, DeepInfra, custom. Same BYOK agent loop, OpenAI wire format. See [below](#openai-compatible-endpoints-config-driven) |
| *(config-driven)* | `@agentclientprotocol/sdk` → any [ACP](https://agentclientprotocol.com)-speaking agent, spawned over stdio | None managed by Chroxy — the agent authenticates itself | N/A — the agent picks its own model | The agent's own credential story | Declared in `providers.acp` (config.json): one persistent child process per configured agent, many turns. **Permissions are denied by default** — no permission bridge yet (#7320). See [below](#acp-agents-config-driven) |
| `docker-cli` | Docker image + `claude` inside | Inherits Claude env from container | Inherits `claude-cli` | Same as `claude-cli` | Only registered when `environments.enabled=true` and Docker daemon is reachable |
| `docker-sdk` | Docker image + SDK inside | Inherits Claude env from container | Inherits `claude-sdk` | Same as `claude-sdk` | Only registered when `environments.enabled=true` and Docker daemon is reachable |
| `docker-byok` | Docker image; agent loop stays on the host via `@anthropic-ai/sdk` | Same as `claude-byok` | Inherits `claude-byok` | Same as `claude-byok` | Only registered when `environments.enabled=true` and Docker daemon is reachable; built-in tool execution (Read/Write/Edit/Bash/Glob/Grep) runs inside the container |

> **Default model behaviour differs by provider.** Gemini has a `DEFAULT_MODEL` constant inside its session class (`gemini-2.5-pro`) — the value it passes when nothing is set. Codex passes `null` (its `DEFAULT_MODEL` was removed — pinning a release broke `codex exec` when that version wasn't on the host), so the Codex CLI falls back to whatever is in `~/.codex/config.toml`. The BYOK family has an internal fallback: `ClaudeByokSession._defaultModel` returns `claude-opus-4-8`, overridden per subclass (`deepseek-chat`, `qwen3-coder`) — the defaults listed in the table above. The `claude`-binary providers (`claude-sdk`, `claude-cli`, `claude-tui`, `claude-channel`) do NOT define an internal default: when `--model` / `CHROXY_MODEL` / `config.model` is unset, Chroxy passes `null` through `BaseSession` to the SDK or `claude` CLI, which then picks its own default (typically whatever the current Claude Code / SDK release ships with — often Sonnet, but subject to change upstream). The `claude-sonnet-4-6` string you'll see elsewhere in the code is the full ID the `sonnet` alias resolves to in `models.js`, not a hardcoded default.
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
chroxy doctor
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
| Live `setPermissionMode` | Yes | Yes (sidecar file, no restart) | Yes (sidecar file, no restart) |
| Plan mode | No | **Yes** | No |
| Resume (`resumeSessionId`) | Yes | Yes (`--resume` on respawn/restore) | Yes (`--resume` on restore) |
| Thinking level control | Yes | No | No |
| Live streaming (`stream_delta`) | Yes | Yes | No (deliver-on-complete) |
| Auth | API key or `claude login` | API key or `claude login` | `claude login` only (`ANTHROPIC_API_KEY` rejected) |
| Billing | Programmatic credits / API | Programmatic credits / API | **Subscription interactive allowance** (today; best-effort, not guaranteed) |
| Startup overhead | None (in-process) | One `claude -p` spawn per session | One `claude` PTY warmup (~3.5s) per session |

Pick by billing surface and required features:

- **`claude-tui` (default)** — the zero-config default (see #5819). Bills against your Claude.ai Pro / Max / Team subscription's interactive allowance instead of the metered programmatic-credit pool — a best-effort bet that bills this way *today*, not a guarantee (Anthropic may reclassify or enforce against third-party automation of a subscription login; keep BYOK as a fallback). Trade-offs: no live streaming (responses arrive as one burst at turn end), no live model switch, no plan mode, no attachments, no agent tracking, no cost reporting. See [Known limits → `claude-tui`](#claude-tui) for the full list, and [Billing & API usage](../README.md#billing--api-usage) for the billing distinction.
- **`claude-sdk`** — pick this for the richest experience (programmatic billing, fastest startup, live model/mode switching, resume, thinking-level control) when you're comfortable drawing the metered programmatic-credit pool on/after 2026-06-15, or you set an explicit `ANTHROPIC_API_KEY` for raw per-token billing. Was the previous default (see #5819).
- **`claude-cli`** — pick this only when you need plan mode. Same billing as the SDK, but a `claude -p` subprocess per session.

### `CHROXY_TUI_MULTISELECT_REINJECT` env override (experimental, #5797)

The interactive `claude` TUI is keyboard-only and exposes no structured answer
channel, so a **single multi-select** AskUserQuestion has no reliable
toggle-and-submit keystroke sequence. By default `claude-tui` refuses it.
`CHROXY_TUI_MULTISELECT_REINJECT` is an **experimental, default-OFF** flag that
swaps the refusal for a text-injection workaround.

- **Default (`unset` or `0`) — OFF:** a single multi-select AskUserQuestion is
  torn down immediately with a visible, retryable error — *"Multi-select
  questions aren't supported here. Tap Retry to resend your request."* (error
  code `ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED`). This fails loudly rather
  than driving a wrong keystroke or wedging the turn.
- **`1` — ON:** the provider accepts the single-question multi-select form by
  re-injecting the chosen labels as the *next user message* to the TUI,
  formatted as `For "<question>": <label1>, <label2>` (one such line per
  question, joined by newlines). The form was already denied at the permission
  hook before it rendered, so Claude has stopped and is waiting for input. The
  model reads a multi-select answer as comma-joined text anyway, so this matches
  the structured-channel result.
- **Multi-question forms (more than one question) are always refused**,
  regardless of this flag — they are denied at the permission hook and never
  driven.

> **Why it's still default-OFF.** There is a flag/UI desync (issue
> [#5791](https://github.com/blamechris/chroxy/issues/5791)): the client renders
> the multi-select form regardless of the server flag, so flipping this on
> per-server is currently the only way to actually use the feature end-to-end.
> Resolving #5791 and the deny-reason steering validation in
> [#5798](https://github.com/blamechris/chroxy/issues/5798) are the gates before
> this can go default-ON. Treat it as experimental until then.

It is read from the **daemon process environment** at request time. Set it where
the daemon is launched, e.g. exported in the shell that runs `chroxy start`:

```bash
CHROXY_TUI_MULTISELECT_REINJECT=1 chroxy start --provider claude-tui
```

or, for a launchd-started daemon, in the plist's `EnvironmentVariables`
dictionary (then reload the agent).

### Common pitfalls

- **GUI launch on macOS**: Tauri-spawned servers start with `cwd=/` and a minimal PATH. Chroxy probes absolute paths, but custom install locations need credentials supplied out-of-band. The simplest fix is the **Settings → Provider Credentials** pane (see [Setting credentials from the dashboard](#setting-credentials-from-the-dashboard)) — the server reads from its own `~/.chroxy/credentials.json` store, so you no longer have to rely on shell rc files, `~/.zshenv`, or `launchctl setenv`. A working `claude login` also satisfies the Claude providers.
- **Model names**: pass short aliases (`sonnet`, `opus`, `haiku`) or full IDs (`claude-sonnet-4-6`). Aliases are resolved to their full ID by `resolveModelId()` in `models.js` — but note this only runs in `BaseSession.setModel()` (i.e. live `set_model` messages from the mobile app / dashboard). On initial session creation, whatever string you set via `--model` / config is forwarded to the provider verbatim. Both the SDK and the `claude` CLI accept aliases directly, so this is fine in practice — but if you're writing a custom provider that doesn't accept aliases, canonicalize in the constructor.
- **Permission prompts never arrive (claude-cli only)**: the PreToolUse hook requires `CHROXY_PORT` and the per-session hook secret injected via `~/.claude/settings.json`. Restarting the server re-registers it.

## Claude channel (research preview)

`claude-channel` is a fourth Claude-family backend, in **research preview**. It
drives Claude through Anthropic's first-party **channels MCP protocol**
(`claude --channels`) — a documented protocol — instead of scraping the
interactive TUI (`claude-tui`). It bills the same way `claude-tui` does (against
your Claude subscription's interactive allowance — best-effort, not guaranteed; see
the `claude-tui` billing caveat above) but trades the fragile visual
contract for a structured MCP event stream, adds **live streaming**, and uses
Anthropic's **first-party permission relay** (`claude/channel/permission`)
instead of a sidecar hook script.

> **Status — scaffold only (#3953).** The provider is registered so the registry
> lists it and `chroxy doctor` runs its preflight, but the session backend is a
> no-op: `start()` throws "not yet implemented". The live bridge — spawn
> `claude --channels`, wire the stdio MCP child + IPC socket, normalize outbound
> events — lands in #3954. Do not select it for real work yet. The dashboard
> provider-picker entry is deliberately deferred until the bridge exists (a
> picker that surfaces a provider whose `start()` throws would be bad UX).

### How it works

A *channel* is a stdio MCP server, spawned by an interactive `claude` session,
that **pushes** events into the running session (unlike a normal MCP server,
which Claude pulls from on demand). chroxy's channel server
([`packages/server/src/channels/chroxy-channel-server.js`](../packages/server/src/channels/chroxy-channel-server.js))
declares the `experimental: { 'claude/channel': {} }` capability and a two-way
`reply` tool; the bridge (future #3954) will route events between that MCP child
and chroxy's normal WebSocket/event pipeline. See the spike,
[`docs/architecture/claude-channels-provider-spike.md`](architecture/claude-channels-provider-spike.md),
for the verified protocol contract.

### When to pick it

- **Over `claude-tui`** — once the bridge lands, the channel transport is the
  more robust subscription-billed path: a documented protocol rather than an
  ANSI scrape, plus live streaming and a first-party permission relay. Same
  billing.
- **Over `claude-sdk` / `claude-cli`** — only when you want **subscription**
  billing rather than the programmatic credit pool (the same reason you'd pick
  `claude-tui`). The SDK stays the default for programmatic billing and the most
  features (live model/mode switch, resume, thinking level, attachments, cost).

It is **not a strict superset of `claude-tui`** — see [Known limits →
`claude-channel`](#claude-channel).

### Requirements

- **`claude` ≥ 2.1.80** (the `--channels` transport floor; the spike verified it
  against v2.1.163). Permission relay needs ≥ 2.1.81, landing with #3955.
- **`--dangerously-load-development-channels`** during the preview — custom
  channels are not on Anthropic's approved allowlist. The flag bypasses only the
  allowlist, not org policy. A marketplace-approved plugin removes the need for
  it: see [`PACKAGING.md`](../packages/server/src/channels/PACKAGING.md).
- **Subscription login** (`claude login`); `ANTHROPIC_API_KEY` is not accepted.
- Channels are **not available on Bedrock / Vertex / Foundry**; Team/Enterprise
  orgs must enable `channelsEnabled`.

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
OPENAI_API_KEY=sk-... chroxy start --provider codex
```

`chroxy doctor` does **not** currently probe for `codex` or `gemini` binaries — it only checks `node`, `cloudflared`, and `claude`. Verify third-party binaries manually.

### Common pitfalls

- **Empty streams on stderr warnings**: Codex writes occasional `WARN`/`ERROR` lines to stderr that Chroxy logs but doesn't propagate as session errors unless the process exits non-zero.
- **The picker is empty or short until the binary answers**: the model roster comes from the installed `codex` binary, not from a Chroxy release — see [Where the model list comes from](#where-the-model-list-comes-from-modellist). Until an answer lands you see the hand-maintained seed rows.
- **The context meter is dashed on a brand-new session**: `model/list` carries no context window at all, so unless the Codex CLI's own cache happens to name one, nothing knows the window until the first turn reports it. See [The context window and the meter](#the-context-window-and-the-meter).
- **How the model id is passed depends on the driver**: the default app-server driver sends `model` as a JSON-RPC param on `thread/start` and on **every** `turn/start`, so a mid-session switch takes effect on the next message. The legacy exec driver passes `-c 'model="<id>"'` on the next `codex exec` instead. Either way there is no process to restart.

### Sandbox & write surfaces

Codex sessions default to `--sandbox workspace-write` (#3846). Per the
Codex source policy (`codex-rs/protocol/src/permissions.rs::workspace_write`
in `openai/codex`), that policy permits the model to write to **four
distinct surfaces** — not just the session cwd:

1. **The session `cwd` / `project_roots`** — the directory you picked
   when starting the session. Bounded by Chroxy's `validateCwdAllowed`
   workspace allowlist (see
   [`handler-utils.js`](../packages/server/src/handler-utils.js) — the `validateCwdAllowed` function).
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
`CHROXY_CODEX_SANDBOX=read-only` server-wide (#3847).

### `CHROXY_CODEX_SANDBOX` env override (#3847)

Operators on multi-tenant or shared-dev hosts may want Codex to start
more restrictive than the `workspace-write` default. Set
`CHROXY_CODEX_SANDBOX` on the server process to one of:

| Value | `--sandbox` passed to `codex exec` | Effect |
|---|---|---|
| _unset_ | `workspace-write` | Default. Codex may write to the four surfaces described above. |
| `read-only` | `read-only` | Codex may read but not write or execute side-effectful commands. |
| `workspace-write` | `workspace-write` | Same as the default — useful for making the policy explicit in a process manager unit file. |
| `danger-full-access` | `danger-full-access` | Codex has no sandbox at all. Only set on a host you fully trust. |

Unknown values (e.g. a typo like `readonly`) log a warning to stderr and
fall back to `workspace-write` rather than refusing to start the server.
The override is read on each turn, so changing the env applies on the
*next* message — but already-running `codex exec` subprocesses are
unaffected. This is a stopgap until the per-session sandbox selector
(#3837) lands.

Chroxy also unconditionally passes `--skip-git-repo-check` so Codex
will accept non-git cwds (#3834). This is correct today because
chroxy's cwd-picker is itself the trust signal — but if a directory-trust
prompt is ever added (#3840), the flag should be gated on that
confirmation so Codex's git-repo heuristic can act as a second line of
defense for untrusted directories.

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

### Codex app-server + approvals (`CHROXY_CODEX_APPSERVER`) — #6605 / #6616

The codex provider drives a persistent **`codex app-server`** (JSON-RPC) session
**by default** (#6616). It surfaces codex's approval requests through Chroxy's
**permission pipeline** — so you approve/deny codex's commands and file edits the
same way you do Claude, and can switch permission modes mid-session — and it
carries intra-session conversation memory + attachments (below).

For the full permission/sandbox model — the mode × request-class matrix, the
per-family decision vocabularies, session-grant vs Chroxy-rule semantics, the
MCP/connector gap, and the open design decisions — see
[docs/design/codex-permission-model.md](design/codex-permission-model.md).

To fall back to the legacy `codex exec --json` path (one subprocess per turn, **no
approval surface** — codex runs whatever its sandbox allows without asking, and no
attachments), set `CHROXY_CODEX_APPSERVER=0` (also accepts `false`/`no`/`off`).

Codex's `approvalPolicy` is derived from the session's permission mode, and
Chroxy's `PermissionManager` decides whether to prompt or auto-resolve:

| Permission mode | codex `approvalPolicy` | Behaviour |
|---|---|---|
| `approve` (default) | `on-request` | Every codex command / file edit prompts for your approval. |
| `acceptEdits` | `on-request` | Codex **file edits auto-approve**; **commands still prompt**. |
| `auto` | `never` | Codex runs without asking (bypass). Switching *to* `auto` also drains any pending prompts. |
| `plan` | `on-request` | Not a real codex mode (codex has no plan enforcement) — behaves like `approve`. |

The `CHROXY_CODEX_SANDBOX` override still applies: codex asks before any action
its sandbox would block (e.g. a write under `read-only`), and an approval
escalates that single action. `apply_patch` (codex's file edit) is treated like
`Write`/`Edit`, and `shell` (codex's command execution) like `Bash` — so
arbitrary codex command execution can't be permanently rule-whitelisted.

**Attachments (#6609).** The app-server path accepts attachments (the exec path
rejects them outright). Image attachments become codex `localImage` input items
(real vision — verified end-to-end); documents / non-image `file_ref`s are
materialized and named in a text suffix codex can read. So on attachments the
app-server path is a strict improvement over exec, not a regression.

**Why it's the default (#6616).** The app-server path is a strict superset of
exec — approvals, intra-session conversation memory, and attachments (image
vision + file references), with no regression (resume is unsupported on *both*
paths). The only thing that kept it opt-in was a soak period; it now ships on by
default, with the exec path one env var away (`CHROXY_CODEX_APPSERVER=0`) as a
fallback. Codex's own scope-escalation requests
(`item/permissions/requestApproval`) are surfaced through the normal permission
prompt (#6610): when codex asks to broaden its sandbox (new filesystem write
scopes or network access), you get a distinctly-worded approval prompt describing
the requested scope. Approve grants exactly that scope for the current turn,
"always allow" grants it for the session, and deny grants nothing. Like `shell`,
sandbox escalations can never be permanently rule-whitelisted — they always
prompt.

### Where the model list comes from (`model/list`)

The codex picker is **not** a list Chroxy ships. Since #7726/#7727 the roster is
whatever the installed `codex` binary says it can run, asked over the app-server's
own `model/list` method. Five sources:

| # | Source | When it is used | What it contributes |
|---|---|---|---|
| 1 | `~/.chroxy/models.json` **overlay** | Always, and it is the operator's escape hatch: overlay rows are never part of the seed, so a learned roster's REPLACE does not drop them | Labels, short ids, context windows, and brand-new ids — over the seed and the heuristic. Read the caveat below before assuming it overrides a model the binary itself reported. See [model-overlay.md](guides/model-overlay.md). |
| 2 | `model/list` on a **live session** | Fired right after `thread/start`, on the client that is already up — fire-and-forget (a wedged or old binary must not delay `ready`) and TTL-gated by the same 5-minute discovery slot as #3, so a burst of new sessions asks once | The roster: id, label, description, `supportedReasoningEfforts`, `defaultReasoningEffort`. Stamped `provenance: 'discovered'`. |
| 3 | `model/list` on a **cold-start probe** | The no-session path (the dashboard asks for `available_models` before any codex session exists, and create-session validation runs there too) — a short-lived `codex app-server` is spawned, asked, and killed. Bounded by one 5 s deadline across spawn + handshake + request, and TTL-cached for 5 minutes across **successes and failures** so a reconnect burst spawns at most one probe | Same rows as #2 |
| 4 | `$CODEX_HOME/models_cache.json` (default `~/.codex/models_cache.json`) | Best-effort, **read-only**, after a roster is in hand | Context windows **only** — the one thing `model/list` does not carry. Never written; a row without an integer `context_window` is skipped rather than defaulted |
| 5 | The **labelled seed** in `codex-session.js` (`gpt-5-codex`, `gpt-5`, `gpt-4.1`, `gpt-4o`, `o1`, `o3`) | Only while no roster has been learned — cold boot, an unresolved probe, a probe that failed, a binary below the `model/list` floor | Keeps the picker useful. Stamped `provenance: 'catalogued'` so a hand-maintained row is **labelled** as hand-maintained instead of masquerading as provider truth |

Rules that matter when you are reading a picker and wondering what you are seeing:

- **A learned roster REPLACES, it does not union.** Once the binary has answered,
  the seed rows are gone from `available_models` — a model OpenAI retired must be
  able to disappear (#7761/#7765 scoped the old fallback union, and the `[1m]`
  variant synthesis, to the Claude registry, which is where they belong).
- **"Could not ask" and "there is nothing there" are different states.** A failed
  or unparseable answer leaves the previous roster exactly as it was; only a
  well-formed answer with zero rows records an empty one.
- **Provenance rides the wire.** Each entry may carry `provenance` —
  `discovered` (the binary said so) or `catalogued` (the in-repo seed). Codex is
  currently the only provider that stamps it; the protocol also defines `manual`
  for operator-supplied rows, which nothing stamps yet. Clients keep the value in
  their model info; no picker chip renders it today.
- **The overlay's reach is "ids the roster does not carry".** An overlay row is
  merged into the picker when the learned roster has no row with that `fullId`;
  where the binary already reports the model, its own label and window are what
  you see and the overlay row is skipped with the row it was decorating. That is
  [#7777](https://github.com/blamechris/chroxy/issues/7777), stated here rather
  than implied: the overlay is how you **add** a model (or decorate one before any
  roster is learned), not how you relabel one codex already serves. A context
  window learned from a live turn also sits **above** an overlay `contextWindow`,
  since it is the binary's own authoritative answer.
- **Validation follows the same tri-state.** With a catalog in hand, its ids are
  the allowlist; with none, codex is **unrestricted** and any id passes through to
  the binary. `providers.allowAnyModel: ["codex"]` is therefore no longer needed
  to serve a new OpenAI model — see
  [Serving a new model without a release](#serving-a-new-model-without-a-release-providersallowanymodel).

### The context window and the meter

`model/list` carries **no context window** — this is a protocol fact, verified
against codex-cli 0.154.0, not a gap in Chroxy's parsing. The only in-protocol
source is `thread/tokenUsage/updated.tokenUsage.modelContextWindow`, which does
not arrive until a turn has run.

So on a brand-new codex session the context meter is **dashed** unless the Codex
CLI's own `models_cache.json` happened to name a window for that model. Chroxy
deliberately does not substitute a default: a fabricated 200k is worse than an
honest blank (#5444). After the first turn the binary's own reported window is
written to the codex registry as authoritative (and persisted, so a restart keeps
it); when a turn reports no window, the shared learn-loop can only ratchet the
window **up** off the observed prompt size. That write reaches other clients on
the next roster refresh rather than immediately — a session-scoped push is #7774.

### Reasoning effort (the codex thinking-level control)

Codex has a real reasoning control and the app-server driver reaches it, so
`thinkingLevel` is `true` for that driver (and `false` for the exec driver, which
has no way to send one).

- **The levels are per-MODEL, not repo-wide.** Each `model/list` row advertises
  its own `supportedReasoningEfforts` plus a `defaultReasoningEffort`, and
  `ReasoningEffort` is a free non-empty **string** in the app-server schema —
  values already in the wild include `low`, `medium`, `high`, `xhigh`, `max` and
  `ultra`, and they differ per model. Chroxy validates a `set_thinking_level`
  against **the active model's** advertised levels (`handlers/settings-handlers.js`),
  which is why no fixed enum lives anywhere on this path any more (#7730/#7782).
  Claude providers are unaffected: a row with no advertised levels falls back to
  the legacy `default | high | max` triple, and that fallback is refused on any
  non-Claude provider rather than being handed the Claude vocabulary by accident.
- **Seeding is ASYMMETRIC between the two RPCs, and this is easy to get wrong.**
  `thread/start` has **no** top-level `effort` field: the value goes through the
  generic `config` map as `model_reasoning_effort`, spelled exactly as
  `~/.codex/config.toml` spells it. A top-level `effort` there is silently
  ignored. `turn/start`, by contrast, takes `effort` as a first-class param, and
  Chroxy sends it on **every** turn (like `model`) so a mid-session change takes
  effect and a seeded thread cannot drift back to the binary's default later.
- **Nothing is pushed on the switch itself.** There is no "set the effort" RPC
  that works on an idle thread, so a new level rides the next `turn/start`.
  (`turn/settings/update` changes the effort of a turn already running; it is
  deliberately not used.)
- **What the control shows before you touch it** is the effort codex resolved for
  itself at `thread/start` (from your `~/.codex/config.toml`), echoed back. If it
  echoed none, the control shows nothing rather than claiming a level nobody set.
- **The Claude magic keywords do nothing here.** `thinkingKeywords` is `false` on
  both codex drivers — typing `ultrathink` at codex is plain prose (#7725/#7735).

### Protocol version floor (0.128.0) and what each gate degrades to

The app-server's `initialize` handshake reports a `userAgent` like
`codex/0.154.0 (Mac OS 26.6.2; arm64) …`, and that is the **only** in-band version
signal — it describes the binary actually serving this session rather than
whatever `codex` is on `PATH`, which is why Chroxy never shells out to
`codex --version` here. The floor is **0.128.0**: every method Chroxy calls today
exists at that version (verified against `codex-rs/app-server-protocol` at tag
`rust-v0.128.0`). One gate sits above it — the per-turn `model` / `effort`
overrides are recorded at **0.154.0**, the lowest version this repo has evidence
for rather than the version they landed in.

Three rules govern the gate, and they are the reason a mismatch is rarely fatal:

1. **It gates FEATURES, never the connection.** Nothing here can refuse to start a
   session. A binary below the floor still starts a thread and still sends turns —
   the picker degrades instead.
2. **A cannot-check is not a no.** An absent or unparseable `userAgent` yields
   `unknown` for every gate, never `false`, and the caller falls through to a
   one-shot runtime probe that asks the binary itself.
3. **The probe switches on the error SHAPE, never on message text.** The live
   0.154.0 binary answers an unknown method with JSON-RPC `-32600`
   ("unknown variant"), **not** the `-32601` the spec would suggest, so any error
   response is treated as a degrade.

Concretely today, `supportsModelList` is the one gate with a consumer: a binary
known to be below the floor skips the per-session `model/list` refresh entirely
and the picker falls back to the labelled seed (source #5 above). The remaining
rows in the table are recorded for the features that will read them; nothing else
branches on them yet, so a below-floor binary behaves exactly like one whose
version could not be read.

### `CHROXY_CODEX_RECONNECT_DEADLINE_MS` env override (#6856 / #6967)

When codex's response stream drops mid-turn it emits `Reconnecting... N/5`
errors, and Chroxy keeps the turn open so codex can recover rather than failing
on a blip. Two backstops bound that wait: a 2-minute *silence* watchdog (codex
went quiet mid-reconnect) and a 5-minute *hard deadline* on total time spent in
the reconnect-suppressed state (codex reconnects forever without ever
recovering). The deadline is armed once, on entering suppression, and is
deliberately not pushed out by later reconnect ticks; when it fires the turn
fails with `stream_stall` so the client shows its normal retry affordance.

Set `CHROXY_CODEX_RECONNECT_DEADLINE_MS` on the server process to change that
5-minute hard deadline. The `reconnectDeadlineMs` session opt is the
programmatic equivalent and wins over the env var — but only when the opt is
itself in range, so a bogus opt falls through to the env value rather than
shadowing it:

| Value | Effect |
|---|---|
| _unset_ | Default. The deadline is 5 minutes. |
| `120001`–`1799999` | The supported window: the deadline is set to that many ms. |
| A number outside that window (including above the shared 24-hour sanity ceiling) | Logs a warning naming the window, then falls back to the 5-minute default. |
| Not a positive number at all — `abc`, `5m`, `0`, `-1` | Falls back to the 5-minute default **silently, with no warning**. |

That last row is worth knowing before you debug a deadline that "did not take":
the quiet reject for unparseable input is the shared behaviour of every
`CHROXY_*` timeout var (they all run through the same `isOperatorTimeoutInRange`
guard, which only warns on the over-ceiling case), so a mistyped value looks
exactly like an unset one. Note in particular that `5m` is **not** accepted here
— this var is plain milliseconds, not one of Chroxy's duration strings. If the
deadline is not what you set, check the spelling and units first.

The window is deliberately narrow and both ends are exclusive. It must stay
**above the 2-minute silence watchdog** — below it the deadline would beat the
silence path to every wedge, and it would also start killing turns inside
codex's own bounded retry burst — and **below the 30-minute default result
timeout**, since being a strictly-shorter bound than that timeout is the whole
point. An out-of-range value is rejected and logged rather than refusing to
start the server (#6967).

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

https://aistudio.google.com/apikey — export `GEMINI_API_KEY=...` (the provider also accepts `GOOGLE_API_KEY` as an alternative).

The provider hard-fails at `start()` only if **neither** a key (`GEMINI_API_KEY` / `GOOGLE_API_KEY`) **nor** `gemini login` OAuth state (cached under `~/.gemini/`, #4301) is present — with a running `gemini login` session, no env var is needed.

### Verify

```bash
gemini -p "hello" --output-format stream-json -y

GEMINI_API_KEY=... chroxy start --provider gemini
```

### Common pitfalls

- **`-y` (auto-approve) is always passed**: Chroxy invokes Gemini non-interactively. Permission handling is entirely bypassed — there are no Chroxy permission prompts because Gemini itself isn't asked.
- **Attachments error out**: sending a message with attachments emits a session-level error (`Gemini provider does not support attachments`).
- **Event format drift**: the `gemini-session.js` handler maps the most common `assistant` / `tool_result` / `result` events. Newer Gemini CLI releases may emit additional event types that Chroxy currently ignores.

## Ollama (local models)

Run sessions against **local open-source models** — no API key, no per-token cost, nothing leaves your machine. Requires Ollama **v0.14.0+**, which exposes an Anthropic-compatible Messages API that Chroxy drives through the same agent loop as the BYOK provider (streaming, tools, permission prompts, MCP servers, history).

### Install

```bash
# Install Ollama (https://ollama.com), then:
ollama serve                  # if not already running as a service
ollama pull qwen3-coder       # recommended coding model
ollama --version              # must be >= 0.14.0
```

### Use

```bash
chroxy start --provider ollama                       # default model: qwen3-coder
chroxy start --provider ollama --model glm-4.7       # any locally pulled model id
```

There is **no model allow-list**: whatever `ollama list` shows is valid. The dashboard picker seeds Ollama's recommended coder models (`qwen3-coder`, `glm-4.7`, `minimax-m2.1`); type any other pulled model id freely. An unknown id surfaces as Ollama's own error on the first message.

### Remote / non-default endpoints

Resolution order: `CHROXY_OLLAMA_BASE_URL` (full URL) → `OLLAMA_HOST` (Ollama's own convention; bare `host:port` is normalized to `http://`) → `http://localhost:11434`.

```bash
CHROXY_OLLAMA_BASE_URL=http://gpu-box:11434 chroxy start --provider ollama
```

### Common pitfalls

- **Ollama < 0.14.0**: the Anthropic-compatible endpoint doesn't exist — requests 404. Upgrade Ollama.
- **Ollama not running**: the session starts but the first message errors with a connection failure naming the endpoint. Start `ollama serve` and retry; the session recovers on the next message.
- **Small context windows**: the effective context is set by the local model file (`num_ctx`), not by Chroxy — long agentic sessions on small-context quantizations will truncate. Chroxy deliberately doesn't display a context-window chip for Ollama models.
- **Capability ≠ Claude**: tool-use quality depends entirely on the local model. The recommended coder models handle the agent loop well; small general models may loop or emit malformed tool calls.

## Anthropic-compatible endpoints (config-driven)

Many services and local inference servers now expose **Anthropic-compatible `/v1/messages` endpoints**: Z.ai (GLM), Moonshot (Kimi), MiniMax, **LM Studio 0.4.1+**, **llama.cpp server** (Jan 2026, requires `--jinja` for tools), **vLLM**, and **OpenRouter** (which accepts the Anthropic Messages format for *every* model on the platform). Instead of a hand-written session class per service, declare them under `providers.anthropicCompatible` in `~/.chroxy/config.json` — each entry registers a first-class provider at startup that drives the same agent loop as `claude-byok` (streaming, tools, permission prompts, MCP servers, history, cost).

### Entry shape

```json
{
  "providers": {
    "anthropicCompatible": [
      {
        "id": "zai-glm",
        "label": "Z.ai GLM",
        "baseUrl": "https://api.z.ai/api/anthropic",
        "apiKeyEnv": "ZAI_API_KEY",
        "credentialsKey": "zaiApiKey",
        "defaultModel": "glm-4.7",
        "models": ["glm-4.7", "glm-4.7-air"],
        "pricing": { "input": 0.6, "output": 2.2 },
        "contextWindow": 200000,
        "modelDiscovery": { "url": "https://openrouter.ai/api/v1/models", "format": "openrouter" }
      }
    ]
  }
}
```

| Field | Required | Meaning |
|-------|:--------:|---------|
| `id` | yes | Provider id (lowercase letters, digits, dashes; must start with a letter). Must not collide with a built-in id. Select it via `--provider zai-glm`, `CHROXY_PROVIDER`, or the dashboard. |
| `label` | no | Dashboard display label. Defaults to `id`. |
| `baseUrl` | yes | `http(s)` base URL of the endpoint. The Anthropic SDK appends `/v1/messages` itself. No embedded `user:pass@`. |
| `apiKeyEnv` | no | **NAME** of the environment variable holding the API key (e.g. `ZAI_API_KEY`). |
| `credentialsKey` | no | **NAME** of a field in `~/.chroxy/credentials.json` (mode `0600`) holding the key (e.g. `zaiApiKey`). Env var wins when both are set. Omit both for keyless local servers. |
| `defaultModel` | yes | Model used when none is selected. |
| `models` | no | Model **allowlist** for live model switching. Omit entirely for an unrestricted endpoint (any model id is passed through verbatim — the `ollama` rule; an unknown id surfaces as the endpoint's own error). |
| `pricing` | no | USD per million tokens: `{ "input", "output", "cacheRead", "cacheWrite" }` (missing rates default to 0). Omit for free/local endpoints — cost reports an honest $0. |
| `contextWindow` | no | Context window in tokens (dashboard chip). Omit when unknown — Chroxy never fabricates a window; the chip is simply hidden. |
| `modelDiscovery` | no | Live model-catalog discovery: `{ "url", "format" }`. `format` is `openrouter` (`GET /api/v1/models`, OpenAI-ish list with per-token pricing) or `openai` (bare `/v1/models`, ids only). A discovered catalog feeds the dashboard picker, **replaces** the static `models` allowlist for validation, and (openrouter) autofills per-model cost. See [OpenRouter](#openrouter) below. |

**Secrets never go in `config.json`.** `apiKeyEnv` / `credentialsKey` name *where* the key lives; an entry carrying a literal key (an `apiKey`/`token` field, a value that looks like `sk-...`, or `user:pass@` in the URL) is rejected at startup with a pointed warning. Invalid entries are skipped; valid siblings still register.

### Worked example: LM Studio (keyless local server)

LM Studio 0.4.1+ serves an Anthropic-compatible `/v1/messages` locally. llama.cpp server (`llama-server --jinja`) and vLLM expose the same surface — just change `baseUrl` and `defaultModel`:

```json
{
  "providers": {
    "anthropicCompatible": [
      {
        "id": "lm-studio",
        "label": "LM Studio (local)",
        "baseUrl": "http://localhost:1234",
        "defaultModel": "qwen3-coder-30b"
      }
    ]
  }
}
```

No `apiKeyEnv` / `credentialsKey` → no credential gate (a placeholder key is sent on the wire, which local servers ignore); no `pricing` → cost is always $0; no `models` → any loaded model id is accepted; no `contextWindow` → decided by the local model, so no chip is shown.

For **OpenRouter** — which accepts the Anthropic format for *every* model on the platform and adds live catalog discovery + per-model pricing — there's a one-command preset: see [OpenRouter](#openrouter) below.

### Use

```bash
ZAI_API_KEY=... chroxy start --provider zai-glm
chroxy start --provider lm-studio
```

### Caveats

- These compatibility layers are young — llama.cpp explicitly makes "no strong claims of compatibility". Probe streamed tool input (`input_json_delta`), parallel tool calls, and usage accounting against your specific server before relying on them.
- Tool-use quality depends entirely on the model behind the endpoint (same caveat as Ollama).
- Capabilities are identical to `claude-byok` by construction — see the [capability matrix](#capability-matrix) note.

## OpenRouter

[OpenRouter](https://openrouter.ai) aggregates hundreds of models behind one key and accepts the **Anthropic Messages format for every model on the platform** — so it drives the same agent loop as `claude-byok` (streaming, tools, permission prompts, MCP, history, cost). It's an [Anthropic-compatible endpoint](#anthropic-compatible-endpoints-config-driven) with first-class ergonomics: a preset, live model-catalog discovery, and per-model pricing autofill.

### Preset

```bash
chroxy providers add openrouter
```

This writes the `providers.anthropicCompatible` entry for you — `baseUrl https://openrouter.ai/api`, the `OPENROUTER_API_KEY` env seam (or the `openrouterApiKey` field in `~/.chroxy/credentials.json`, mode `0600`), a sensible default model, and the `modelDiscovery` block. It's **idempotent**: re-running leaves an existing entry untouched (`--force` rewrites it to the current preset).

Then provide your key and start:

```bash
export OPENROUTER_API_KEY=sk-or-...           # or save it as "openrouterApiKey" in ~/.chroxy/credentials.json (0600)
chroxy start --provider openrouter
```

### Model discovery

On session start (and on every `available_models` push) Chroxy probes `GET https://openrouter.ai/api/v1/models` and feeds the live catalog into the model picker — exactly like Ollama's `/api/tags` discovery. Results (success *and* failure) are cached for 5 minutes and concurrent callers share one in-flight request, so a reconnecting dashboard never hammers the endpoint. The catalog is large (hundreds of models); the dashboard picker supports filter/search to navigate it.

Discovery is **authoritative for validation**: once a catalog is in hand the discovered ids become the model allowlist for that provider (replacing the unrestricted pass-through), so an unknown id is rejected before it reaches OpenRouter. Until the first probe resolves (cold boot), the `defaultModel` works immediately and the endpoint stays unrestricted.

### Pricing autofill

OpenRouter's models endpoint reports per-token pricing. Chroxy converts it to its internal USD-per-MTok convention and applies it **per model**, so a session reports the real cost of the specific model in use instead of `$0` — no hand-authored `pricing` block needed. A model not present in the catalog (or a probe that hasn't run yet) falls back to the entry's flat `pricing` block, or an honest `$0` if none is configured.

### Caveats

- The same young-compatibility-layer caveats as any [Anthropic-compatible endpoint](#caveats) apply; tool-use quality depends on the model you route to.
- `modelDiscovery` generalizes beyond OpenRouter: any aggregator or local server exposing an OpenAI-format `/v1/models` (LM Studio, vLLM) can opt in with `"format": "openai"` (ids only, no pricing).

## OpenAI-compatible endpoints (config-driven)

The sibling of the [Anthropic-compatible block](#anthropic-compatible-endpoints-config-driven) for services that speak the **OpenAI Chat Completions API** instead of Anthropic's Messages API: **OpenAI** itself, **OpenRouter**, **LM Studio**, **vLLM**, **llama.cpp server**, **Together**, **Groq**, **DeepInfra**, or any custom proxy. Declare them under `providers.openaiCompatible` in `~/.chroxy/config.json` — each entry registers a first-class provider at startup that drives the same agent loop as `claude-byok` (streaming, tools, permission prompts, MCP servers, history, cost). Chroxy translates between its Anthropic-shaped agent loop and the OpenAI wire format internally, so the experience is identical to any other BYOK provider.

The entry shape is **identical** to [`providers.anthropicCompatible`](#anthropic-compatible-endpoints-config-driven) (validated by the same rules). The one operator-visible difference is the wire dialect of `baseUrl`:

- **`anthropicCompatible`** → `baseUrl` is an Anthropic base; the SDK appends `/v1/messages`. Example: `https://api.z.ai/api/anthropic`.
- **`openaiCompatible`** → `baseUrl` is an **OpenAI API base, typically ending in `/v1`**; the `openai` SDK appends `/chat/completions`. Examples: `https://openrouter.ai/api/v1`, `http://localhost:1234/v1` (LM Studio).

Pick the block that matches the dialect your endpoint actually serves. Some services (OpenRouter, LM Studio, vLLM, llama.cpp) expose **both** surfaces — either block works, so choose whichever you prefer; the only thing that changes is the `baseUrl` suffix.

### Entry shape

```json
{
  "providers": {
    "openaiCompatible": [
      {
        "id": "openrouter-oai",
        "label": "OpenRouter (OpenAI API)",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "credentialsKey": "openrouterApiKey",
        "defaultModel": "openai/gpt-4o-mini",
        "models": ["openai/gpt-4o", "openai/gpt-4o-mini"],
        "pricing": { "input": 0.15, "output": 0.6 },
        "contextWindow": 128000,
        "modelDiscovery": { "url": "https://openrouter.ai/api/v1/models", "format": "openrouter" }
      }
    ]
  }
}
```

| Field | Required | Meaning |
|-------|:--------:|---------|
| `id` | yes | Provider id (lowercase letters, digits, dashes; must start with a letter). Must not collide with a built-in id. Select it via `--provider openrouter-oai`, `CHROXY_PROVIDER`, or the dashboard. |
| `label` | no | Dashboard display label. Defaults to `id`. |
| `baseUrl` | yes | `http(s)` **OpenAI API base** URL, typically ending in `/v1`. The `openai` SDK appends `/chat/completions` itself. No embedded `user:pass@`. |
| `apiKeyEnv` | no | **NAME** of the environment variable holding the API key (e.g. `OPENROUTER_API_KEY`). |
| `credentialsKey` | no | **NAME** of a field in `~/.chroxy/credentials.json` (mode `0600`) holding the key (e.g. `openrouterApiKey`). Env var wins when both are set. Omit both for keyless local servers. |
| `defaultModel` | yes | Model used when none is selected. |
| `models` | no | Model **allowlist** for live model switching. Omit entirely for an unrestricted endpoint (any model id is passed through verbatim; an unknown id surfaces as the endpoint's own error). |
| `pricing` | no | USD per million tokens: `{ "input", "output", "cacheRead", "cacheWrite" }` (missing rates default to 0). Omit for free/local endpoints — cost reports an honest $0. |
| `contextWindow` | no | Context window in tokens (dashboard chip). Omit when unknown — Chroxy never fabricates a window; the chip is simply hidden. |
| `modelDiscovery` | no | Live model-catalog discovery: `{ "url", "format" }`. `format` is `openai` (bare `GET /v1/models`, ids only — LM Studio, vLLM) or `openrouter` (`GET /api/v1/models`, OpenAI-ish list with per-token pricing). A discovered catalog feeds the dashboard picker, **replaces** the static `models` allowlist for validation, and (openrouter) autofills per-model cost. |

**Secrets never go in `config.json`.** `apiKeyEnv` / `credentialsKey` name *where* the key lives; an entry carrying a literal key (an `apiKey`/`token` field, a value that looks like `sk-...`, or `user:pass@` in the URL) is rejected at startup with a pointed warning. Invalid entries are skipped; valid siblings still register. A malformed `openaiCompatible` entry names **its own block** in the error (not `anthropicCompatible`), so the message points you at the right config key.

### Worked example: LM Studio (keyless local server)

LM Studio serves an OpenAI-compatible `/v1/chat/completions` locally. vLLM and llama.cpp server (`llama-server`) expose the same surface — just change `baseUrl` (still ending in `/v1`) and `defaultModel`:

```json
{
  "providers": {
    "openaiCompatible": [
      {
        "id": "lm-studio-oai",
        "label": "LM Studio (OpenAI API)",
        "baseUrl": "http://localhost:1234/v1",
        "defaultModel": "qwen3-coder-30b",
        "modelDiscovery": { "url": "http://localhost:1234/v1/models", "format": "openai" }
      }
    ]
  }
}
```

No `apiKeyEnv` / `credentialsKey` → no credential gate (a placeholder key is sent on the wire, which local servers ignore); no `pricing` → cost is always $0; no `models` (the `openai` `modelDiscovery` above instead lists whatever models are loaded); no `contextWindow` → decided by the local model, so no chip is shown.

### Use

```bash
OPENROUTER_API_KEY=sk-or-... chroxy start --provider openrouter-oai
chroxy start --provider lm-studio-oai
```

### Caveats

- There is **no `providers add` preset** for the OpenAI block yet — hand-write the entry as above. (The [`providers add openrouter`](#openrouter) preset writes an **Anthropic-format** entry; OpenRouter accepts both dialects, so prefer that preset unless you specifically want the OpenAI wire format.)
- OpenAI-compatibility varies by server — probe streamed tool calls (`tool_calls` deltas), parallel tool calls, and usage accounting against your specific endpoint before relying on them.
- Tool-use quality depends entirely on the model behind the endpoint (same caveat as Ollama and the Anthropic-compatible block).
- Capabilities are identical to `claude-byok` by construction — see the [capability matrix](#capability-matrix) note.

## ACP agents (config-driven)

[Agent Client Protocol](https://agentclientprotocol.com) (ACP) is Zed's open protocol for driving a coding agent as a subprocess over stdio JSON-RPC — one client implementation talks to any conformant agent instead of a bespoke integration per agent. Declare one under `providers.acp` in `~/.chroxy/config.json` and it registers as a first-class provider at startup: `AcpSession` spawns the configured `command` **once** and holds the connection open for the session's lifetime (`initialize` + `session/new` happen once; every `sendMessage` is a `session/prompt` on the same persistent connection — not a new process per turn).

**Permissions are denied by default (#7319).** Every `session/request_permission` the agent sends is answered with a rejection — there is no config knob to change that yet, and no in-process permission bridge (`capabilities.permissions` / `inProcessPermissions` are both `false`). An agent that needs to run a command or edit a file will have that request declined. The real permission bridge lands in #7320.

### Entry shape

```json
{
  "providers": {
    "acp": [
      {
        "id": "my-agent",
        "label": "My Agent",
        "command": "/path/to/agent-cli",
        "args": ["--acp"],
        "env": { "MY_AGENT_API_KEY": "..." }
      }
    ]
  }
}
```

| Field | Required | Meaning |
|-------|:--------:|---------|
| `id` | yes | Provider id (lowercase letters, digits, dashes; must start with a letter). Must not collide with a built-in or already-registered id. Select it via `--provider my-agent`, `CHROXY_PROVIDER`, or the dashboard. |
| `label` | no | Dashboard display label. Defaults to `id`. |
| `command` | yes | Executable to spawn over stdio — an absolute path, or one resolvable on `PATH`. |
| `args` | no | Argv passed to the executable. Defaults to `[]`. |
| `env` | no | Extra environment variables for the child. **Unlike** `apiKeyEnv`/`credentialsKey` on the Anthropic/OpenAI-compatible blocks, this is a literal passthrough — ACP agents authenticate themselves, so there is no Chroxy-side credential to name. Defaults to `{}`. |

Unlike the ambient-environment posture of the `claude` CLI provider, the spawned agent gets an **allowlisted** environment (`PATH`, `HOME`, locale, proxy vars, …) plus Chroxy's host-identity metadata plus this `env` map — never the daemon's full environment, and never Chroxy's own bearer token, regardless of what `env` contains.

### Use

```bash
chroxy start --provider my-agent
```

### Caveats

- **No conversation continuity signal beyond the persistent connection itself** — Chroxy has no visibility into the agent's own context management.
- **No model switching** — the agent picks its own model; `modelSwitch` is `false`.
- **No plan mode, no resume, no thinking-level control, no `fs/*` / `terminal/*` bridging yet** (#7306 follow-up).
- **Permissions denied by default** (see above) — every tool call the agent wants to make is declined until #7320 lands.
- Translation onto Chroxy's outbound events covers `agent_message_chunk`, `agent_thought_chunk`, `tool_call` / `tool_call_update`, and `StopReason`. `plan`, `available_commands_update`, and `current_mode_update` are **not** translated (no matching existing wire event) and are silently dropped.

## Serving a new model without a release (`providers.allowAnyModel`)

Most of Chroxy's stack already lets a new model flow through with **no Chroxy release** the moment the provider's API exposes it:

- **Claude** (`claude-sdk`/`-cli`/`-tui`/docker) — the Agent SDK's live `supportedModels()` push refreshes the registry at runtime; a new `claude-*` id is servable immediately (a release is only needed for accurate *pricing*, which otherwise degrades to `cost=null`).
- **`anthropicCompatible` / `openaiCompatible`** endpoints — add a model via the config `models` array or live [model discovery](#model-discovery).
- **`ollama`** — any `ollama pull`ed id passes through; the local daemon validates.
- **`codex`** (since #7727) — the app-server's own `model/list` **is** the allowlist. Chroxy accepts exactly what the installed `codex` binary reports it can run, and accepts **anything** while it has not been able to ask. `providers.allowAnyModel: ["codex"]` is no longer needed to serve a new OpenAI model and should be removed from configs that carry it only for that reason — a codex setup that still needs it is evidence the catalog is not reaching the validator, not a working configuration.

The exception is the **static-allowlist subprocess providers — `gemini` and `deepseek`** — whose accepted models are a fixed list compiled into the provider class. By default an unlisted id is hard-rejected (so a Claude id sent to a Gemini session can't silently respawn the CLI with a bad `-m` arg). To call a model the provider's API supports but Chroxy's list doesn't carry yet, opt the provider into **unrestricted** validation:

```json
{
  "providers": {
    "allowAnyModel": ["gemini", "deepseek"]
  }
}
```

Listed providers then behave like `ollama`: an unlisted-but-API-valid model id passes through **verbatim** at both session creation and live `set_model`, and the **upstream API becomes the validator** (an id it doesn't recognize surfaces as the provider's own error on the next turn). The list is **per-provider** — opting in `gemini` does not loosen `deepseek`.

Notes:

- **Default OFF.** Omitting the key keeps the strict, misconfiguration-catching behaviour. Opt in only for providers whose API you track.
- **A restart is required** — the opt-in is read at startup (it seeds `SessionManager`).
- **Pricing/context** for an unlisted model is `null` until you add it to the model table or the [`~/.chroxy/models.json` overlay](guides/model-overlay.md) — serving still works; cost just reads `0`.
- **`codex` is still accepted here and still short-circuits both gates**, ahead of the catalog — the opt-out is kept deliberately (#7727) so an operator can bypass a catalog that is wrong or unreachable. It is just no longer the way to serve a new OpenAI model, and leaving codex listed while dogfooding will hide a catalog that never arrived.
- **The picker no longer offers seed rows a catalog has replaced** ([#7761](https://github.com/blamechris/chroxy/issues/7761)/[#7765](https://github.com/blamechris/chroxy/pull/7765)). The registry's fallback union — which used to re-add the hand-maintained seed ids (`gpt-4o`, `o1`, …) on top of every refresh, making them offered-then-refused — is now scoped to the Claude registry, along with the `[1m]` variant synthesis that minted a `gpt-4.1[1m]` chip no catalog contained. A discovered codex roster replaces at the wire, not just at validation. One residue, stated rather than implied: a pre-fix build **persisted** those ids to the model cache, and the cache is what boots — `loadCache` drops them on a non-Claude registry via a one-time migration ([#7776](https://github.com/blamechris/chroxy/issues/7776)), so they disappear at the next daemon start rather than the moment you upgrade.
- This is the runtime escape hatch for the remaining release-bound providers; codex maintains its own list via live discovery (#7726/#7727), and doing the same for `gemini`/`deepseek` is tracked separately.

## Selecting a provider

Precedence (highest first): CLI flag > environment variable > config file > default (`claude-tui`; see #5819).

### CLI flag

```bash
chroxy start --provider claude-cli
chroxy start --provider gemini
chroxy start --provider codex
```

### Environment variable

```bash
CHROXY_PROVIDER=gemini chroxy start
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

| Capability | `claude-sdk` | `claude-cli` | `claude-tui` | `claude-channel` | `codex` | `gemini` | `claude-byok` | `deepseek` | `ollama` |
|------------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **(capability)** Permissions (`canUseTool` / hook) | Yes | Yes | Yes (HTTP hook) | Yes (channel relay) | Yes (app-server) | — | Yes (in-process) | Yes (in-process) | Yes (in-process) |
| **(capability)** In-process permissions | Yes | — | — | — | Yes (app-server) | — | Yes | Yes | Yes |
| **(capability)** Live model switch | Yes | Yes | — | — | Yes | Yes | Yes | Yes | Yes |
| **(capability)** Live permission-mode switch | Yes | Yes (sidecar file) | Yes (sidecar file) | — | Yes (app-server) | — | Yes | Yes | Yes |
| **(capability)** Plan mode | — | **Yes** | — | — | — | — | — | — | — |
| **(capability)** Resume (`resumeSessionId`) | Yes | Yes | Yes | — | — | — | — | — | — |
| **(capability)** Terminal (raw PTY) | — | — | — | — | — | — | — | — | — |
| **(capability)** Thinking level control | Yes | — | — | — | Yes (app-server, per-model) | — | — | — | — |
| **(capability)** Thinking keyword escalation (`thinkingKeywords`) | Yes | — | — | — | — | — | — | — | — |
| **(capability)** Live streaming (`stream_delta`) | Yes | Yes | **No** (deliver-on-complete) | **Yes** | Yes | Yes | Yes | Yes | Yes |
| **(capability)** Skill toggle (`skillToggle` — live skill activate/deactivate) | Yes | — | — | — | — | — | Yes | Yes | Yes |
| **(behavioural)** Attachments (images, files) | Yes | Yes | — | — | Yes (app-server) | — | — | — | — |
| **(behavioural)** Agent tracking (spawned/completed) | Yes | Yes | — | — | — | — | Yes | Yes | Yes |
| **(behavioural)** Cost reporting (`result.cost`) | Yes | Yes | — | — | — | — | Yes (per-token API) | Yes (per-token API) | Yes (always $0) |
| **(behavioural)** Multi-session (SessionManager) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| **(behavioural)** Conversation continuity across messages | Yes (SDK state) | Yes (persistent process) | Yes (persistent PTY) | Yes (persistent session) | Yes (persistent thread) | **No** | Yes (in-memory history) | Yes (in-memory history) | Yes (in-memory history) |

> **The `codex` column is the DEFAULT app-server driver** (`CodexAppServerSession`), the class `getProvider('codex')` returns unless `CHROXY_CODEX_APPSERVER=0` opts out (#6616). Cells marked *(app-server)* are exactly the ones the legacy `codex exec` driver (`CodexSession`) reports as `false`: permissions, in-process permissions, permission-mode switch, thinking-level control, and attachments. Everything else in the column is identical on both drivers — including **conversation continuity**, which the exec driver keeps by resuming its own thread on every turn (`codex exec resume <id>`, #3865) rather than by holding a process open.

> The `claude-byok`, `deepseek`, and `ollama` columns share one session class — `deepseek-session.js` and `ollama-session.js` subclass `ClaudeByokSession` (`byok-session.js`), overriding only credentials, endpoint, model registry, and pricing — so their **(capability)** rows are identical by construction. Behaviourally they differ in cost reporting: `claude-byok` and `deepseek` compute real per-token API cost from their pricing tables, while `ollama` reports an honest $0 (local inference). Attachments are dropped with a session-level error ("does not yet materialise attachments") on all three; in-memory history means continuity within the server process but no cross-restart resume (`resume: false`, tracked in #4047).
>
> [Config-driven Anthropic-compatible endpoints](#anthropic-compatible-endpoints-config-driven) (#5419 — Z.ai GLM, Moonshot Kimi, MiniMax, LM Studio, llama.cpp, vLLM, OpenRouter, custom) are generated subclasses of the same `ClaudeByokSession`, so they **share the `claude-byok` capability column** exactly. Cost reporting follows the entry's `pricing` block: per-token API cost when declared, an honest $0 when omitted (local endpoints).

For capability rows, "—" means the provider's `capabilities` object reports `false` (or omits the key — e.g. only `claude-sdk` and the BYOK family declare `skillToggle` — plus `docker-sdk` / `docker-byok`, which spread the parent class's capabilities: they rebuild the system prompt every turn, so toggling a skill takes effect on the next message; subprocess providers snapshot the skills text at session start). For behavioural rows, "—" means the feature is unimplemented (the session class throws or emits a `not supported` error, or silently no-ops). Most provider-agnostic UI (session tabs, chat/terminal dual view, push notifications, conversation search, web dashboard) works across all providers.

> The `claude-channel` column reflects the provider's declared `capabilities`
> object and the spike's verified protocol contract — **not** runtime behaviour,
> since the session backend is a scaffold that doesn't run yet (`start()`
> throws). The `permissions` / `streaming` cells describe what the channel
> protocol provides once the bridge (#3954) and permission relay (#3955) land.
> Behavioural cells (attachments, agent tracking, cost reporting) are listed as
> unimplemented because nothing exercises them yet. Conversation continuity is
> inherent to the channel transport (it pushes into one persistent interactive
> session). See [`claude-channel`](#claude-channel-research-preview) and the
> [spike's capability matrix](architecture/claude-channels-provider-spike.md#capability-matrix-proposed-from-sub-2).

> **Config-driven ACP agents** (#7319 — [see above](#acp-agents-config-driven)) don't share a column with any existing provider: `permissions` and `inProcessPermissions` are both `false` (deny-all, no bridge yet — #7320), `modelSwitch` / `permissionModeSwitch` / `planMode` / `resume` / `terminal` / `thinkingLevel` / `thinkingKeywords` are all `false` (the agent picks its own model; Chroxy has no visibility into or control over the rest), and `streaming` is `true`. Behaviourally: attachments are refused (not yet implemented), conversation continuity holds for the lifetime of the persistent connection (one child process, many turns — not per-message like `codex`/`gemini`), and cost reporting is unimplemented (no pricing concept for an arbitrary agent).

## Known limits

### `claude-sdk`

- **No plan mode** — use `claude-cli` instead.
- Depends on `@anthropic-ai/claude-agent-sdk` being installed (comes with `packages/server` dependencies by default).

### `claude-cli`

- **No thinking-level control** — SDK-only feature.
- Requires the `claude` binary to be installed and executable.

### `claude-tui`

- **Subscription only** — `ANTHROPIC_API_KEY` is explicitly stripped from the spawn env. Auth via `claude login`; no API-key fallback.
- **No live streaming** — the response is delivered as one `stream_start` → `stream_delta` → `stream_end` burst when Claude's `Stop` hook fires. No incremental token streaming inside a turn.
- **No live model switch, no plan mode, no thinking-level control, no attachments, no agent tracking, no cost reporting** — `result.cost` is emitted as `0` (a placeholder, not parsed from the Stop hook) and `result.usage` is `null` (the Stop hook payload doesn't expose either).
- **One PTY per session** — pays a ~3.5s warmup cost on `start()`, then every `sendMessage` writes to the same PTY. Concurrent sessions in the same `cwd` are not protected against each other; treat as one session per repo.
- **Tool events are reconstructed from `PreToolUse` / `PostToolUse` hooks** — `tool_use_id` is taken from the hook payload when present, otherwise synthesized per turn (`<messageId>-tool-N`). Pre/Post pairing breaks if tool calls overlap or a Pre fires without a matching Post.
- **Hook payloads write to a per-session directory under `tmpdir()/chroxy-claude-tui/s-<uuid>/`**. Cleaned up on `destroy()`.

### `claude-channel`

- **Scaffold — not yet runnable.** The provider is registered (#3953) so the
  registry lists it and `chroxy doctor` runs its preflight, but `start()` /
  `sendMessage()` / `interrupt()` throw "not yet implemented". The live bridge
  (spawn `claude --channels` + IPC round-trip) lands in #3954. Selecting it
  today fails fast with a clear error — it never spawns a PTY or MCP child.
- **Research preview, protocol may change.** Anthropic documents the channels
  contract as a research preview that "may change based on feedback". Treat each
  Claude Code minor bump as a smoke-test trigger; `claude-tui` is the stable
  subscription-billed fallback.
- **Requires `claude` ≥ 2.1.80** for the `--channels` transport (≥ 2.1.81 for
  the permission relay, which lands with #3955). The scaffold preflight gates on
  the 2.1.80 floor only.
- **Requires `--dangerously-load-development-channels`** until a
  marketplace-approved `chroxy-channel` plugin exists. The flag bypasses only
  the channel allowlist, not org policy. See
  [`PACKAGING.md`](../packages/server/src/channels/PACKAGING.md) for the path
  that removes it.
- **Subscription only** — `ANTHROPIC_API_KEY` is not accepted (subscription /
  OAuth auth, same as `claude-tui`). Bills the same way as `claude-tui` — best-effort,
  not guaranteed (see its billing caveat).
- **No live model switch, no permission-mode switch, no plan mode, no resume,
  no thinking-level control** — the channel surface does not expose these
  (same gaps as `claude-tui`, except `claude-tui` fakes permission-mode via a
  sidecar file — as `claude-cli` also does since #7337 — and resumes across
  restarts via `--resume`). The channel's wins
  over `claude-tui` are live streaming and a
  documented first-party permission relay.
- **Not available on Bedrock / Vertex / Foundry**, and Team/Enterprise orgs
  must enable `channelsEnabled` in managed settings.

### `codex`

Both drivers:

- **No plan mode** — codex has no plan enforcement; the `plan` permission mode behaves like `approve`.
- **No resume across a daemon restart** — a restored session starts a fresh thread (`resume: false` on both classes), so a restart loses the transcript even though memory holds *within* a session.
- **No cost reporting** — `result.cost` is always `null`. Token usage is emitted when the binary reports it.
- **No agent tracking** (spawned/completed sub-agent events) and **no skill toggle**.
- **No context window until a turn has run**, unless the Codex CLI's own cache names one — see [The context window and the meter](#the-context-window-and-the-meter).
- **The model roster is the installed binary's**, not a Chroxy release — an old binary, or one that cannot be asked, leaves you on the labelled seed rows. See [Where the model list comes from](#where-the-model-list-comes-from-modellist).

Default app-server driver only:

- **No conversation id is surfaced** — `resumeSessionId` is deliberately left unset (#6608): `capabilities.resume` is `false`, and `SessionManager` would otherwise persist it as the conversation id. Downstream features that key off a session id are therefore unavailable on this path, even though the thread itself is live.
- **A deny reason does not reach the model** — the approval RPC response carries only the decision, so free-text you type when denying is dropped (`denyReason: false`; tracked in #6885).
- **No Chroxy session rules** — "always allow" maps to codex's *own* session-scoped grant, not a persisted Chroxy rule, and `shell` / sandbox escalations can never be rule-whitelisted. See [the permission model](design/codex-permission-model.md).

Legacy `codex exec` driver only (`CHROXY_CODEX_APPSERVER=0`):

- **No permission handling** — it reports `permissions: false`. Tools run under whatever policy Codex's own sandbox enforces; there is no Chroxy approval prompt.
- **No permission-mode switching and no reasoning-effort control.**
- **Attachments are rejected** — an attachment on this path is a session-level error.
- It does keep **intra-session memory**: each turn is a fresh subprocess that resumes the same thread via `codex exec resume <id>` (#3865), and it *does* report that thread id as the session id — the opposite of the app-server path above.

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

### *(config-driven)* ACP agents

- **Permissions are denied by default** (#7319) — no in-process bridge yet (#7320). Every tool call the agent requests is declined.
- **No model switching, no plan mode, no resume, no thinking-level control.**
- **No `fs/*` / `terminal/*` bridging yet** — an agent that needs filesystem or terminal access via those ACP methods will not get it (#7306 follow-up).
- **No attachments, no agent tracking, no cost reporting.**
- **`plan` / `available_commands_update` / `current_mode_update` are dropped** — no matching existing outbound event; translating them would require new `@chroxy/protocol` wire types, deferred to a follow-up.
- **Manual QA against a real third-party agent is tracked separately** via `/qa-update` — CI proves the round-trip against a scripted fixture only, never a live agent (no new secret surface, no dependency on a third party's uptime).

## See also

- [`packages/server/CONFIG.md`](../packages/server/CONFIG.md) — full list of config keys and precedence rules.
- [`docs/feature-matrix.md`](feature-matrix.md) — client-side feature availability across Mobile / Desktop / Server.
- [`docs/troubleshooting.md`](troubleshooting.md) — connection, tunnel, and permission-hook issues.
- [`packages/server/src/providers.js`](../packages/server/src/providers.js) — provider registry (literal map of built-ins).
