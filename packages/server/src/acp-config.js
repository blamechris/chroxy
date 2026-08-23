/**
 * Config-driven ACP (Agent Client Protocol) provider endpoints (#7319, part of
 * the #7304/#7306 ACP-interop tranche) — validation + normalization for the
 * `providers.acp` config block.
 *
 * Any agent that speaks ACP (see https://agentclientprotocol.com) can be
 * declared in config.json under `providers.acp` and registered as a
 * first-class provider at startup — one spawn `command`/`args`/`env`, no
 * bespoke session class. Entries are validated here and registered by
 * `registerAcpProviders` (acp-session.js).
 *
 * Entry shape:
 *   {
 *     "id": "my-agent",                  // required — provider id (lowercase, digits, dashes)
 *     "label": "My Agent",               // optional — dashboard label (defaults to id)
 *     "command": "/path/to/agent-cli",   // required — executable spawned over stdio (absolute path or PATH-resolvable)
 *     "args": ["--acp"],                 // optional — argv passed to the executable (default [])
 *     "env": { "SOME_VAR": "value" }     // optional — extra environment variables for the child (default {})
 *   }
 *
 * Unlike the Anthropic/OpenAI-compatible blocks' `apiKeyEnv`/`credentialsKey`
 * indirection, `env` here is a literal passthrough: ACP agents authenticate
 * themselves (their own OAuth / API-key story), so there is no chroxy-side
 * credential to name — the same shape Zed's `agent_servers` config uses. This
 * module only validates that every value is a string (a malformed non-string
 * value would otherwise reach `child_process.spawn`'s env object as-is);
 * whether config.json is an appropriate place to put a given value is the
 * operator's call, same as any locally-edited config file. The AMBIENT
 * daemon environment does NOT pass through to the child by default — the
 * agent's `command` is entirely operator-chosen and unvetted, so
 * `buildAcpChildEnv` (acp-session.js) uses the ALLOWLIST posture
 * `spawn-env.js` reserves for third-party providers (`STANDARD_ALLOWLIST`),
 * not the denylist posture reserved for the first-party Claude CLI: nothing
 * outside that baseline reaches the child unless THIS `env` map adds it.
 * Chroxy's OWN daemon secret (the primary bearer token,
 * `CHROXY_SECRET_DENYLIST` in spawn-env.js) is additionally stripped
 * UNCONDITIONALLY at spawn time — applied in acp-session.js AFTER this map is
 * merged in, so it can never be smuggled back in via this map either.
 *
 * Permissions ship DENIED BY DEFAULT for every entry registered from this
 * block (#7319) — there is no config knob to change that yet. #7320 wires the
 * real permission bridge.
 *
 * This module is deliberately dependency-free (no SDK, no logger) so
 * config.js can import it without pulling the spawn/ACP-SDK machinery into
 * the config-load path — same rationale as anthropic-compatible-config.js.
 */

// Reused (not duplicated) — this IS the live "which ids can a config-driven
// provider never claim" list. `PROVIDER_ID_RE` below is a local literal
// copy of anthropic-compatible-config.js's own regex rather than an import:
// that module documents duplicating its own char-class regexes (the Rancher
// note in config.js) precisely so this module can stay import-light; the
// RESERVED ID list is different — a real, growing set of names — so THAT is
// worth importing to avoid drift.
import { RESERVED_PROVIDER_IDS } from './anthropic-compatible-config.js'

export { RESERVED_PROVIDER_IDS }

// Provider id charset — mirrors anthropic-compatible-config.js's
// `PROVIDER_ID_RE` verbatim: lowercase letter first, then lowercase letters,
// digits, or dashes; max 64 chars.
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/

const KNOWN_ENTRY_KEYS = new Set(['id', 'label', 'command', 'args', 'env'])

function typeName(value) {
  return Array.isArray(value) ? 'array' : typeof value
}

/**
 * Validate ONE entry; returns the normalized frozen entry, or null when the
 * entry must be dropped. Pushes human-readable warnings either way.
 */
