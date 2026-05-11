# Chroxy server config keys

Operator-facing reference for selected `~/.chroxy/config.json` keys.

Config is loaded with the following precedence (highest first):

1. CLI flags
2. Environment variables
3. `~/.chroxy/config.json`
4. Built-in defaults

This page documents the keys whose source code comments point at it. It is intentionally not exhaustive — see `packages/server/src/config.js` (`CONFIG_SCHEMA`) for the full list of accepted keys.

---

## `resultTimeoutMs`

Per-session inactivity safety net (#3749). When no SDK / CLI event arrives within this window, the server force-clears the session's busy state and emits a `result_timeout` error.

| | |
|---|---|
| Type | `number` (milliseconds) |
| Default | `1200000` (20 min) |
| Range | `30000` – `86400000` (30 s – 24 h) |
| Env var | `CHROXY_RESULT_TIMEOUT_MS` |

The legacy value was 5 min, which proved too aggressive for legitimately slow tools (large fetches, long Bash commands, extended thinking). Lengthen this if you regularly hit timeouts during long-running operations; shorten it if you want faster recovery from genuinely stuck sessions.

Values outside the range emit a warn-only log line during config validation — the runtime applies the configured value either way. Schema validation in the WS protocol (`@chroxy/protocol`) rejects ms-typed fields above 24 h (#3768), so values above the ceiling never reach the dashboard / app.

While a permission prompt is outstanding the inactivity timer is paused; on resolution it re-arms with this same window (#2831, #3757).

The value is broadcast to clients as `resultTimeoutMs` on the `auth_ok` message (#3760), letting the dashboard / app `ActivityIndicator` warn the user when a turn is approaching the configured timeout.

---

## `promptEvaluatorSkipPattern`

Per-server regex source extending the default continuation-pattern skip list used by `shouldSkipEvaluator` (#3187).

| | |
|---|---|
| Type | `string` (regex source) |
| Default | unset |
| Env var | none |

Malformed regex sources are logged and ignored — the built-in default still applies. Sessions inherit this server-wide value at construction; per-session overrides are exposed via the WS `set_prompt_evaluator_skip_pattern` message.

---

## `maxSkillBytes` and `maxTotalSkillBytes`

Skills MVP byte budgets (#3202).

| Key | Default | What it caps |
|---|---|---|
| `maxSkillBytes` | `32768` (32 KB) | Per-skill body size |
| `maxTotalSkillBytes` | `262144` (256 KB) | Combined size of all active skills in a turn |

A single skill exceeding its per-skill cap is rejected before activation. A merged active set exceeding the global cap is pruned in priority order (ascending `priority`, then alphabetical name) until it fits. Setting either value to `0` disables that cap entirely.

---

## `providerSkillAllowlist`

Per-provider skill allowlist (#3207). Object keyed by provider id (e.g. `codex`, `gemini`), with each value an array of skill names permitted to load for that provider.

| | |
|---|---|
| Type | `object` (`{ [providerId: string]: string[] }`) |
| Default | unset (permissive — every skill loads for every provider) |

Semantics when the map is **set**:

- Claude-family providers (`claude-sdk`, `claude-cli`, `docker-*`) stay permissive (Claude has built-in tool gating, lower risk).
- For other providers (`codex`, `gemini`, …), only the skills explicitly listed for that provider load. A missing key OR an empty array filters out **all** skills for that provider — fail-secure.

When the map is **unset**, the loader keeps the original permissive behaviour for every provider.

---

## `trustMismatchMode`

Skill content-hash mismatch policy (#3204). The skills trust ledger records a content hash for each skill on first load; on subsequent loads, a hash mismatch is treated according to this mode.

| | |
|---|---|
| Type | `'warn'` \| `'block'` |
| Default | trust checking is **disabled** unless an explicit valid value is set |

| Mode | Behaviour on mismatch |
|---|---|
| `warn` | Sanitised warn log + `skill_changed` WS event; skill still loads. |
| `block` | Same warn + event; skill is filtered out of the active set until the operator explicitly re-trusts it. |

Invalid values disable trust checking — this is intentional. The trust ledger is opt-in, not implicit. Operators who want skill-tampering protection must pick `'warn'` or `'block'`.

---

For schema-level validation rules (type checks, range warnings, env-var mapping), see `packages/server/src/config.js`. For the WebSocket-side schema invariants (e.g. the 24 h ceiling on ms-typed fields), see `packages/protocol/src/schemas/server.ts`.
