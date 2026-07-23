# Configuration Guide

Chroxy supports configuration from multiple sources with a clear precedence order.

## Precedence Order

Configuration values are resolved in the following order (highest priority first):

1. **CLI flags** - Command-line options passed to `npx chroxy start`
2. **Environment variables** - System environment variables
3. **Config file** - `~/.chroxy/config.json` (created with `npx chroxy init`)
4. **Defaults** - Built-in default values

## Configuration Keys

| Key | Type | CLI Flag | Environment Variable | Description |
|-----|------|----------|---------------------|-------------|
| `apiToken` | string | - | `API_TOKEN` | Authentication token for clients |
| `sessionTokenTtl` | string | - | `CHROXY_SESSION_TOKEN_TTL` | *(default `30d`)* How long a paired device's session token stays valid without reconnecting (#6598). **Sliding** — each successful connect refreshes it, so only an *idle* device expires. A duration string (`30d`, `15d`, `12h`); floored at 5 min. Tokens are persisted encrypted at rest (`~/.chroxy/session-tokens.json`), so they now survive daemon restarts. Longer = fewer re-pairs but a wider stolen-token window; you own the dial. |
| `port` | number | - | `PORT` | Local WebSocket port (default: 8765) |
| `host` | string | `--host <address>` | `CHROXY_HOST` | Bind address for the server socket. Unset binds `0.0.0.0` (all interfaces) so the mobile app / LAN clients can reach it. Set to `127.0.0.1` for a loopback-only bind that keeps auth enabled — opt-in defence-in-depth for single-device setups. `--no-auth` always forces loopback regardless of this key. When bound to loopback the mDNS `_chroxy._tcp` advertisement is suppressed (the server is not LAN-reachable). |
| `provider` | string | `--provider <name>` | `CHROXY_PROVIDER` | Default session backend. Allowed values: `claude-tui` (default, #5819), `claude-sdk`, `claude-cli`, `claude-channel` (research preview), `gemini`, `codex`, plus `docker-sdk` / `docker-cli` when Docker environments are enabled. The `claude-channel` provider is a research-preview scaffold whose `start()` currently throws — selectable for `chroxy doctor` / registry inspection but not yet runnable (bridge lands in #3954). See [../../docs/providers.md](../../docs/providers.md) for per-provider setup, env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …), and the capability matrix. |
| `shell` | string | - | `SHELL_CMD` | Shell to use (default: `$SHELL` or `/bin/zsh`) |
| `cwd` | string | `--cwd <path>` | `CHROXY_CWD` | Working directory (CLI mode) |
| `model` | string | `--model <name>` | `CHROXY_MODEL` | Model to use. Provider-specific — e.g. `claude-sonnet-4`/`haiku` for Claude, `gemini-2.5-pro` for Gemini, `gpt-5.4` for Codex. |
| `allowedTools` | array | `--allowed-tools <list>` | `CHROXY_ALLOWED_TOOLS` | Auto-approved tools (CLI mode) |
| `noAuth` | boolean | `--no-auth` | `CHROXY_NO_AUTH` | Disable authentication (localhost only) |
| `costBudget` | number | `--cost-budget <dollars>` | `CHROXY_COST_BUDGET` | Per-session cost budget in dollars. Applied independently to each session (not a shared pool across sessions). Warns at 80%, pauses the session at 100%. |
| `providers` | array \| object | - | `CHROXY_PROVIDERS` | Two forms. **Array** (legacy, written by `chroxy init`): informational list of provider ids the user opted into. **Object** (#5419): `providers.anthropicCompatible` is an array of config-driven Anthropic-compatible endpoint entries (Z.ai GLM, Moonshot Kimi, MiniMax, LM Studio, llama.cpp, vLLM, OpenRouter, custom) — each entry `{ id, label?, baseUrl, apiKeyEnv?, credentialsKey?, defaultModel, models?, pricing?, contextWindow? }` registers a first-class provider at startup, selectable via `provider` / `--provider <id>`. API keys are **never** inlined: `apiKeyEnv` names an env var, `credentialsKey` names a `~/.chroxy/credentials.json` field (mode `0600`); entries carrying literal secrets are rejected. Invalid entries are warned about and skipped; valid siblings still register. See [Anthropic-compatible endpoints](../../docs/providers.md#anthropic-compatible-endpoints-config-driven). |
| `promptEvaluatorSkipPattern` | string | - | - | Per-session regex source (case-insensitive) extending the default skip list used by the prompt evaluator's trivial-message heuristic. See [Prompt evaluator skip heuristic](#prompt-evaluator-skip-heuristic) below. |
| `maxSkillBytes` | number | - | - | Per-skill byte cap. Skills exceeding this size are rejected with a sanitised log warning. Default `32768` (32KB). Set to `0` to disable the per-skill cap. |
| `maxTotalSkillBytes` | number | - | - | Global skills-context budget. When a session's merged active-skill set exceeds this size, lower-priority skills are dropped first (frontmatter `priority` defaults to 100; ties broken alphabetically). Default `262144` (256KB). Set to `0` to disable the global cap. |
| `providerSkillAllowlist` | object | - | - | Per-provider skill allowlist. Object keyed by provider id (e.g. `codex`, `gemini`); each value is an array of skill names that may load for that provider. See [Per-provider skill allowlist](#per-provider-skill-allowlist) below. |
| `trustMismatchMode` | string | - | - | One of `warn` or `block`. When set, the server records a SHA-256 hash of every loaded skill on first activation and compares it on every subsequent load. See [Skill content-hash trust](#skill-content-hash-trust) below. Disabled (no hashing) when omitted. |
| `binaryProvenance` | object | - | `CHROXY_BINARY_PROVENANCE`, `CHROXY_BINARY_SIGNATURE_GATE` | Opt-in provenance verification for spawned provider binaries (`claude`, `codex`, `gemini`, `cloudflared`). `mode` (`off`/`warn`/`block`) drives a cross-platform SHA-256 pin ledger; `signatureGate` (boolean) toggles a macOS `spctl` notarization gate. Both OFF by default. See [Binary provenance verification](#binary-provenance-verification) below. |
| `dangerouslySkipPermissions` | boolean | `--dangerously-skip-permissions` | `CHROXY_DANGEROUSLY_SKIP_PERMISSIONS` | Server-wide default for the per-session skip-permissions flag (#4246, #4384). Honoured only by the `claude-tui` provider — spawns claude with `--dangerously-skip-permissions` and elides chroxy's permission hook. Off by default. Legacy alias `skipPermissions` (config key) and `CHROXY_SKIP_PERMISSIONS` (env var) are still honoured for one deprecation window and emit a warning at boot — rename to the canonical key. See [Skip permissions (TUI provider)](#skip-permissions-tui-provider) below. |
| `resultTimeoutMs` | number | - | `CHROXY_RESULT_TIMEOUT_MS` | Per-session **soft-warning** inactivity window in milliseconds. When no SDK / CLI event arrives within this window, the server emits an `inactivity_warning` event (#3899) so clients can render a check-in chip and surface a push notification — the session stays alive. The kill path is `hardTimeoutMs` (below). See [Inactivity safety net](#inactivity-safety-net). Default `1800000` (30 min); range `30000`–`86400000` (30 s – 24 h). |
| `hardTimeoutMs` | number | - | `CHROXY_HARD_TIMEOUT_MS` | Per-session **hard-kill** inactivity window in milliseconds. When `resultTimeoutMs` has already fired and silence continues to this longer threshold, the server emits `permission_expired` for every outstanding permission prompt, force-clears busy state, and emits a generic `error` event with `"Response timed out after <duration> of inactivity"` (#3899). Default `7200000` (2 h); range `30000`–`86400000` (30 s – 24 h). Must be ≥ `resultTimeoutMs` or the soft warning never fires — validator warns. |
| `backgroundShellHardQuiesceMs` | number | - | `CHROXY_BACKGROUND_SHELL_HARD_QUIESCE_MS` | How long a background shell (`Bash` with `run_in_background: true`) may go with **no new output** before the server treats it as finished and **reaps** its liveness tracking, so a finished-but-never-polled command stops pinning the session `running` forever (#5265). Default `14400000` (4 h); range `60000`–`86400000` (60 s – 24 h), or **`0` to disable** hard-reaping (advisory-only, the #5247 behaviour). **Tradeoff:** a genuinely long-running compute that emits no output for hours (and is never polled via `BashOutput`) could have its tracking reaped and the session become idle-timeout-eligible. A noisy long-runner (e.g. a dev server logging within the window) keeps its output-file mtime fresh and is never reaped. Operators running long silent computes should raise this (e.g. 6–8 h) or set `0`. |
| _(env-only)_ | number | - | `CHROXY_DIAGNOSTICS_RATE_LIMIT` | Per-source-IP request cap on `GET /diagnostics` over a 60 s sliding window (#3737). The endpoint reads the on-disk log tail and iterates every session per call, so it is rate-limited to protect against a stolen-token tight loop. Default `12` requests/min with a 4-request burst. Set the env var to an **integer ≥ 1** to override `maxMessages`; the burst auto-derives as `max(1, floor(N/3))`. Invalid values (non-integer, < 1, NaN) silently fall through to the default — including sub-integer values like `0.5`, which are rejected outright (truncating to `0` would otherwise raise the limit via RateLimiter's `||` fallback). No `config.json` key is exposed; this setting is intentionally env-only. Overshoot returns `429` with a `Retry-After` header and a JSON body `{ "error": "rate limited", "retryAfterMs": <ms> }`. |

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

Status-message state (message ids, current state per project) persists in
`~/.chroxy/discord-webhook-state.json`; the billing-alert message tracks its own
id in `~/.chroxy/discord-billing-state.json`. Full setup walkthrough:
[docs/guides/discord-notifications.md](../../docs/guides/discord-notifications.md).

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