function validateEntry(raw, path, seenIds, reservedIds, warnings) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(`Invalid value for '${path}': expected an object, got ${typeName(raw)}`)
    return null
  }

  let valid = true

  for (const key of Object.keys(raw)) {
    if (!KNOWN_ENTRY_KEYS.has(key)) {
      warnings.push(`Unknown key '${path}.${key}' (will be ignored)`)
    }
  }

  // --- id ---
  const id = raw.id
  if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id)) {
    warnings.push(
      `Invalid value for '${path}.id': expected a lowercase identifier (letters, digits, dashes; must start with a letter, max 64 chars), got ${JSON.stringify(id)}`,
    )
    valid = false
  } else if (reservedIds.has(id)) {
    warnings.push(`Invalid value for '${path}.id': '${id}' collides with a built-in or already-registered provider id`)
    valid = false
  } else if (seenIds.has(id)) {
    warnings.push(`Invalid value for '${path}.id': duplicate id '${id}' (already declared by an earlier entry)`)
    valid = false
  }

  // --- label ---
  let label = typeof id === 'string' ? id : null
  if (Object.prototype.hasOwnProperty.call(raw, 'label')) {
    if (typeof raw.label !== 'string' || raw.label.length === 0) {
      warnings.push(`Invalid value for '${path}.label': expected a non-empty string, got ${JSON.stringify(raw.label)} — falling back to the id`)
    } else {
      label = raw.label
    }
  }

  // --- command ---
  const command = raw.command
  if (typeof command !== 'string' || command.trim().length === 0) {
    warnings.push(`Invalid value for '${path}.command': required — the executable to spawn (absolute path, or one resolvable on PATH)`)
    valid = false
  }

  // --- args ---
  let args = []
  if (Object.prototype.hasOwnProperty.call(raw, 'args')) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
      warnings.push(`Invalid value for '${path}.args': expected an array of strings, got ${typeName(raw.args)}`)
      valid = false
    } else {
      args = [...raw.args]
    }
  }

  // --- env ---
  let env = {}
  if (Object.prototype.hasOwnProperty.call(raw, 'env')) {
    if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
      warnings.push(`Invalid value for '${path}.env': expected an object of string environment variables, got ${typeName(raw.env)}`)
      valid = false
    } else {
      const normalizedEnv = {}
      let envValid = true
      for (const key of Object.keys(raw.env)) {
        if (typeof raw.env[key] !== 'string') {
          warnings.push(`Invalid value for '${path}.env.${key}': expected a string, got ${typeName(raw.env[key])}`)
          envValid = false
          continue
        }
        normalizedEnv[key] = raw.env[key]
      }
      if (envValid) {
        env = normalizedEnv
      } else {
        valid = false
      }
    }
  }

  if (!valid) return null

  seenIds.add(id)
  return Object.freeze({
    id,
    label,
    command: command.trim(),
    args: Object.freeze(args),
    env: Object.freeze(env),
  })
}

/**
 * Validate + normalize the `providers.acp` array.
 *
 * Never throws. Invalid entries are dropped (with a warning each); valid
 * siblings survive — same "drop bad entries, keep the rest" contract as
 * `validateAnthropicCompatibleProviders`.
 *
 * @param {*} value - The raw `providers.acp` value
 * @param {{ reservedIds?: Iterable<string> }} [opts] - Extra ids the entries
 *   may not claim (the live registry at registration time); the static
 *   RESERVED_PROVIDER_IDS are always included.
 * @returns {{ entries: Array<object>, warnings: string[] }} Normalized frozen
 *   entries: `{ id, label, command, args, env }`.
 */
export function validateAcpProviders(value, opts = {}) {
  const warnings = []
  const entries = []

  if (!Array.isArray(value)) {
    warnings.push(`Invalid value for 'providers.acp': expected an array of agent entries, got ${typeName(value)}`)
    return { entries, warnings }
  }

  const reservedIds = new Set(RESERVED_PROVIDER_IDS)
  if (opts.reservedIds) {
    for (const id of opts.reservedIds) reservedIds.add(id)
  }

  const seenIds = new Set()
  for (let i = 0; i < value.length; i++) {
    const normalized = validateEntry(value[i], `providers.acp[${i}]`, seenIds, reservedIds, warnings)
    if (normalized) entries.push(normalized)
  }

  return { entries, warnings }
}
