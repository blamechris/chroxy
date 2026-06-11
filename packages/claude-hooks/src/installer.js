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

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

/** The exact emit types the installer ever writes. */
const KNOWN_EMIT_TYPES = new Set(Object.values(TYPE_FOR_HOOK_EVENT))

/**
 * Matches ONLY commands of the exact shape this installer writes:
 *   '<nodePath>' '<binPath>' emit <type>
 * where <binPath> carries the COMMAND_MARKER. Both paths are single-quoted
 * (shellQuote), there are no shell operators, and the trailing token is one
 * of our known emit types. This is deliberately stricter than a bare
 * `includes(COMMAND_MARKER)` substring: a user's compound command that wraps
 * our emitter (`'…' '…/chroxy-hooks.js' emit … && afplay ding.aiff`) is NOT
 * ours and must survive install/uninstall untouched.
 *
 * The match is structural, not path-pinned, so it still recognizes our own
 * entries written from a STALE checkout path (different binPath, same shape) —
 * that's what makes the prune-then-add migration converge.
 *
 *   group 1: node path (inside quotes)
 *   group 2: bin/script path (inside quotes) — must contain the marker
 *   group 3: emit type
 */
const OUR_COMMAND_RE = /^'((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' emit ([a-z_]+)$/

function isOurs(hookEntry) {
  if (
    !hookEntry
    || hookEntry.type !== 'command'
    || typeof hookEntry.command !== 'string'
  ) {
    return false
  }
  const m = OUR_COMMAND_RE.exec(hookEntry.command)
  if (!m) return false
  const scriptPath = m[2]
  const emitType = m[3]
  return scriptPath.includes(COMMAND_MARKER) && KNOWN_EMIT_TYPES.has(emitType)
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
 * A top-level `hooks` must be a plain object (event-name → array) or absent.
 * An array or string (or any non-plain-object) is malformed: spreading an
 * array yields numeric keys and a string is silently dropped — both destroy
 * user data. Same policy as unparseable JSON: abort, never destroy.
 */
function assertHooksShape(hooks) {
  if (hooks === undefined || hooks === null) return
  if (typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new Error('hooks in settings.json has an unexpected shape (expected an object) — fix or remove it, then re-run')
  }
}

/**
 * Pure transform: remove every chroxy-hooks entry from a settings object.
 * Event keys we manage that end up as empty arrays are deleted; everything
 * else (including other hook events and empty arrays we did not cause) is
 * left untouched.
 */
export function removeOwnHooks(settings) {
  const out = { ...settings }
  assertHooksShape(out.hooks)
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

  // If settings.json is a symlink (dotfile managers: stow, chezmoi, yadm),
  // resolve to the real target BEFORE the temp+rename so the write lands at
  // the link target and the user's symlink is preserved. realpathSync throws
  // ENOENT for a brand-new file (or a dangling link) — fall back to the path
  // as given. We resolve the parent dir + basename separately so a NEW file
  // inside a symlinked DIRECTORY still resolves correctly.
  let realPath = settingsPath
  try {
    realPath = realpathSync(settingsPath)
  } catch {
    try {
      realPath = join(realpathSync(dirname(settingsPath)), basename(settingsPath))
    } catch {
      // Parent doesn't resolve either — use the path as given.
    }
  }

  // Preserve the existing file's mode across the temp+rename — settings.json
  // can carry sensitive values (env, apiKeyHelper) and users may have
  // tightened it to 0600; a default-mode temp file must not loosen that.
  let mode = null
  try {
    mode = statSync(realPath).mode & 0o777
  } catch {
    // New file — default mode (umask applies).
  }
  const tmpPath = `${realPath}.chroxy-hooks-${process.pid}.tmp`
  const payload = JSON.stringify(settings, null, 2) + '\n'
  // Open ONCE with 'w' (create, default mode), write, then fsync on the same
  // fd before rename so a crash can't leave a torn write on filesystems where
  // rename outruns the data flush. We do NOT pass the preserved mode here: a
  // read-only source (e.g. 0o444) would otherwise make the temp file
  // unwritable to a follow-up open — and reopening it (the old 'r+' path)
  // fails with EACCES. The mode is applied AFTER fsync, via chmodSync.
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, payload, null, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // Apply the preserved mode after the data is durable. chmodSync works even
  // when tightening to a read-only mode (0o444) — unlike reopening the file.
  if (mode !== null) chmodSync(tmpPath, mode)
  renameSync(tmpPath, realPath)
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
