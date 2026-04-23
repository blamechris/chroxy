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
| `port` | number | - | `PORT` | Local WebSocket port (default: 8765) |
| `tmuxSession` | string | - | `TMUX_SESSION` | tmux session name (PTY mode only) |
| `shell` | string | - | `SHELL_CMD` | Shell to use (default: `$SHELL` or `/bin/zsh`) |
| `cwd` | string | `--cwd <path>` | `CHROXY_CWD` | Working directory (CLI mode) |
| `model` | string | `--model <name>` | `CHROXY_MODEL` | Claude model to use (CLI mode) |
| `allowedTools` | array | `--allowed-tools <list>` | `CHROXY_ALLOWED_TOOLS` | Auto-approved tools (CLI mode) |
| `resume` | boolean | `--resume` / `-r` | `CHROXY_RESUME` | Resume existing session |
| `noAuth` | boolean | `--no-auth` | `CHROXY_NO_AUTH` | Disable authentication (localhost only) |
| `costBudget` | number | `--cost-budget <dollars>` | `CHROXY_COST_BUDGET` | Per-session cost budget in dollars. Applied independently to each session (not a shared pool across sessions). Warns at 80%, pauses the session at 100%. |

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
