/**
 * Idempotent installer for the hook emitters (#5413 Phase 4).
 *
 * Registers one `chroxy-hooks emit <type>` command per Claude Code hook
 * event in `~/.claude/settings.json` (port of claude-code-notify's
 * install.sh semantics). Hard rules:
 *
 *   - idempotent: install is prune-then-add, so re-running converges to
 *     exactly one entry of ours per event (and migrates stale paths from a
 *     previous checkout location)
 *   - never clobbers unrelated hooks: only commands containing the
 *     COMMAND_MARKER are ever touched; other entries/matcher groups/event
 *     keys pass through structurally unchanged (the whole file is
 *     re-serialized as 2-space JSON, so FORMATTING may normalize — the
 *     data never changes)
 *   - uninstall removes ONLY our own entries (groups/event arrays left
 *     empty by that removal are dropped; everything else untouched)
 *   - unparseable settings.json → abort with an error, never overwrite
 *   - atomic write: temp file + rename in the same directory
 *
 * The registered command embeds the absolute node binary
 * (process.execPath) and the absolute bin script path so hooks don't
 * depend on the (often minimal) hook-environment PATH and skip npx
 * resolution entirely — that's most of the <100ms budget.
 *
 * Tests inject `settingsPath` — never the real ~/.claude/settings.json.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** Substring identifying our own hook commands (install/uninstall/dedupe key). */
export const COMMAND_MARKER = 'chroxy-hooks'

/** Hook events we register, in settings.json order. */
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'PostToolUse',
]

/** Ingest type passed to `emit` per hook event. */
export const TYPE_FOR_HOOK_EVENT = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Notification: 'notification',
  PostToolUse: 'post_tool_use',
}

/**
 * Notification entries carry the same matchers claude-code-notify shipped
 * (idle prompts + permission prompts — the two ping-worthy states). Other
 * events register matcher-less (fire on everything).
 */
const NOTIFICATION_MATCHERS = ['idle_prompt', 'permission_prompt']

export function defaultSettingsPath(env = process.env) {
  if (typeof env.CHROXY_HOOKS_SETTINGS_PATH === 'string' && env.CHROXY_HOOKS_SETTINGS_PATH.length > 0) {
    return env.CHROXY_HOOKS_SETTINGS_PATH
  }
  return join(homedir(), '.claude', 'settings.json')
}

export function defaultBinPath() {
  return fileURLToPath(new URL('../bin/chroxy-hooks.js', import.meta.url))
}

/** Shell-safe single quoting for embedded absolute paths. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function buildHookCommand(hookEvent, { nodePath = process.execPath, binPath = defaultBinPath() } = {}) {
  const type = TYPE_FOR_HOOK_EVENT[hookEvent]
  if (!type) throw new Error(`Unknown hook event: ${hookEvent}`)
  return `${shellQuote(nodePath)} ${shellQuote(binPath)} emit ${type}`
}

function isOurs(hookEntry) {
  return hookEntry
    && hookEntry.type === 'command'
    && typeof hookEntry.command === 'string'
    && hookEntry.command.includes(COMMAND_MARKER)
}

/**
 * Remove our own commands from every matcher group of the given event
 * array. Returns the pruned array (groups whose `hooks` end up empty are
 * dropped); unrelated groups and commands are preserved as-is.
 */
function pruneEventArray(entries) {
  if (!Array.isArray(entries)) return entries
  const pruned = []
  for (const group of entries) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      pruned.push(group)
      continue
    }
    const kept = group.hooks.filter((h) => !isOurs(h))
    if (kept.length === group.hooks.length) {
      pruned.push(group)
    } else if (kept.length > 0) {
      pruned.push({ ...group, hooks: kept })
    }
    // group dropped entirely when our removal left it empty
  }
  return pruned
}

/**
 * Pure transform: remove every chroxy-hooks entry from a settings object.
 * Event keys we manage that end up as empty arrays are deleted; everything
 * else (including other hook events and empty arrays we did not cause) is
 * left untouched.
 */
export function removeOwnHooks(settings) {
  const out = { ...settings }
  if (!out.hooks || typeof out.hooks !== 'object') return out
  const hooks = { ...out.hooks }
  for (const event of Object.keys(hooks)) {
    const before = hooks[event]
    if (!Array.isArray(before)) continue
    const hadOurs = before.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs))
    if (!hadOurs) continue
    const pruned = pruneEventArray(before)
    if (pruned.length === 0) {
      delete hooks[event]
    } else {
      hooks[event] = pruned
    }
  }
  out.hooks = hooks
  return out
}

/**
 * Pure transform: prune our stale entries, then append exactly one fresh
 * entry per managed hook event (two for Notification — one per matcher).
 */
export function addOwnHooks(settings, { nodePath, binPath } = {}) {
  const out = removeOwnHooks(settings)
  const hooks = { ...(out.hooks && typeof out.hooks === 'object' ? out.hooks : {}) }
  for (const event of HOOK_EVENTS) {
    // A managed event key holding something other than an array is a
    // malformed settings.json — appending would silently clobber whatever
    // the user had there. Same policy as unparseable JSON: abort, never
    // destroy.
    if (event in hooks && hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new Error(`hooks.${event} in settings.json has an unexpected shape (expected an array) — fix or remove it, then re-run`)
    }
    const command = buildHookCommand(event, { nodePath, binPath })
    const entry = { type: 'command', command }
    const existing = Array.isArray(hooks[event]) ? hooks[event] : []
    if (event === 'Notification') {
      hooks[event] = [
        ...existing,
        ...NOTIFICATION_MATCHERS.map((matcher) => ({ matcher, hooks: [entry] })),
      ]
    } else {
      hooks[event] = [...existing, { hooks: [entry] }]
    }
  }
  out.hooks = hooks
  return out
}

function readSettings(settingsPath) {
  let raw
  try {
    raw = readFileSync(settingsPath, 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw new Error(`Cannot read ${settingsPath}: ${err.message}`)
  }
  if (raw.trim().length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // NEVER overwrite a file we cannot parse — the user fixes it first.
    throw new Error(`${settingsPath} is not valid JSON — fix or remove it, then re-run`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} does not contain a JSON object`)
  }
  return parsed
}

function writeSettingsAtomic(settingsPath, settings) {
  mkdirSync(dirname(settingsPath), { recursive: true })
  // Preserve the existing file's mode across the temp+rename — settings.json
  // can carry sensitive values (env, apiKeyHelper) and users may have
  // tightened it to 0600; a default-mode temp file must not loosen that.
  let mode = null
  try {
    mode = statSync(settingsPath).mode & 0o777
  } catch {
    // New file — default mode (umask applies).
  }
  const tmpPath = `${settingsPath}.chroxy-hooks-${process.pid}.tmp`
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', mode === null ? { encoding: 'utf-8' } : { encoding: 'utf-8', mode })
  renameSync(tmpPath, settingsPath)
}

/** Install (idempotent). Returns the settings path written. */
export function installHooks({ settingsPath = defaultSettingsPath(), nodePath, binPath } = {}) {
  const settings = readSettings(settingsPath)
  const next = addOwnHooks(settings, { nodePath, binPath })
  writeSettingsAtomic(settingsPath, next)
  return settingsPath
}

/** Uninstall: removes ONLY our own entries. Missing file is a no-op. */
export function uninstallHooks({ settingsPath = defaultSettingsPath() } = {}) {
  const settings = readSettings(settingsPath)
  if (Object.keys(settings).length === 0) return settingsPath
  const next = removeOwnHooks(settings)
  writeSettingsAtomic(settingsPath, next)
  return settingsPath
}
