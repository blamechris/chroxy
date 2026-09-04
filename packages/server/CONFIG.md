# Configuration Guide

Chroxy supports configuration from multiple sources with a clear precedence order.

## Precedence Order

Configuration values are resolved in the following order (highest priority first):

1. **CLI flags** - Command-line options passed to `npx chroxy start`
2. **Environment variables** - System environment variables
3. **Config file** - `~/.chroxy/config.json` (created with `npx chroxy init`)
4. **Defaults** - Built-in default values

## The config root (`CHROXY_CONFIG_DIR`)

`~/.chroxy` is the **default** config/state root, not a fixed one.
`CHROXY_CONFIG_DIR` relocates the **entire** root, so **every `~/.chroxy/…` path
in this document — and in every other doc — means `$CHROXY_CONFIG_DIR/…` when the
variable is set.** That covers `config.json`, `credentials.json`, the daemon
identity key, `session-state.json`, `logs/`, `pages/`, `worktrees/`,
`snapshots/`, and the trust ledgers.

```bash
CHROXY_CONFIG_DIR=/mnt/state npx chroxy start   # reads /mnt/state/config.json
```

Three properties are worth knowing before you set it:

- **It must be an absolute path.** A relative value is **refused**, not resolved:
  the daemon warns and falls back to `~/.chroxy`. Because the root is read per
  filesystem call, resolving a relative value would scatter `credentials.json`,
  the identity key and the trust ledgers into whatever directory the daemon
  happened to be launched from — a git working tree, if you ran `chroxy start`
  from a repo. Absoluteness is Node's `path.isAbsolute()`, which on **Windows**
  also accepts a root-relative `\data` or `/data` (no drive letter needed); the
  desktop app matches that rule deliberately rather than using Rust's stricter
  one, since the two disagreeing is itself a split-brain (#7241).
- **It is env-only, and read directly** rather than through the merge layer
  (see [Environment variable names](#environment-variable-names)). It cannot be a
  `config.json` key, because it is what locates `config.json` in the first place.
- **Relocating an existing install does not move your state.** The daemon warns
  at startup, `chroxy doctor` reports it, and the copy is opt-in:

  ```bash
  chroxy config-dir status          # resolved root + anything stranded at ~/.chroxy
  chroxy config-dir migrate --yes   # copy the stranded state forward (never overwrites)
  ```

  The copy is deliberately opt-in: the daemon cannot tell "just relocated, wants
  their state" from "deliberately clean root", and copying an identity key into a
  possibly shared, synced or bind-mounted volume is the operator's call (#7240).

Internally the root has exactly one resolver — `configDir()` / `configPath()` in
[`src/config-dir.js`](src/config-dir.js) — and both read the environment **per
call**, because a module-scope `const` freezes at import and silently ignores the
override. That is not hypothetical: it relocated only half the daemon's state for
as long as the copies existed (#7052). A CI lint
(`scripts/lint-config-dir.mjs`) keeps it to one resolver.

Two live resolvers sit outside that lint's walk by design, and both honour the
variable: [`packages/protocol/src/project.ts`](../protocol/src/project.ts) (the
worktrees root) and [`scripts/docker-entrypoint.sh`](../../scripts/docker-entrypoint.sh).
`packages/claude-hooks` is zero-runtime-dependency and cannot import the server's
accessor, so it carries one reviewed copy of the same `||` fallback.

## Configuration Keys

Every key below is a real entry in `CONFIG_SCHEMA`
([`packages/server/src/config.js`](src/config.js)) — that object is the
authoritative list, and anything not in it triggers an `Unknown config key`
warning at startup and is ignored.

The tables are grouped for readability only; every key lives at the **top level**
of `~/.chroxy/config.json` regardless of which group it appears in.

### Core server

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `apiToken` | string | - | `API_TOKEN` | Authentication token for clients |
| `port` | number | - | `PORT` | Local WebSocket port (default: 8765). Range `1`–`65535`. |
| `host` | string | `--host <address>` | `CHROXY_HOST` | Bind address for the server socket. Unset binds `0.0.0.0` (all interfaces) so the mobile app / LAN clients can reach it. Set to `127.0.0.1` for a loopback-only bind that keeps auth enabled — opt-in defence-in-depth for single-device setups. `--no-auth` always forces loopback regardless of this key. When bound to loopback the mDNS `_chroxy._tcp` advertisement is suppressed (the server is not LAN-reachable). |
| `cwd` | string | `--cwd <path>` | `CHROXY_CWD` | Working directory (CLI mode) |
| `noAuth` | boolean | `--no-auth` | `CHROXY_NO_AUTH` | Disable authentication (localhost only) |
| `externalUrl` | string | - | `CHROXY_EXTERNAL_URL` | Public URL clients should use instead of a Cloudflare tunnel — for operators who front the daemon with their own reverse proxy / VPN / ingress. When set, tunnel startup **and** the supervisor are skipped. Must parse as a URL with an `http:` or `https:` scheme; a malformed value warns at startup. |
| `showToken` | boolean | `--show-token` | `CHROXY_SHOW_TOKEN` | Print the full API token in the terminal connect block instead of a masked prefix. Off by default so a shared screen / recorded terminal doesn't leak the token. |
| `logFormat` | string | `--log-format <format>` | `CHROXY_LOG_FORMAT` | Log output format: `text` (default) or `json`. Any value other than the literal `json` keeps the human-readable text logger. |
| `maxRestarts` | number | `--max-restarts <count>` | `CHROXY_MAX_RESTARTS` | Max consecutive child restarts the supervisor attempts before giving up and exiting (default `10`). Only applies in supervisor mode (the default for `chroxy start` with a tunnel). |
| `terminalDownGraceMs` | number | - | `CHROXY_TERMINAL_DOWN_GRACE_MS` | How long the supervisor keeps serving a terminal `status: "down"` health response (reason `supervisor_gave_up`) after exhausting `maxRestarts`, before exiting — long enough for a polling client to latch the terminal state instead of seeing a bare connection refusal (#6022). Default `15000` (15 s); `0` restores the pre-#6022 exit-immediately behaviour. |
| `noEncrypt` | boolean | `--no-encrypt` | `CHROXY_NO_ENCRYPT` | Disable end-to-end message encryption (dev/testing only). Transport TLS from the tunnel still applies, but message payloads are no longer encrypted between client and daemon. |
| `encryptLocalhost` | boolean | - | `CHROXY_ENCRYPT_LOCALHOST` | Force E2E encryption on loopback connections too, disabling the localhost plaintext bypass unconditionally (#6564). Off by default — the bypass is already auto-disabled whenever a tunnel is active. |
| `tokenExpiry` | string | - | `CHROXY_TOKEN_EXPIRY` | Rotation lifetime for the **primary API token** (`24h`, `7d`, …). When set, the token manager rotates the token on expiry and honours a short grace window for the previous value. Unset (the default) means the primary token never expires. Distinct from `sessionTokenTtl`, which governs *paired device* session tokens. |
| `sessionTokenTtl` | string | - | `CHROXY_SESSION_TOKEN_TTL` | *(default `30d`)* How long a paired device's session token stays valid without reconnecting (#6598). **Sliding** — each successful connect refreshes it, so only an *idle* device expires. A duration string (`30d`, `15d`, `12h`); floored at 5 min. Tokens are persisted encrypted at rest (`~/.chroxy/session-tokens.json`), so they now survive daemon restarts. Longer = fewer re-pairs but a wider stolen-token window; you own the dial. |
| `repos` | array | - | `CHROXY_REPOS` | Explicit list of git repository paths the Control Room surveys and `chroxy worktree gc` sweeps. Unioned with the repos auto-discovered under [`controlRoomRoot`](#control-room) — an explicit entry is never dropped even if it lives outside that root. |

### Sessions, history, and limits

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `maxSessions` | number | - | `CHROXY_MAX_SESSIONS` | Maximum concurrent sessions (default `5`). Creating one past the cap is rejected with `SESSION_LIMIT_REACHED`. Must be ≥ 1. |
| `maxMessages` | number | `--max-messages <count>` | `CHROXY_MAX_MESSAGES` | Messages retained per session before FIFO eviction (default `1000`). |
| `maxHistory` | number | - | `CHROXY_MAX_HISTORY` | Legacy alias for `maxMessages`. `maxMessages` wins when both are set; prefer the canonical key. |
| `maxPayload` | number | `--max-payload <bytes>` | `CHROXY_MAX_PAYLOAD` | WebSocket max message size in bytes. **Effective default `10485760` (10 MB)** — large enough for image / document attachments. Range `1024` (1 KB) – `104857600` (100 MB); values outside it warn at startup. |
| `maxToolInput` | number | `--max-tool-input <bytes>` | `CHROXY_MAX_TOOL_INPUT` | Maximum tool-input size in bytes before the input is truncated and a notice is surfaced in the transcript. Default `262144` (256 KB). |
| `sessionTimeout` | string | `--session-timeout <duration>` | `CHROXY_SESSION_TIMEOUT` | Idle-session timeout as a duration string (`2h`, `30m`). **Disabled by default.** Minimum 30 s; a malformed duration or a sub-30s value warns at startup. This is a plain idle reaper — distinct from the [inactivity safety net](#inactivity-safety-net), which measures silence *within* a running turn. |
| `costBudget` | number | `--cost-budget <dollars>` | `CHROXY_COST_BUDGET` | Per-session cost budget in dollars. Applied independently to each session (not a shared pool across sessions). Warns at 80%, pauses the session at 100%. |
| `summarize` | object | - | `CHROXY_SEMANTIC_TITLES_MODEL`, `CHROXY_SEMANTIC_TITLES_TIMEOUT_MS` *(title path only)* | Optional override for one-shot summarizer calls (#5547): `{ provider?: string, model?: string, titleTimeoutMs?: number }`. `model` makes the sidebar "Summarize & start new session" action use a cheaper model than the target session's own; `provider` is accepted for forward-compat but the one-shot path currently always runs through the SDK provider. `titleTimeoutMs` is read by the semantic-title path — see [Semantic session titles](#semantic-session-titles-featuressemantictitles). Unset ⇒ summarize with the session's own model. |
| `transforms` | array | - | `CHROXY_TRANSFORMS` | Opt-in prompt pre-processing pipeline, as a list of built-in transform names applied in order to each outgoing user message. Built-ins: `contextAnnotation` (prefixes `cwd` / `model` / `git branch` / `platform` as ambient context, skipped for messages under 10 chars) and `voiceCleanup` (strips voice-to-text filler words and normalises punctuation — only fires when the message was flagged as voice input). Empty / unset ⇒ messages pass through unchanged. |
| `sandbox` | object | - | `CHROXY_SANDBOX` | SDK sandbox settings forwarded verbatim to sessions for lightweight in-process isolation. Unset ⇒ no sandbox opts are threaded. Unrelated to the Codex per-session `codexSandbox` wire field and to the Docker/K8s [`environments`](#environments-isolation-and-worktrees) backends. |
| `promptEvaluatorSkipPattern` | string | - | *(unmapped — see [note](#environment-variable-names))* | Per-session regex source (case-insensitive) extending the default skip list used by the prompt evaluator's trivial-message heuristic. See [Prompt evaluator skip heuristic](#prompt-evaluator-skip-heuristic) below. |

### Timeouts

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `resultTimeoutMs` | number | - | `CHROXY_RESULT_TIMEOUT_MS` | Per-session **soft-warning** inactivity window in milliseconds. When no SDK / CLI event arrives within this window, the server emits an `inactivity_warning` event (#3899) so clients can render a check-in chip and surface a push notification — the session stays alive. The kill path is `hardTimeoutMs` (below). See [Inactivity safety net](#inactivity-safety-net). Default `1800000` (30 min); range `30000`–`86400000` (30 s – 24 h). |
| `hardTimeoutMs` | number | - | `CHROXY_HARD_TIMEOUT_MS` | Per-session **hard-kill** inactivity window in milliseconds. When `resultTimeoutMs` has already fired and silence continues to this longer threshold, the server emits `permission_expired` for every outstanding permission prompt, force-clears busy state, and emits a generic `error` event with `"Response timed out after <duration> of inactivity"` (#3899). Default `7200000` (2 h); range `30000`–`86400000` (30 s – 24 h). Must be ≥ `resultTimeoutMs` or the soft warning never fires — validator warns. |
| `streamStallTimeoutMs` | number | - | `CHROXY_STREAM_STALL_TIMEOUT_MS` | Stream-stall recovery window in ms (#4467). Resets on any stream activity from the child; when silence reaches this window *while the session is busy*, the session emits a recoverable error (`code: stream_stall`), clears busy state, and clients can offer a retry. Default `300000` (5 min); range `5000`–`86400000` (5 s – 24 h), or `0` to disable for operators with legitimately long event gaps. |
| `providerStreamStallTimeoutMs` | object | - | `CHROXY_PROVIDER_STREAM_STALL_TIMEOUT_MS` | Per-provider override map for `streamStallTimeoutMs`, keyed by provider id — e.g. `{ "codex": 900000, "gemini": 600000 }`. An entry wins over the global value for sessions on that provider; providers without an entry fall through to the global value. Each entry follows the same `5000`–`86400000`-or-`0` range; a bad entry warns and is dropped (falling back to the global value) rather than failing startup. As an env var, pass JSON: `CHROXY_PROVIDER_STREAM_STALL_TIMEOUT_MS='{"codex":900000}'`. |
| `backgroundShellHardQuiesceMs` | number | - | `CHROXY_BACKGROUND_SHELL_HARD_QUIESCE_MS` | How long a background shell (`Bash` with `run_in_background: true`) may go with **no new output** before the server treats it as finished and **reaps** its liveness tracking, so a finished-but-never-polled command stops pinning the session `running` forever (#5265). Default `14400000` (4 h); range `60000`–`86400000` (60 s – 24 h), or **`0` to disable** hard-reaping (advisory-only, the #5247 behaviour). **Tradeoff:** a genuinely long-running compute that emits no output for hours (and is never polled via `BashOutput`) could have its tracking reaped and the session become idle-timeout-eligible. A noisy long-runner (e.g. a dev server logging within the window) keeps its output-file mtime fresh and is never reaped. Operators running long silent computes should raise this (e.g. 6–8 h) or set `0`. |
| `mcpToolCallTimeoutMs` | number | - | `CHROXY_MCP_TOOL_CALL_TIMEOUT_MS` | Per-call timeout for MCP `tools/call` requests made by BYOK sessions (#4482). Default `30000` (30 s). Range `1000` (1 s) – `600000` (10 min) — below 1 s every realistic MCP server times out, above 10 min the conversation is already lost. Unlike `streamStallTimeoutMs`, `0` is **not** a disable sentinel: any non-positive value warns and the runtime falls back to the 30 s client default. |

### Tunnel and remote access

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `tunnel` | string | `--tunnel <mode>` | `CHROXY_TUNNEL` | Tunnel mode: `quick` (default — random Cloudflare URL, no account), `named` (stable hostname, requires a Cloudflare account + `cloudflared login`), `none`, or a `provider:mode` pair such as `cloudflare:named`. Ignored when `--no-auth` or `externalUrl` is in play. |
| `tunnelName` | string | `--tunnel-name <name>` | `CHROXY_TUNNEL_NAME` | Named-tunnel name (requires `cloudflared login`). Only meaningful with `tunnel: "named"`. |
| `tunnelHostname` | string | `--tunnel-hostname <host>` | `CHROXY_TUNNEL_HOSTNAME` | Named-tunnel public hostname, e.g. `chroxy.example.com`. Only meaningful with `tunnel: "named"`. |
| `tunnelConfig` | object | - | `CHROXY_TUNNEL_CONFIG` | Extra provider options spread into the tunnel provider's start call — an escape hatch for `cloudflared` knobs that have no dedicated key. As an env var, pass JSON. See [../../docs/named-tunnel-guide.md](../../docs/named-tunnel-guide.md). |

### Providers and models

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `provider` | string | `--provider <name>` | `CHROXY_PROVIDER` | Default session backend. Allowed values: `claude-tui` (default, #5819), `claude-sdk`, `claude-cli`, `claude-channel` (research preview), `gemini`, `codex`, plus `docker-sdk` / `docker-cli` when Docker environments are enabled. The `claude-channel` provider is a research-preview scaffold whose `start()` currently throws — selectable for `chroxy doctor` / registry inspection but not yet runnable (bridge lands in #3954). See [../../docs/providers.md](../../docs/providers.md) for per-provider setup, env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …), and the capability matrix. |
| `model` | string | `--model <name>` | `CHROXY_MODEL` | Model to use. Provider-specific — e.g. `claude-sonnet-4`/`haiku` for Claude, `gemini-2.5-pro` for Gemini, `gpt-5.4` for Codex. |
| `providers` | array \| object | - | `CHROXY_PROVIDERS` | Two forms. **Array** (legacy, written by `chroxy init`): informational list of provider ids the user opted into. **Object** (#5419): `providers.anthropicCompatible` is an array of config-driven Anthropic-compatible endpoint entries (Z.ai GLM, Moonshot Kimi, MiniMax, LM Studio, llama.cpp, vLLM, OpenRouter, custom) — each entry `{ id, label?, baseUrl, apiKeyEnv?, credentialsKey?, defaultModel, models?, pricing?, contextWindow? }` registers a first-class provider at startup, selectable via `provider` / `--provider <id>`. API keys are **never** inlined: `apiKeyEnv` names an env var, `credentialsKey` names a `~/.chroxy/credentials.json` field (mode `0600`); entries carrying literal secrets are rejected. Invalid entries are warned about and skipped; valid siblings still register. The object form carries three more sub-blocks: `providers.openaiCompatible` — the identical entry shape for endpoints that speak the **OpenAI Chat Completions** API instead (OpenAI, OpenRouter, LM Studio, vLLM, llama.cpp, Together, Groq, DeepInfra, custom), where `baseUrl` is an OpenAI API base typically ending in `/v1`; `providers.acp` (#7319) — an array of config-driven **Agent Client Protocol** agents, each entry `{ id, label?, command, args?, env? }` spawning an arbitrary ACP-speaking agent over stdio, permissions **denied by default** (no bridge yet — #7320); and `providers.allowAnyModel`, see [Unrestricted provider models](#unrestricted-provider-models-providersallowanymodel). See [Anthropic-compatible endpoints](../../docs/providers.md#anthropic-compatible-endpoints-config-driven), [OpenAI-compatible endpoints](../../docs/providers.md#openai-compatible-endpoints-config-driven), and [ACP agents](../../docs/providers.md#acp-agents-config-driven). |
| `legacyCli` | boolean | `--legacy-cli` | `CHROXY_LEGACY_CLI` | Legacy shorthand that maps to `provider: "claude-cli"` when no explicit `provider` is set. Prefer setting `provider` directly; an explicit `provider` always wins. |

### Permissions and security gates

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `allowedTools` | array | `--allowed-tools <list>` | `CHROXY_ALLOWED_TOOLS` | Auto-approved tools (CLI mode) |
| `dangerouslySkipPermissions` | boolean | `--dangerously-skip-permissions` | `CHROXY_DANGEROUSLY_SKIP_PERMISSIONS` | Server-wide default for the per-session skip-permissions flag (#4246, #4384). Honoured only by the `claude-tui` provider — spawns claude with `--dangerously-skip-permissions` and elides chroxy's permission hook. Off by default. Legacy alias `skipPermissions` (config key) and `CHROXY_SKIP_PERMISSIONS` (env var) are still honoured for one deprecation window and emit a warning at boot — rename to the canonical key. See [Skip permissions (TUI provider)](#skip-permissions-tui-provider) below. |
| `skipPermissions` | boolean | - | `CHROXY_SKIP_PERMISSIONS` | **Deprecated** alias for `dangerouslySkipPermissions`, kept in the schema so an existing config file still validates cleanly. Setting it emits a rename warning at boot even when the canonical key is also present. See [Skip permissions (TUI provider)](#skip-permissions-tui-provider). |
| `allowAutoPermissionMode` | boolean | - | *(unmapped — see [note](#environment-variable-names))* | Gates the `auto` permission mode (bypass every permission check). Off by default so fresh installs are secure-by-default: a client that tries to flip to `auto` is rejected with `AUTO_MODE_DISABLED_BY_CONFIG`. Opting in is a deliberate edit on the dev machine — physical access stands in for real user confirmation. |
| `userShell` | object | - | *(unmapped — see [note](#environment-variable-names))* | Gate for the embedded user-shell terminal, which spawns the operator's `$SHELL` (arbitrary code execution on the dev machine, reachable through the tunnel). `{ enabled?: boolean, requireApproval?: boolean }`, both **off by default** — creating a `user-shell` session is rejected with `USER_SHELL_DISABLED` until `enabled` is literally `true`. `requireApproval: true` additionally demands host-local approval per spawn (#6277). See [Nested config blocks](#nested-config-blocks-at-a-glance). |
| `workspaceRoots` | array | - | *(unmapped — see [note](#environment-variable-names))* | Allowlist of absolute directory paths a session may use as its working directory. When set and non-empty, a session `cwd` must resolve (via `realpath`) inside one of these roots or creation is rejected. When unset/empty, the legacy "must be inside `$HOME`" check applies instead. The credential-directory deny-list is defence-in-depth and stays active in **both** modes. |
| `allowedDockerImages` | array | - | *(unmapped — see [note](#environment-variable-names))* | Allowlist of Docker image patterns `create_environment` may use. Each entry is an exact image name or a prefix pattern such as `mcr.microsoft.com/devcontainers/*`. When set, a client-supplied image must match at least one entry or the request is rejected with `DOCKER_IMAGE_NOT_ALLOWED`. When unset, a built-in default list of common base images applies. |
| `binaryProvenance` | object | - | `CHROXY_BINARY_PROVENANCE`, `CHROXY_BINARY_SIGNATURE_GATE` | Opt-in provenance verification for spawned provider binaries (`claude`, `codex`, `gemini`, `cloudflared`). `mode` (`off`/`warn`/`block`) drives a cross-platform SHA-256 pin ledger; `signatureGate` (boolean) toggles a macOS `spctl` notarization gate. Both OFF by default. See [Binary provenance verification](#binary-provenance-verification) below. |

### Skills

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `maxSkillBytes` | number | - | *(unmapped — see [note](#environment-variable-names))* | Per-skill byte cap. Skills exceeding this size are rejected with a sanitised log warning. Default `32768` (32KB). Set to `0` to disable the per-skill cap. |
| `maxTotalSkillBytes` | number | - | *(unmapped — see [note](#environment-variable-names))* | Global skills-context budget. When a session's merged active-skill set exceeds this size, lower-priority skills are dropped first (frontmatter `priority` defaults to 100; ties broken alphabetically). Default `262144` (256KB). Set to `0` to disable the global cap. |
| `providerSkillAllowlist` | object | - | *(unmapped — see [note](#environment-variable-names))* | Per-provider skill allowlist. Object keyed by provider id (e.g. `codex`, `gemini`); each value is an array of skill names that may load for that provider. See [Per-provider skill allowlist](#per-provider-skill-allowlist) below. |
| `trustMismatchMode` | string | - | *(unmapped — see [note](#environment-variable-names))* | One of `warn` or `block`. When set, the server records a SHA-256 hash of every loaded skill on first activation and compares it on every subsequent load. See [Skill content-hash trust](#skill-content-hash-trust) below. Disabled (no hashing) when omitted. |

### Environments, isolation, and worktrees

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `environments` | object | `--environments`, `--environment-backend <backend>` | *(unmapped — see [note](#environment-variable-names))* | Container / cluster isolation backends. `enabled` (boolean) turns the feature on; `backend` selects `docker` (default), `k8s`, or `rancher`; `docker`, `k8s`, and `rancher` carry the per-backend connection blocks. An unrecognised `backend` warns and falls back to Docker rather than failing startup. The `--environments` / `--environment-backend` flags layer over a file-configured block rather than replacing it. See the [Kubernetes](#kubernetes-workspace-pvc-environmentsk8sworkspace) sections below and [Nested config blocks](#nested-config-blocks-at-a-glance). |
| `worktreeGc` | object | - | *(unmapped — see [note](#environment-variable-names))* | Garbage collection for orphaned agent worktrees (#5158). `{ autoReap?: boolean, reapIntervalMs?: number, maxLockAgeMs?: number }`. `autoReap` is **off by default**; when on, the daemon reclaims dead-pid-locked worktrees on startup and then every `reapIntervalMs` (default `1800000` / 30 min), clean trees only, never `--force`. `maxLockAgeMs` is an absolute-age fallback for the PID-liveness check — `0` (the default) disables it. The `chroxy worktree gc` CLI is always available for manual / dry-run use regardless of this block. |
| `orphanReap` | object | - | *(unmapped — see [note](#environment-variable-names))* | Orphaned-child reaper (#7606). `{ enabled?: boolean, sweepIntervalMs?: number, minAgeMs?: number }`. `enabled` is **on by default**: the daemon periodically `SIGKILL`s processes that are reparented to pid 1, owned by the daemon's uid, older than `minAgeMs` (default `600000` / 10 min) and whose working directory is inside chroxy's own session-worktree root — work a dead session left running (the kill sites already reap a session's process tree; this is the backstop for a daemon crash or a child that outlived a force-exit). Sweeps every `sweepIntervalMs` (default `300000` / 5 min). POSIX only; a no-op on Windows. |
| `sessionCi` | object | - | *(unmapped — see [note](#environment-variable-names))* | CI-completion watching for the pull request a session opened (#7424). `{ watch?: boolean, wakeAgent?: boolean, intervalMs?: number, discoveryIntervalMs?: number, maxSurveysPerTick?: number }`. `watch` is **on by default**: one sweep (never a timer per session) surveys each session's PR through your own `gh` every `intervalMs` (default `60000`) while a run is in flight, and every `discoveryIntervalMs` (default `300000`) otherwise. When a run settles — `pending === 0`, not merely "green" — it fires a `ci_complete` notification and, unless `wakeAgent` is `false`, types one line into that session's prompt if it is an idle claude-tui session. Set `watch: false` for a host that must make no background GitHub calls. A run that starts and finishes between two sweeps is missed rather than reported late. `maxSurveysPerTick` (default `4`, clamped to an integer ≥ 1) caps how many sessions one sweep pass surveys — the escape hatch for sweep contention on a many-session daemon (#7436). |

### Control Room

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `controlRoomRoot` | string | - | `CHROXY_CONTROL_ROOM_ROOT` | Filesystem root the Host Status survey scans for auto-discovered git repos (#5172). The discovered set is unioned with explicit [`repos`](#core-server) entries. Defaults to `~/Projects`. |
| `controlRoomRunnerRoot` | string | - | `CHROXY_RUNNER_ROOT` | Filesystem root the self-hosted GitHub Actions runner survey scans for runner installs — directories containing a `.runner` config (#5253). Defaults to `~/github-runners`. |
| `controlRoomRunnerIncludeGithub` | boolean | - | `CHROXY_RUNNER_INCLUDE_GITHUB` | Whether the runner survey enriches each runner with GitHub's view (online / busy / labels) via `gh api` (#5260). Default `true`. Set `false` for a faster local-only survey, or on hosts where `gh` isn't authenticated. |
| `controlRoomContainersIncludeStats` | boolean | - | `CHROXY_CONTAINERS_INCLUDE_STATS` | Whether the containers survey runs the `docker stats` enrichment (#6133). Default `true`. Set `false` for an inventory-only survey on a slow or socketless Docker. |
| `controlRoomRepoMemoryBin` | string | - | `CHROXY_REPO_MEMORY_BIN` | Explicit path to the `repo-memory` binary the Integrations survey shells out to (#5499). When unset the survey probes `PATH` with `which repo-memory` once per snapshot — set this on hosts where the daemon runs under a GUI/launchd `PATH` that misses npm globals. |

### Notifications, billing, and opt-in features

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `notifications` | object | - | *(unmapped — see [note](#environment-variable-names))* | Notification-sink settings. Today the only sub-block is `notifications.discord` — see [Discord notifications](#discord-notifications-notificationsdiscord). The webhook URL is a **secret** and deliberately *not* a config key. |
| `billing` | object | - | *(unmapped — see [note](#environment-variable-names))* | Monthly programmatic-credit budget meter (#5665). `creditTier` (`pro` \| `max5x` \| `max20x`), `monthlyCreditBudgetUsd` (a raw USD cap that wins over the tier preset), `budgetWarningPercent` (1–100, default `80`), plus the #5828 canary knobs `egressCheck` (boolean, default off — an outbound public-IP lookup that warns when a subscription-billed provider runs from a cloud host) and `datacenterPrefixes` (extra IPv4 prefixes merged into the built-in datacenter classifier). See [Nested config blocks](#nested-config-blocks-at-a-glance). |
| `features` | object | - | `CHROXY_ENABLE_IDE`, `CHROXY_ENABLE_ORCHESTRATION`, `CHROXY_ENABLE_SCHEDULER`, `CHROXY_SEMANTIC_TITLES` | Opt-in feature flags, all **off by default** and all fail-closed — only a literal `true` in config (or a literal `"1"` in the env) enables one. `ide` (IDE navigation surface, epic #6469), `orchestration` (delegation harness, epic #6691), `scheduler` (headless execution of scheduled tasks, #6865), and `semanticTitles` (model-generated session titles, #6764 — `CHROXY_SEMANTIC_TITLES=0` also force-*disables*). Full inventory in [Opt-in features](#opt-in-features-features); the title flag has its own section under [Semantic session titles](#semantic-session-titles-featuressemantictitles). Each env var is read directly by its feature gate, so it overrides config regardless of the merge layer. |
| `orchestration` | object | - | `CHROXY_ORCHESTRATION` | Tuning for the orchestration engine, which only runs when `features.orchestration` is on. `maxParallelWorkers` (default `2`), `reserveSessions` (`1`), `maxCommitteeIterations` (`4`), `maxParseRetries` (`2`), `turnTimeoutMs` (`1800000` / 30 min), `diff: { maxBytes: 65536, maxFileBytes: 8192 }`, `bash: { implementAllowlist: [] }`, and `roles` (per-role provider/model overrides). Declared in the schema so a configured block doesn't trip the misleading "unknown key" warning. See [`docs/design/orchestration/`](../../docs/design/orchestration/README.md). |

### Env-only settings

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| _(env-only)_ | string | - | `CHROXY_CONFIG_DIR` | Absolute path to the config/state root, replacing the `~/.chroxy` default for **all** daemon state — see [The config root](#the-config-root-chroxy_config_dir). Cannot be a `config.json` key: it is what locates `config.json`. A **relative** value is refused with a warning and falls back to the default, rather than being resolved against the daemon's cwd. Relocating an existing install leaves state behind at `~/.chroxy`; `chroxy config-dir status` reports it and `chroxy config-dir migrate --yes` copies it forward. |
| _(env-only)_ | number | - | `CHROXY_DIAGNOSTICS_RATE_LIMIT` | Per-source-IP request cap on `GET /diagnostics` over a 60 s sliding window (#3737). The endpoint reads the on-disk log tail and iterates every session per call, so it is rate-limited to protect against a stolen-token tight loop. Default `12` requests/min with a 4-request burst. Set the env var to an **integer ≥ 1** to raise or lower that per-window cap (the rate limiter's own `maxMessages` option — unrelated to the `maxMessages` config key above); the burst auto-derives as `max(1, floor(N/3))`. Invalid values (non-integer, < 1, NaN) silently fall through to the default — including sub-integer values like `0.5`, which are rejected outright (truncating to `0` would otherwise raise the limit via RateLimiter's `\|\|` fallback). No `config.json` key is exposed; this setting is intentionally env-only. Overshoot returns `429` with a `Retry-After` header and a JSON body `{ "error": "rate limited", "retryAfterMs": <ms> }`. |

### Environment variable names

Two different mechanisms put an environment variable in the tables above, and
they are worth telling apart.

**1. Merge-layer overrides.** `mergeConfig` looks every schema key up in the
environment and, if present, that value wins over the config file. The name comes
from `envKeyForConfig()` in
[`packages/server/src/config.js`](src/config.js) — most keys have an **explicit**
entry there (`port` → `PORT`, `controlRoomRunnerRoot` → `CHROXY_RUNNER_ROOT`, …).

**2. Direct reads.** Some settings are read straight out of `process.env` by the
helper that consumes them, bypassing the merge layer entirely:
`CHROXY_ENABLE_IDE` / `CHROXY_ENABLE_ORCHESTRATION` / `CHROXY_ENABLE_SCHEDULER` /
`CHROXY_SEMANTIC_TITLES` (the four [`features` gates](#opt-in-features-features)),
`CHROXY_SEMANTIC_TITLES_MODEL` /
`CHROXY_SEMANTIC_TITLES_TIMEOUT_MS` (which override *specific fields* of
`summarize` on the title path only — they are not a general override for the
`summarize` object), and `CHROXY_BINARY_PROVENANCE` /
`CHROXY_BINARY_SIGNATURE_GATE` (`binaryProvenance`).

`CHROXY_CONFIG_DIR` is a direct read too, and necessarily so — the merge layer
reads `config.json`, and this variable is what decides which `config.json` that
is. It is read **per filesystem call** rather than once at import, for the reason
given in [The config root](#the-config-root-chroxy_config_dir).

**The naive fallback.** 16 schema keys have no explicit `envKeyForConfig` entry,
so their *merge-layer* lookup falls back to a bare `key.toUpperCase()` — which
drops the `CHROXY_` prefix and all word separators: `features` → `FEATURES`,
`billing` → `BILLING`, `workspaceRoots` → `WORKSPACEROOTS`, `userShell` →
`USERSHELL`, `trustMismatchMode` → `TRUSTMISMATCHMODE`, `summarize` →
`SUMMARIZE`, `binaryProvenance` → `BINARYPROVENANCE`, and so on. The tables mark
these *(unmapped)* wherever the key has no direct-read env var to list instead;
`summarize`, `features`, and `binaryProvenance` are unmapped at the merge layer
too, even though their rows list the direct reads above.

Those fallback names are **not a supported interface**:

- They are generic enough that an unrelated variable already in your environment
  could be picked up as chroxy config (this is exactly why `orchestration` was
  given an explicit `CHROXY_ORCHESTRATION` mapping in #6691).
- Object-typed keys would have to be supplied as a JSON string.

Set these keys in `~/.chroxy/config.json` instead. If you need an env override
for one of them, add an explicit mapping to `envKeyForConfig()` rather than
relying on the fallback.

### Nested config blocks at a glance

Several keys are object blocks whose sub-keys are validated at startup — a typo
inside one produces a non-fatal `unknown key` warning naming the supported set,
rather than being silently dropped.

| Block | Recognised sub-keys |
|-------|---------------------|
| `billing` | `creditTier`, `monthlyCreditBudgetUsd`, `budgetWarningPercent`, `egressCheck`, `datacenterPrefixes` |
| `worktreeGc` | `autoReap`, `reapIntervalMs`, `maxLockAgeMs` |
| `orphanReap` | `enabled`, `sweepIntervalMs`, `minAgeMs` |
| `sessionCi` | `watch`, `wakeAgent`, `intervalMs`, `discoveryIntervalMs`, `maxSurveysPerTick` |
| `userShell` | `enabled`, `requireApproval` |
| `environments.k8s` | `namespace`, `inCluster`, `kubeconfigPath`, `sidecarImage`, `imagePullPolicy`, `connectMode`, `namespaceQuota`, `namespaceLimitRange`, `workspace` |
| `environments.rancher` | `rancherUrl`, `clusterId`, `token`, `tokenEnv`, `tokenFile`, `caData`, `skipTLSVerify`, `defaultProjectId` |
| `notifications.discord` | `botName`, `billingAlerts`, `colors`, `defaultColor`, `permissionColor`, `errorColor`, `updateThrottleMs`, `heartbeatIntervalMs`, `pruneAfterMs`, `staleAfterMs`, `offlineAfterMs`, `statePath`, `billingStatePath` |
| `providers` *(object form)* | `anthropicCompatible`, `openaiCompatible`, `acp`, `allowAnyModel` |

`summarize`, `features`, and `orchestration` have no unknown-key check today, so
a typo in one of those is silently ignored rather than warned about.

### Unrestricted provider models (`providers.allowAnyModel`)

The static-allowlist subprocess providers (e.g. `gemini`, `codex`, `deepseek`)
hard-reject a model id that is not in their built-in list, even when the upstream
API already serves it — which otherwise forces a chroxy release just to add one.
`providers.allowAnyModel` is an array of provider ids that opt out of that check
(#6378):

```json
{
  "providers": {
    "allowAnyModel": ["codex", "gemini"]
  }
}
```

An opted-in provider passes the model id through verbatim and lets the upstream
API be the validator. Default is **off** for every provider, so the
misconfiguration-catching strictness is preserved unless you explicitly opt in.
A missing or non-array value is treated as an empty set; non-string entries are
dropped.

Note that this lives inside the **object** form of the `providers` key, which is
the same block that carries `anthropicCompatible` — it does not apply to the
legacy array form.

### Prompt evaluator skip heuristic

The prompt evaluator (see #3068) is gated by a fast local heuristic so trivial
follow-ups (`y`, `go`, `looks good`) don't pay the cost of an Anthropic
round-trip. A draft message **skips** evaluation when any of the following is
true:

- Length (after trim) is less than 20 characters
- The trimmed message matches the built-in continuation regex
  (case-insensitive): `^(y|n|yes|no|go|continue|run it|ok|okay|sure|sounds good|looks good|do it)\.?$`
- The trimmed message matches the per-session
  `promptEvaluatorSkipPattern` regex (also case-insensitive)

`promptEvaluatorSkipPattern` is a regex *source string* — for example
`"^please proceed"` or `"^(ship it|merge it|that's good)$"` — not a literal
phrase list. The pattern is OR-ed with the default; setting it cannot
**unblock** evaluation for messages already covered by the default rules. If
the source fails to compile (unbalanced brackets, etc.) the server logs a
warning and falls back to the default pattern only.

This config is consumed by the auto-evaluator hook (see `shouldSkipEvaluator`
in `packages/server/src/prompt-evaluator.js`); the on-demand "Evaluate"
button in the dashboard always evaluates, regardless of this setting.

### Per-provider skill allowlist

`providerSkillAllowlist` lets operators restrict which skills are eligible to
load for non-Claude providers (Codex, Gemini, etc.). Claude has its own
tool-gating layer; Codex and Gemini do not, so a malicious or buggy skill that
asks them to run a destructive shell command is harder to contain. The
allowlist scopes the per-session skill set to a known-good list per provider.

Shape: an object keyed by provider id (the same string used in the
`provider` config key); each value is an array of skill names (the file's
basename without the `.md` / `.markdown` extension).

```jsonc
{
  "providerSkillAllowlist": {
    "codex": ["coding-style", "git-workflow"],
    "gemini": ["coding-style"]
  }
}
```

Behaviour:

- **Allowlist omitted entirely** — legacy permissive: every loaded skill is
  eligible for every provider. Existing setups keep working without change.
- **Claude-family providers** (`claude-sdk`, `claude-cli`, `docker-sdk`,
  `docker-cli`, bare alias `claude`) — always permissive, even when the
  allowlist is configured. Claude's tool gating is the primary defense.
- **Non-Claude providers with an entry in the allowlist** — only skills
  whose basename appears in `allowlist[provider]` load. Other skills are
  silently filtered (a sanitised warn is logged for each drop).
- **Non-Claude providers with no entry, or an empty array** — fail-secure:
  ALL skills are filtered for that provider. An operator who configures
  the allowlist but forgets to add a key for `gemini` should NOT be
  silently permissive.

The filter runs after the global+repo merge and before the global byte
budget, so a deny-listed skill never counts against the budget.

### Skill content-hash trust

`trustMismatchMode` opts the server into a per-skill SHA-256 ledger so silent
post-review tampering is detected. On first activation the loader records each
skill's body hash to `~/.chroxy/skills-trust.json`; on every subsequent load
the recorded hash is compared against the current body.

Modes:

- **omitted (default)** — trust check disabled. No hashes are computed or
  written. Behaviour is identical to the pre-#3204 server.
- **`warn`** — mismatch logs a sanitised warning (basename + 8-char hash
  prefixes; same anti-leak pattern as the rejection warnings) and emits a
  `skill_changed` WS event so a paired dashboard can surface a prompt. The
  skill still loads — operator review is the gate.
- **`block`** — same warn + event, but the skill is filtered out of the active
  set so a tampered skill stops influencing prompts until the operator
  explicitly re-trusts it.

Hash scope: only the body AFTER frontmatter parsing is hashed, so cosmetic
frontmatter edits (renaming, switching activation mode, adjusting priority)
don't trigger a mismatch every time. Body edits, deletions, or replacements
do.

The trust file lives at `~/.chroxy/skills-trust.json` and is intentionally a
sidecar (not folded into `session-state.json`) so it can be inspected
directly. Format:

```jsonc
{
  "/Users/me/.chroxy/skills/coding-style.md": {
    "sha256": "abc123...",
    "firstSeen": "2026-05-03T12:34:56.000Z",
    "lastVerified": "2026-05-03T12:34:56.000Z"
  }
}
```

A corrupted or missing trust file is treated as empty (fail-open) so a single
bad write can't lock every skill out of every session.

### Binary provenance verification

`binaryProvenance` opts the daemon into pre-spawn provenance verification of the
external binaries it executes as providers (`claude`, `codex`, `gemini`) and of
`cloudflared`. This extends the always-on P1 integrity/quarantine check (#6708)
with two **opt-in, OFF-by-default** gates — see
[`docs/security/spawned-binary-provenance.md`](../../docs/security/spawned-binary-provenance.md).

```jsonc
{
  "binaryProvenance": {
    "mode": "off",           // "off" (default) | "warn" | "block"
    "signatureGate": false   // macOS spctl notarization gate
  }
}
```

- **`mode`** — a cross-platform SHA-256 **pin ledger** (`~/.chroxy/binary-trust.json`,
  same fail-open/atomic-0600 sidecar as the skill ledger). Each binary's hash is
  pinned on first sight (trust-on-first-use); a later change to that hash re-gates
  the binary. `warn` logs the change and still spawns; `block` **refuses the
  spawn** until the operator re-approves. Catches an in-place binary swap
  regardless of signature or quarantine state. `off` (default) skips the ledger
  entirely. Env override: `CHROXY_BINARY_PROVENANCE` = `off`/`warn`/`block`.
- **`signatureGate`** — when `true`, a binary that fails `spctl --assess`
  (Gatekeeper / notarization) is hard-blocked. For operators who run only
  notarized provider builds; chroxy's bundled providers are ad-hoc-signed and
  would be rejected, so it can only ever be opt-in. **macOS-only** — a documented
  no-op on Linux/Windows (the pin ledger still applies). Env override:
  `CHROXY_BINARY_SIGNATURE_GATE` = `1`/`0`.

Both fail-safe: when a gate is on, a failure blocks (`block` / signature) or is
loudly surfaced (`warn`) — an unverified binary is never silently spawned. A
`block`-mode failure surfaces as a `session_error`
(`code: PROVIDER_BINARY_PROVENANCE`) for providers, or aborts the tunnel start
(`code: TUNNEL_BINARY_PROVENANCE`) for `cloudflared`. To re-approve a
legitimately-updated binary, remove its entry from `~/.chroxy/binary-trust.json`
(or delete the file — it fails open and re-pins on next spawn).

### Skip permissions (TUI provider)

`dangerouslySkipPermissions` is a **TUI-only** opt-out from chroxy's permission
gate. When enabled, sessions on the `claude-tui` provider (the legacy CLI
session backend that drives the real `claude` TUI through a PTY) are spawned
with the `--dangerously-skip-permissions` flag and the chroxy permission hook
is elided entirely. Other providers (`claude-sdk`, `claude-cli`,
`docker-sdk`/`docker-cli`, `codex`, `gemini`) ignore the flag harmlessly —
they have their own permission paths and chroxy does not pass this through.

**What enabling it actually does:**

- Spawns the TUI `claude` binary with `--dangerously-skip-permissions`, so
  Claude itself stops prompting for tool approvals.
- Skips wiring chroxy's permission hook into the TUI session, so chroxy's own
  permission rule engine never sees a request to gate.
- Logs a loud `[security]` warning at startup identifying which config key
  surfaced the setting (see below).

**Sources, in precedence order** (highest priority first):

1. CLI flag: `chroxy start --dangerously-skip-permissions`
2. Config key: `dangerouslySkipPermissions` (canonical, mirrors the CLI flag name)
3. Config key: `skipPermissions` (legacy alias — see "Deprecation" below)
4. Default: `false`

Operators running headless deploys can pin the setting in `config.json`:

```jsonc
{
  "dangerouslySkipPermissions": true
}
```

At boot, when the resolved value is `true`, the server emits:

```
[security] dangerouslySkipPermissions=true (source: config.dangerouslySkipPermissions) — claude-tui sessions will spawn with --dangerously-skip-permissions and chroxy's permission gate is BYPASSED for those sessions
```

**Deprecation: the legacy `skipPermissions` key.**

Prior to #4246 the config-file key was `skipPermissions`. That spelling is
still honoured for one deprecation window so existing config files keep
working, but the server logs a warning at startup nudging operators to rename
the key:

```
[security] config key 'skipPermissions' is deprecated — rename it to 'dangerouslySkipPermissions' to match the CLI flag name. Both keys are honoured for now; the legacy key will be removed in a future release.
```

If both keys are present the canonical `dangerouslySkipPermissions` wins as
the value source, but the deprecation warning is still emitted to nudge
cleanup of the stale duplicate.

**Config-key vs wire-field distinction.**

This config key is the **server-wide default** applied to every new session
that does not specify the setting explicitly. It is distinct from the
per-session `skipPermissions` field on the WebSocket `create_session`
message (see `packages/protocol/src/schemas/client.ts`), which lets a single
session opt in at creation time — for example via the dashboard's TUI-only
checkbox. The per-session wire field is also `skipPermissions` (matching the
session-creation API surface) rather than `dangerouslySkipPermissions`; that
naming is intentional and does not carry the config-file deprecation.

When the per-session wire field is omitted, the session inherits the
server-wide default resolved from this config key. As with the config-file
flag, the wire field is honoured only by the `claude-tui` provider.

**Env var.** The matching environment variable is
`CHROXY_DANGEROUSLY_SKIP_PERMISSIONS` (canonical) with the deprecated alias
`CHROXY_SKIP_PERMISSIONS` honoured for the same deprecation window as the
config-file alias (#4384). Both follow the same precedence as their config-key
counterparts.

### Inactivity safety net

A session is protected by a two-stage timer pair (#3899, #3901): a soft
**warning** window followed by a hard **kill** window. Both fire only when
the server has heard nothing — no stream delta, no tool event, no result —
from the SDK / CLI for the configured duration.

| Stage | Key | Env var | Default | Behavior |
|-------|-----|---------|---------|----------|
| Soft | `resultTimeoutMs` | `CHROXY_RESULT_TIMEOUT_MS` | `1800000` (30 min) | Emits `inactivity_warning` event + push notification. Session stays alive. Clients render a "check in" chip in the activity indicator. |
| Hard | `hardTimeoutMs` | `CHROXY_HARD_TIMEOUT_MS` | `7200000` (2 h) | Emits `permission_expired` for every outstanding permission request, force-clears busy state, aborts any in-flight SDK query, and emits a generic `error` event (`"Response timed out after <duration> of inactivity"`). Session must be re-driven by the user. |

**Whole milliseconds only (#7083).** Every millisecond option — `resultTimeoutMs`,
`hardTimeoutMs`, `streamStallTimeoutMs`, `backgroundShellHardQuiesceMs`,
`mcpToolCallTimeoutMs`, `terminalDownGraceMs`, and each entry of
`providerStreamStallTimeoutMs` — is truncated to an integer when the config is merged,
from the config file and the env var alike. A fractional value logs a warning naming the
key and the value it was changed to. They must be whole ms because they are sent on the
wire, where the protocol schemas require an integer. Note this is truncation toward zero,
so `30000.9` becomes `30000` — never rounded up into a range it did not qualify for. USD
options (`costBudget`, `billing.*`, provider `pricing.*`) are deliberately untouched.

Both fields share the same range (`30000`–`86400000`, 30 s – 24 h) and the
same WS schema cap (#3768). Values outside the range emit warn-only log
lines during validation; the runtime applies whatever was set. The
validator also warns if `hardTimeoutMs < resultTimeoutMs` — the soft
warning would never fire before the kill.

The legacy single-timer value was 5 min (#3749), which proved too aggressive
for legitimately slow tools (large fetches, long Bash commands, extended
thinking). The split lets operators keep the **warning** noisy (catch
genuinely stuck sessions early) while leaving the **kill** generous (don't
murder a 90-minute Bash build).

While a permission prompt is outstanding both timers are paused; on
resolution they re-arm with their respective windows (#2831, #3757). The
configured `resultTimeoutMs` is broadcast to clients on the `auth_ok`
message (#3760), letting the dashboard / app `ActivityIndicator` warn the
user when a turn is approaching the soft window. The matching
`inactivity_warning` event payload is `{ messageId, idleMs, prefab }`,
where `idleMs` is `resultTimeoutMs` and `prefab` is a suggested
check-in string (`"Status update?"`). Consumed by the dashboard
check-in chip in #3908 and the mobile chip in #3913. Both
`resultTimeoutMs` and `hardTimeoutMs` are broadcast as fields on
`auth_ok` so clients can render both the "approaching soft window"
warning and a "kill in Xh" countdown against the real configured
values rather than the BaseSession defaults (#3760, #3905).

### Provider selection

The `provider` key picks which AI CLI backs a session by default:

| Value | Backing binary / SDK | Required env |
|-------|----------------------|--------------|
| `claude-tui` (default) | drives the interactive `claude` TUI under a PTY (#5819) | Claude Code subscription login |
| `claude-sdk` | `@anthropic-ai/claude-agent-sdk` | Claude Code login or `ANTHROPIC_API_KEY` |
| `claude-cli` | `claude -p` (Claude Code CLI) | Claude Code login (CLI intentionally strips `ANTHROPIC_API_KEY` from its environment) |
| `claude-channel` *(research preview)* | `claude --channels` (Claude Code CLI, MCP channel transport) | Claude Code subscription login (rejects `ANTHROPIC_API_KEY`). Requires `claude` ≥ 2.1.80 |
| `gemini` | `gemini -p` CLI | `GEMINI_API_KEY` |
| `codex` | `codex exec` CLI | `OPENAI_API_KEY` |
| `docker-sdk` / `docker-cli` | Claude SDK/CLI inside a Docker container | Requires `environments.enabled=true` + Docker |

Clients can override the default per-session by passing `provider` in a `create_session` WebSocket message. See [../../docs/providers.md](../../docs/providers.md) for capability differences (plan mode, permission handling, resume, attachments) and troubleshooting.

### `claude-channel` (research preview)

`claude-channel` drives Claude through Anthropic's first-party **channels MCP
protocol** (`claude --channels`) instead of scraping the interactive TUI
(`claude-tui`) or calling the SDK / `claude -p` (`claude-sdk` / `claude-cli`).
A *channel* is a stdio MCP server that **pushes** events into a running
interactive `claude` session; chroxy bridges those events onto its normal
WebSocket/event pipeline. It bills the same way `claude-tui` does — against your
Claude subscription's **interactive allowance**, bypassing the programmatic
credit pool — because the events arrive in a real interactive session, not a
`claude -p` subprocess.

> **Status — scaffold only.** As of this writing the provider is a registered
> scaffold (#3953): it is listed by the registry and runs its `chroxy doctor`
> preflight, but `start()` throws "not yet implemented". The live bridge
> (spawn + IPC round-trip) lands in #3954. Selecting `claude-channel` today
> fails fast with a clear error rather than spawning anything.

**When to pick it over `claude-tui` / `claude-sdk`:**

- Over **`claude-tui`**: once the bridge lands, the channel transport replaces
  the fragile ANSI-scrape + PTY-keystroke approach with a documented MCP
  contract, and adds **live streaming** plus a **first-party permission relay**
  (Anthropic's `claude/channel/permission`, instead of the sidecar
  `permission-hook.sh`). Same subscription billing surface.
- Over **`claude-sdk` / `claude-cli`**: pick the channel path (like
  `claude-tui`) only when you want sessions to bill against your Claude.ai Pro /
  Max / Team **subscription** rather than the programmatic credit pool. The SDK
  remains the default and most-featured backend for programmatic billing.
- It is **not a strict superset of `claude-tui`**: the channel surface does
  **not** expose model switching or permission-mode switching (those stay the
  same gap `claude-tui` has), and resume / plan mode / thinking-level are not in
  the channel contract.

**Requirements and caveats:**

- **`claude` ≥ 2.1.80.** The `--channels` transport ships from this version
  (the locally-installed CLI used for the spike was v2.1.163). Permission relay
  additionally needs ≥ 2.1.81, but that surface lands with #3955; the scaffold
  preflight gates on the 2.1.80 channel-transport floor only. The dashboard
  picker should disable the option with an explanatory tooltip below 2.1.80
  (deferred — see [`docs/providers.md`](../../docs/providers.md#claude-channel-research-preview)).
- **`--dangerously-load-development-channels` is required during the preview.**
  Custom (non-allowlisted) channels are not on Anthropic's approved channels
  allowlist, so chroxy must pass this flag to load `chroxy-channel`. The flag
  bypasses **only** the channel allowlist, not org policy. A
  marketplace-approved `chroxy-channel` plugin removes the need for it — see
  [`packages/server/src/channels/PACKAGING.md`](src/channels/PACKAGING.md).
- **Protocol instability (preview).** Anthropic documents the channels contract
  as a research preview that "may change based on feedback". Treat each Claude
  Code minor bump as a smoke-test trigger for this provider; `claude-tui`
  remains the stable subscription-billed fallback.
- **Org / platform gating.** Channels are **not** available on Bedrock / Vertex
  / Foundry, and Team/Enterprise orgs must enable `channelsEnabled` in managed
  settings. `chroxy doctor` surfaces the binary + version preflight; org-policy
  failures surface at session start.

For the verified protocol contract, the capability matrix, and the go/no-go
rationale, see the spike:
[`docs/architecture/claude-channels-provider-spike.md`](../../docs/architecture/claude-channels-provider-spike.md).

### Kubernetes workspace PVC (`environments.k8s.workspace`)

When the K8s environment backend is active on a **multi-node** cluster, the
default `hostPath` workspace mount only works for Pods scheduled on the node
that owns the host directory — on every other node the Pod silently mounts an
empty `DirectoryOrCreate` and the workload sees no workspace. To make the
workspace cluster-wide, K8sBackend supports mounting a pre-provisioned
`PersistentVolumeClaim` instead (`#3385` / `#4547`).

The PVC strategy is **operator-side configuration**: the claim, mount path, and
read-only flag are cluster-ops concerns that don't vary per project, per
session, or per user. Set the block once in `~/.chroxy/config.json` and every
environment created on the K8s backend picks it up automatically (`#4556`).

```json
{
  "environments": {
    "enabled": true,
    "k8s": {
      "workspace": {
        "claimName": "chroxy-workspace-pvc",
        "mountPath": "/workspace",
        "readOnly": false
      }
    }
  }
}
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `claimName` | string | yes | — | Name of a pre-provisioned PVC in the target namespace. Must be a non-empty string. |
| `mountPath` | string | no | `/workspace` | Pod-side mount path. |
| `readOnly` | boolean | no | `false` | Mount the PVC read-only. |

The block shape is validated at config-load time — a typo (missing `claimName`,
wrong type) surfaces at startup, not at the first environment-creation call.
Docker and other non-K8s backends silently ignore the block, so it's safe to
leave in config when switching backends.

Per-create callers (a future dashboard or CLI flag) can pass an explicit
`workspacePVC` opt to override the configured default for a single environment;
the per-call value always wins. With no caller override and no config block,
the manager omits the field entirely and the K8s backend falls back to the
`hostPath` strategy (single-node clusters).

### Kubernetes resource quotas (CPU / memory requests & limits)

When the K8s environment backend is active, every Pod it creates carries CPU and
memory **requests** (what the scheduler reserves and the pod is guaranteed) and
**limits** (the hard ceiling enforced by the kernel/cgroup). This keeps a single
runaway session from starving the node (`#3195`).

If a `createEnvironment` call does not specify resources, the backend applies
these built-in defaults:

| Dimension | Request | Limit |
|-----------|---------|-------|
| CPU       | `500m`  | `2`   |
| Memory    | `512Mi` | `4Gi` |

All values are standard [Kubernetes resource quantities](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/):
CPU as a decimal number or milli-cpu (`500m`, `1`, `2`), memory as a binary-SI
quantity (`512Mi`, `2Gi`) or bytes. Docker-style memory suffixes (`512m`, `2g`)
are normalised to their binary-SI equivalents (`512Mi`, `2Gi`). Malformed
quantities are rejected before any Pod or Secret is created.

Per-create callers can override any field via the structured `resources` opt:

```js
await environmentManager.create({
  name: 'big-build',
  cwd: '/path/to/project',
  resources: {
    cpu: '1',          // requests.cpu
    memory: '1Gi',     // requests.memory
    cpuLimit: '4',     // limits.cpu
    memoryLimit: '8Gi' // limits.memory
  },
})
```

Unset fields fall back to the legacy flat `memoryLimit`/`cpuLimit` opts (applied
to both the request and the limit for that dimension) and then to the defaults
above. The structured `resources` opt always wins where both are present.

Docker and other non-K8s backends ignore the `resources` opt entirely.

Operators can also change the cluster-wide defaults when constructing the
backend: pass `defaultResources` as a partial `{ cpu, memory, cpuLimit,
memoryLimit }` object (merged over the built-ins) to raise/lower them, or
`defaultResources: null` to disable defaults so only explicit per-call values
produce a `resources` block.

### Kubernetes per-tenant namespace caps (`ResourceQuota` / `LimitRange`)

The pod-level `resources` block above limits each individual Pod. Now that the
K8s backend gives every tenant their own namespace (`#3194`), you can also set
**namespace-level** guardrails that apply to the tenant as a whole (`#5142`).
Both are **opt-in**; when unset the namespace-ensure path is unchanged. They are
only applied to per-tenant namespaces — never to the static default namespace.

**`environments.k8s.namespaceQuota`** ensures an idempotent `ResourceQuota` that
caps the AGGREGATE resources a tenant may consume across ALL their Pods:

```json
{
  "environments": {
    "backend": "k8s",
    "k8s": {
      "namespaceQuota": {
        "cpu": "8",          // aggregate requests.cpu cap
        "memory": "16Gi",    // aggregate requests.memory cap
        "cpuLimit": "16",    // aggregate limits.cpu cap
        "memoryLimit": "32Gi", // aggregate limits.memory cap
        "pods": 10           // max Pods in the namespace
      }
    }
  }
}
```

At least one field is required. `cpu`/`memory` map to the aggregate `requests.*`
keys, `cpuLimit`/`memoryLimit` to the aggregate `limits.*` keys, and `pods` to
the object-count quota. With a quota in place, Pods that lack their own
requests/limits will be REJECTED by the cluster — pair it with a `LimitRange`
(below) or the backend's own `defaultResources` so every Pod carries values.

**`environments.k8s.namespaceLimitRange`** ensures an idempotent `LimitRange`
that supplies cluster-level DEFAULT requests/limits, so Pods created without
explicit resources inherit namespace defaults (defence-in-depth on top of the
backend's own `defaultResources`):

```json
{
  "environments": {
    "k8s": {
      "namespaceLimitRange": {
        "cpu": "250m",       // defaultRequest.cpu
        "memory": "256Mi",   // defaultRequest.memory
        "cpuLimit": "1",     // default.cpu (the limit)
        "memoryLimit": "1Gi" // default.memory (the limit)
      }
    }
  }
}
```

At least one field is required. `cpu`/`memory` become the LimitRange
`defaultRequest`, while `cpuLimit`/`memoryLimit` become the `default` (limit).

Both blocks accept the same quantity grammar as the per-pod `resources` opt
(CPU as a decimal/milli-cpu string, memory as a binary-SI quantity; Docker-style
suffixes are normalised). Malformed quantities are rejected at startup. Each
configured object's ensure is idempotent (read-or-create, already-exists
swallowed) and cached per process, so it adds one read (plus a create if the
object is missing) per configured object the first time a tenant namespace is
used, and nothing on subsequent calls for that namespace.

### Semantic session titles (`features.semanticTitles`)

By default a session's sidebar label is a raw truncation of the first user
message. With `features.semanticTitles` on, that first turn also fires a cheap
one-shot model call that summarises the message into a short title (#6764).

```json
{
  "features": {
    "semanticTitles": true
  },
  "summarize": {
    "model": "haiku",
    "titleTimeoutMs": 15000
  }
}
```

**Enabling.** `features.semanticTitles: true` in config, or
`CHROXY_SEMANTIC_TITLES=1`. The env var also force-*disables* when set to `0`,
which is handy for tests and A/B runs without editing config. Like the other
`features` flags this is fail-closed — only a literal `true` (or the literal env
string `"1"`) turns it on.

**Which model.** Resolution order:

1. `CHROXY_SEMANTIC_TITLES_MODEL`
2. `summarize.model` — the same cheap-model override used by the sidebar
   "Summarize & start new session" action, deliberately reused so an operator who
   already tuned the summarizer gets the same model for titles
3. `haiku` (the built-in default)

The default stays a cheap Haiku alias so titling never burns a premium model.

**Timeout.** Resolution order:

1. `CHROXY_SEMANTIC_TITLES_TIMEOUT_MS`
2. `summarize.titleTimeoutMs`
3. `15000` (15 s)

Invalid or non-positive values in either source fall back to the default. The
timeout matters because the title call is fire-and-forget: without one, a stalled
provider connection leaves the promise pending forever, pinning the
`SessionManager` and the first message (an unbounded per-session leak) and never
tearing down the one-shot subprocess.

**Failure behaviour is always fail-open.** When the flag is off, the call fails,
the timeout fires, or no model access is available, the session silently keeps
the truncation-based label. A title is a cosmetic nicety — it never blocks or
fails a turn.

### Discord notifications (`notifications.discord`)

The Discord webhook sink (#5413 Phase 2) maintains one status-embed message
per project in a Discord channel, alongside (or instead of) Expo push. It is
**off by default** — it activates only when a webhook URL is present.

The webhook URL is a **secret** (anyone holding it can post to the channel)
and is therefore NOT a config key. Provide it via either:

- `CHROXY_DISCORD_WEBHOOK_URL` environment variable, or
- `~/.chroxy/credentials.json` (must be mode `0600`):
  `{ "discordWebhookUrl": "https://discord.com/api/webhooks/<id>/<token>" }`

The non-secret knobs live under `notifications.discord` in `config.json`:

```json
{
  "notifications": {
    "discord": {
      "botName": "Chroxy",
      "colors": { "chroxy": 1752220, "my-other-project": 10181046 },
      "defaultColor": 5793266,
      "permissionColor": 16753920,
      "errorColor": 15158332,
      "updateThrottleMs": 15000,
      "heartbeatIntervalMs": 300000,
      "pruneAfterMs": 86400000,
      "billingAlerts": true
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `botName` | string | Webhook display name + embed footer label (default `Chroxy`) |
| `colors` | object | Per-project embed sidebar colors, project name → decimal 24-bit RGB (`0`–`16777215`) |
| `defaultColor` | number | Sidebar color for projects without an override (default `5793266`, Discord blurple) |
| `permissionColor` | number | Sidebar color for the needs-approval state (default `16753920`, orange) |
| `errorColor` | number | Sidebar color for the session-error state (default `15158332`, red) |
| `updateThrottleMs` | number | Minimum interval between same-state routine embed updates per project (default `15000`; state changes always go out) |
| `heartbeatIntervalMs` | number | Elapsed-time footer refresh interval for live embeds — offline embeds are final and never re-PATCHed (default `300000`; `0` disables; minimum `10000`) |
| `pruneAfterMs` | number | Retention for state-store entries: entries untouched longer than this are dropped on load (default `86400000` / 24h; `0` disables; minimum `60000` / 60s — smaller values fall back to the default, since a retention shorter than the gap between events prunes the tracked message id in between and turns the embed into message-per-event spam; the last Discord message is kept). Heartbeat refreshes don't reset the clock — only real pipeline events do |
| `billingAlerts` | boolean | Kill-switch for the daemon-global billing-alert message (the 2026-06-15 billing canary). Default `true` when a webhook is configured; `false` keeps billing alerts off Discord while the per-project status embed stays on |
| `staleAfterMs` | number | How long a live embed may go without a pipeline event before the sink marks the project **stale** (#5676 status watchdog; default `600000` / 10 min). Any finite value >= 0 is honoured; anything else falls back to the default |
| `offlineAfterMs` | number | How long a live embed may go without a pipeline event before the sink marks the project **offline** and stops re-PATCHing it (#5676; default `1800000` / 30 min). Same validation as `staleAfterMs` |
| `statePath` | string | Override for the status-embed state store (default `~/.chroxy/discord-webhook-state.json`). The caller defaults it and the config value wins — set it to relocate the store off `$HOME` |
| `billingStatePath` | string | Override for the billing-alert state store (default `~/.chroxy/discord-billing-state.json`), the billing-sink counterpart to `statePath` |

Status-message state (message ids, current state per project) persists in
`~/.chroxy/discord-webhook-state.json`; the billing-alert message tracks its own
id in `~/.chroxy/discord-billing-state.json`. Full setup walkthrough:
[docs/guides/discord-notifications.md](../../docs/guides/discord-notifications.md).

### Opt-in features (`features`)

Some surfaces are **off by default** and activate only when the operator opts in.
Each is gated by a strict-boolean config key under `features`, or by an env
override that must be exactly `1`:

```json
{
  "features": {
    "scheduler": false
  }
}
```

| Key | Env override | Default | What it enables |
|-----|--------------|---------|-----------------|
| `features.scheduler` | `CHROXY_ENABLE_SCHEDULER=1` | `false` | Headless execution of scheduled tasks (#6865) |
| `features.ide` | `CHROXY_ENABLE_IDE=1` | `false` | The IDE navigation surface (epic #6469) |
| `features.orchestration` | `CHROXY_ENABLE_ORCHESTRATION=1` | `false` | The orchestration/delegation harness (epic #6691) |
| `features.semanticTitles` | `CHROXY_SEMANTIC_TITLES=1` | `false` | Model-generated session titles (#6764) — see [Semantic session titles](#semantic-session-titles-featuressemantictitles) |

All four are **fail-closed**: anything other than a literal `true` in config (or
a literal `"1"` in the env) leaves the feature off, so `"yes"`, `1`, or `"true"`
in the config file do *not* enable it. `CHROXY_SEMANTIC_TITLES` is the one env
override that also force-*disables* when set to `0`.

#### `features.scheduler` — headless scheduled execution

Scheduled tasks (`~/.chroxy/scheduled-tasks.json`) can be created, listed, and
edited at any time, but they **never fire** unless this flag is on. With the flag
off the daemon arms no scheduler timers and starts no sessions — behaviour is
identical to a daemon without the feature.

When on, at each task's due time the daemon spins up (or resumes) that task's
session and runs its prompt with **no client connected**.

##### Supported providers — hook-routed providers (including the default) are refused

> **A scheduled task only fires on a provider that answers permission prompts
> in-process.** Right now that is `claude-sdk`, `claude-byok`, `codex` (the
> app-server driver), `deepseek`, and `ollama`. Every other provider — **including
> the daemon default `claude-tui`**, plus `claude-cli`, `claude-channel`, and
> `gemini` — is **refused**: the task does not fire, no session is created, and the
> run is recorded with status `refused` naming the provider.

This is deliberate, not an oversight. The scheduler's whole safety story is that a
permission prompt raised by an unattended turn gets **denied** and the run fails
visibly. That requires observing the prompt and answering it programmatically,
which only providers with in-process permissions expose. Hook-routed providers
instead go out through `hooks/permission-hook.sh` → `POST /permission`, which the
daemon cannot answer with no client attached — such a run would stall on every
gated tool call until the 300-second auto-deny and then finish looking successful
with nothing actually done. Refusing is the honest outcome.

**A task with no explicit `target.provider` therefore does not fire**, because it
resolves to the daemon default. Set `target.provider` to one of the supported ids.
Widening support to hook-routed providers needs a programmatic
permission-answering surface for them — tracked in
[#7003](https://github.com/blamechris/chroxy/issues/7003).

##### The permission floor

Because nobody is watching the turn, a run that does fire runs under a hard floor:

- The run is pinned to the `approve` permission mode. A task whose stored
  `target.permissionMode` is `auto` or `acceptEdits` is **clamped down** to
  `approve` — a scheduled task can never grant itself auto-approval. (`plan` is
  allowed: it is stricter than `approve`.)
- **The clamp is re-asserted before every fire, not just at session creation.**
  A task's session is deliberately kept alive and reused across runs, and an
  operator inspecting it can change its permission mode by hand — so before each
  fire the daemon forces the clamped mode back on and verifies it by reading it
  back. If it cannot be verified, **the fire is skipped** and recorded `refused`.
  A manual switch to Auto therefore cannot leak into the next unattended run.
- The run is created with an explicit `skipPermissions: false`, so it does **not**
  inherit a server-wide [`dangerouslySkipPermissions`](#skip-permissions-tui-provider).
- The task's `target.cwd` is checked against the **same working-directory
  allowlist the dashboard enforces** — the credential-directory deny-list
  (`~/.ssh`, `~/.aws`, `~/.config`, `~/.chroxy`, …), your `workspaceRoots`
  allowlist if configured, and the `$HOME` fallback otherwise. `~/.chroxy/scheduled-tasks.json`
  is an editable file, so a hand-written `target.cwd` gets no more trust than one
  typed into the UI: a disallowed directory is recorded `refused` and does not fire.
- If the turn hits a permission prompt, there is no human to answer it: the prompt
  is **denied**, the turn is aborted, and the run is recorded as a failed run with
  the reason. A scheduled task that needs a permission fails visibly rather than
  escalating silently. A run that raised any prompt is **never** recorded
  `success`, even when the agent went on to finish its turn without the tool.
- To let a scheduled task actually perform a gated operation, author an explicit
  **permission rule** for it. Rules are matched before a prompt is raised, so an
  allow-rule is the one auditable, human-authored way to widen what a scheduled
  run may do — and the protected-path / secret-read floor still cannot be
  bypassed by one.

Each run records a last-run result plus its session id into the registry:

| status | meaning |
|--------|---------|
| `success` | the turn completed and no permission prompt was raised |
| `error` | the run happened and failed — including a run whose tool calls were denied |
| `timeout` | the run exceeded the per-run timeout and was abandoned |
| `skipped` | the slot passed unused (the daemon was down past the grace window) |
| `refused` | **nothing ran** — unsupported provider, disallowed cwd, or an unverifiable permission mode. A misconfiguration to fix, not a transient failure |

Runs are serialized (one at a time by default) so a burst of simultaneously-due
tasks cannot spawn a herd of sessions, a task is never re-fired while its previous
run is still in flight, and a task whose due time passed while the daemon was down
is skipped rather than fired late if it is more than an hour stale.

## Examples

### Using Config File Only

```bash
npx chroxy init  # Creates ~/.chroxy/config.json
npx chroxy start
```

### Overriding with Environment Variables

```bash
PORT=9000 CHROXY_MODEL=opus npx chroxy start
```

### Overriding with CLI Flags

```bash
npx chroxy start --model haiku --cwd ~/projects/myapp
```

### Combined Example

```bash
# Config file has: port=8765, model=sonnet
# Environment has: PORT=9000
# CLI flag has: --model haiku

npx chroxy start --model haiku

# Result: port=9000 (ENV), model=haiku (CLI)
```

## Validation

Chroxy validates the configuration at startup:

- **Unknown keys** in the config file trigger warnings (they are ignored)
- **Type mismatches** trigger warnings (e.g., port should be a number, not a string)
- Warnings are non-fatal - the server will still start

### Verbose Mode

Use `--verbose` to see exactly where each config value comes from:

```bash
npx chroxy start --verbose
```

Output example:
```
[config] Configuration sources:
  apiToken         = "abc12345..."       (config file)
  port             = 9000                (ENV)
  model            = "haiku"             (CLI)
  cwd              = "/Users/me/project" (default)
```

## `--no-auth` Trust Model

`--no-auth` is a **dev-only** mode. It is intended for running Chroxy against
loopback while iterating locally. When enabled:

- The server binds to `127.0.0.1` only — tunnel startup is skipped (any
  `--tunnel` flag is ignored, with an error logged if one was passed) and
  mDNS/Bonjour advertisement is disabled.
- Connecting clients are auto-authenticated immediately on WebSocket upgrade,
  without presenting an API token or going through the pairing flow.
- The token manager, pairing manager, and periodic token rotation are all
  disabled.

### Protocol-version assumption

Because `--no-auth` skips the auth handshake, the client never advertises its
protocol version. In that case the server pins the client's effective version
to its own `SERVER_PROTOCOL_VERSION` so that version-gated broadcasts (for
example the `server_status` tunnel-warming / ready events that require the
`TUNNEL_STATUS_MIN_PROTOCOL_VERSION` floor) reach dev clients instead of being
silently filtered out.

**The assumption is: a client connecting to a `--no-auth` dev server is built
from the same commit as the server and therefore speaks
`SERVER_PROTOCOL_VERSION`.** The server trusts itself and its local clients.
This is correct for the intended use — a freshly-built dashboard, app, or
`test-client.js` on the same developer machine.

**Known limitation:** if a stale-build client (shipped before a protocol
version bump) connects to a newer `--no-auth` dev server, it will receive
message shapes it cannot parse and may mis-render them. Rebuild the client
against the same commit as the server when you hit this. This is why
`--no-auth` is gated to loopback and why it must **not** be broadened to
remote fleets (CI runners, containerised test rigs reachable off-host, shared
dev hosts) without first reintroducing a protocol-version negotiation step
for un-authenticated clients.

### Operational guardrails

- `--no-auth` forces loopback-only binding and skips tunnel startup, so the
  server cannot be accidentally exposed to the public internet while auth is
  off. A warning is logged at startup, and an additional error is logged if
  a `--tunnel` flag was also passed.
- `chroxy dev` refuses to start with `noAuth: true` — the supervised dev
  workflow always requires a token.

## Best Practices

1. **Keep secrets in config file or environment variables** - Don't pass `--api-token` as a CLI flag (it would be visible in process lists)
2. **Use environment variables for deployment-specific values** - port, working directory, model selection
3. **Use CLI flags for one-off overrides** - testing different models, changing working directory temporarily
4. **Run `npx chroxy config`** to see your current config file contents
5. **Treat `--no-auth` as dev-only** - see the [`--no-auth` Trust Model](#--no-auth-trust-model) section above. Never pair `--no-auth` with a tunnel or a non-loopback bind.

## Troubleshooting

### Unknown key warnings

If you see warnings like:
```
⚠ Configuration warnings:
  - Unknown config key: 'maxConnections' (will be ignored)
```

This means your config file contains keys that Chroxy doesn't recognize. They will be ignored. Check for typos or remove unused keys.

### Type mismatch warnings

If you see warnings like:
```
⚠ Configuration warnings:
  - Invalid type for 'port': expected number, got string
```

Fix the type in your config file:
```json
{
  "port": 8765,  // number, not "8765" string
  "resume": true  // boolean, not "true" string
}
```

### Config not found

If you see:
```
❌ No config found. Run 'npx chroxy init' first.
```

Run `npx chroxy init` to create the config file, or specify a custom path:
```bash
npx chroxy start --config /path/to/config.json
```
