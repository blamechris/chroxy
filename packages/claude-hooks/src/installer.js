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

import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
  // #5541 turn edges — matcher-less, like the other non-Notification events.
  'UserPromptSubmit',
  'Stop',
]

/** Ingest type passed to `emit` per hook event. */
export const TYPE_FOR_HOOK_EVENT = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Notification: 'notification',
  PostToolUse: 'post_tool_use',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
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

/**
 * Parse settings.json text. Empty/whitespace is empty settings; anything that
 * is not a JSON object aborts (NEVER overwrite a file we cannot parse).
 */
function parseSettings(raw, settingsPath) {
  if (raw.trim().length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${settingsPath} is not valid JSON — fix or remove it, then re-run`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} does not contain a JSON object`)
  }
  return parsed
}

/** Read the file's current text, or null when it does not exist. */
function readRawOrNull(path) {
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new Error(`Cannot read ${path}: ${err.message}`)
  }
}

const sha256 = (raw) => (raw === null ? null : createHash('sha256').update(raw).digest('hex'))

/**
 * Where a write for `settingsPath` lands, fully canonicalised: the PARENT
 * directory is realpath'd (a symlinked directory is followed), and a symlinked
 * settings.json (dotfile managers: stow, chezmoi, yadm) is written THROUGH to
 * its target so the link survives — but only when the target resolves, is a
 * regular file, and is owned by the uid we run as. Mirrors the server's
 * resolveClaudeConfigWritePath. The temp file is always created in the
 * directory of the returned path, so create, rename and cleanup agree.
 */
function resolveSettingsWritePath(settingsPath, { getuid }) {
  let candidate = settingsPath
  try {
    candidate = join(realpathSync(dirname(settingsPath)), basename(settingsPath))
  } catch {
    // Parent does not exist yet (first write): the path as given.
  }
  let link
  try {
    link = lstatSync(candidate)
  } catch {
    return candidate // missing: first write
  }
  if (!link.isSymbolicLink()) return candidate
  let resolved
  try {
    resolved = realpathSync(candidate)
  } catch (err) {
    throw new Error(`${settingsPath} is a symlink whose target cannot be resolved (${err?.code || err?.message}); refusing to replace the link with a regular file`)
  }
  const target = lstatSync(resolved)
  if (!target.isFile()) {
    throw new Error(`${settingsPath} is a symlink to ${resolved}, which is not a regular file; refusing to write through it`)
  }
  const uid = typeof getuid === 'function' ? getuid() : null
  if (uid !== null && target.uid !== uid) {
    throw new Error(`${settingsPath} is a symlink to ${resolved}, which is owned by uid ${target.uid} rather than uid ${uid}; refusing to write through it`)
  }
  return resolved
}

const WIN_SYSTEM32 = `${process.env.SystemRoot || process.env.windir || 'C:\\Windows'}\\System32`
const SID_SYSTEM = 'S-1-5-18'

/**
 * Restrict `filePath` to the current user + SYSTEM on Windows (whoami SID
 * lookup, then icacls strip-inheritance + grant). Same arguments as the
 * server's owner-only ACL helper; duplicated because this package has no
 * dependency on the server. FAIL-CLOSED: throws on any failure.
 */
function stampOwnerOnlyAcl(filePath, exec) {
  let sid
  try {
    const out = exec(`${WIN_SYSTEM32}\\whoami.exe`, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf-8', windowsHide: true, timeout: 5000,
    })
    const m = String(out ?? '').match(/S-1-[0-9-]+/)
    if (!m) throw new Error('no SID in whoami output')
    sid = m[0]
  } catch (err) {
    throw new Error(`could not resolve the current-user SID to restrict ${filePath}: ${err?.message || err}`)
  }
  try {
    exec(`${WIN_SYSTEM32}\\icacls.exe`, [
      filePath, '/inheritance:r', '/grant:r', `*${sid}:F`, '/grant:r', `*${SID_SYSTEM}:F`,
    ], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
  } catch (err) {
    throw new Error(`icacls could not restrict ${filePath} to the owner: ${err?.message || err}`)
  }
}

class SettingsConflictError extends Error {}

const MAX_UPDATE_ATTEMPTS = 5

const modeOf = (path) => {
  try { return statSync(path).mode & 0o777 } catch { return null }
}

/**
 * Throw SettingsConflictError unless the destination is still what the merge
 * was computed from: same resolved path, same bytes, same permission bits (a
 * concurrent `chmod 600` with identical bytes would otherwise be undone by the
 * temp's older mode; the re-merge picks up the current mode).
 */
function verifyUnchanged(settingsPath, destPath, snapshot, seams) {
  if (resolveSettingsWritePath(settingsPath, seams) !== destPath) {
    throw new SettingsConflictError('its location or symlink target changed')
  }
  let raw
  try {
    raw = readRawOrNull(destPath)
  } catch (err) {
    throw new SettingsConflictError(`re-read failed: ${err.message}`)
  }
  if (sha256(raw) !== snapshot.hash) throw new SettingsConflictError('its content changed')
  if (snapshot.mode !== null && modeOf(destPath) !== snapshot.mode) {
    throw new SettingsConflictError('its permissions changed')
  }
}

/**
 * Write `payload` to a same-directory temp file and rename it over the target.
 *
 *   - POSIX: the temp is CREATED with the target mode (preserved mode, or 0600
 *     for a new file), so it is never wider than the target at any point. The
 *     exact mode is restated after the write (umask can only strip bits; a
 *     read-only 0o444 target still gets its mode applied after the write).
 *   - Windows: the temp is created empty, the owner-only ACL is stamped, THEN
 *     bytes are written. A failed stamp writes nothing, renames nothing and
 *     removes the temp.
 *   - Optimistic conflict detection (NOT an atomic compare-and-swap): the
 *     destination is re-resolved and re-read immediately before the rename and
 *     the temp is discarded if it differs from the snapshot. There is no lock
 *     and POSIX has no "rename if unchanged", so a writer landing in the
 *     residual window between that check and the rename can still be lost, and
 *     a link swapped in that window is replaced. This narrows the race; it
 *     does not eliminate it.
 *   - Cleanup only ignores ENOENT; any other failure to remove the temp is
 *     reported with its path.
 */
function writeSettingsAtomic(settingsPath, payload, snapshot, seams) {
  const { onWindows, exec, hooks, open, unlink } = seams
  const destPath = resolveSettingsWritePath(settingsPath, seams)
  if (destPath !== snapshot.path) throw new SettingsConflictError('its location or symlink target changed')
  const targetMode = snapshot.mode === null ? 0o600 : snapshot.mode
  const tmpPath = `${destPath}.chroxy-hooks-${process.pid}-${randomUUID()}.tmp`
  try {
    let fd
    if (onWindows) {
      closeSync(open(tmpPath, 'wx'))
      stampOwnerOnlyAcl(tmpPath, exec)
      fd = open(tmpPath, 'w')
    } else {
      fd = open(tmpPath, 'wx', targetMode)
    }
    try {
      writeSync(fd, payload, null, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    hooks.afterWrite?.({ tmpPath })
    if (!onWindows) chmodSync(tmpPath, targetMode)
    hooks.beforeRename?.({ tmpPath })
    verifyUnchanged(settingsPath, destPath, snapshot, seams)
    renameSync(tmpPath, destPath)
  } catch (err) {
    try {
      unlink(tmpPath)
    } catch (cleanupErr) {
      if (cleanupErr?.code !== 'ENOENT') {
        // Not a conflict any more: surface it so the caller stops retrying.
        throw new Error(`could not remove temp file ${tmpPath}: ${cleanupErr?.code || cleanupErr?.message} (while handling: ${err?.message || err})`)
      }
    }
    throw err
  }
}

/**
 * Read-merge-write with optimistic lost-update detection (see
 * writeSettingsAtomic for the residual window): `mutate(settings)` returns the
 * next settings object, or null for "nothing to write". On a detected change
 * the merge is recomputed from the fresh file (bounded retries). Nothing on
 * disk is touched (not even the parent directory) until a write is required.
 */
function updateSettings(settingsPath, mutate, { _seams = {} } = {}) {
  const seams = {
    onWindows: _seams.platform ? _seams.platform === 'win32' : process.platform === 'win32',
    exec: _seams.exec ?? execFileSync,
    getuid: 'getuid' in _seams ? _seams.getuid : process.getuid?.bind(process),
    hooks: _seams.hooks ?? {},
    open: _seams.open ?? openSync,
    unlink: _seams.unlink ?? unlinkSync,
  }
  for (let attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt++) {
    let path = resolveSettingsWritePath(settingsPath, seams)
    const raw = readRawOrNull(path)
    const mode = raw === null ? null : modeOf(path)
    const next = mutate(raw === null ? {} : parseSettings(raw, settingsPath))
    if (!next) return
    const payload = JSON.stringify(next, null, 2) + '\n'
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true })
      path = resolveSettingsWritePath(settingsPath, seams)
    }
    try {
      writeSettingsAtomic(settingsPath, payload, { path, mode, hash: sha256(raw) }, seams)
      return
    } catch (err) {
      if (!(err instanceof SettingsConflictError)) throw err
    }
  }
  throw new Error(`${settingsPath} kept changing while it was being updated; gave up after ${MAX_UPDATE_ATTEMPTS} attempts so another writer's changes are not overwritten — re-run`)
}

/** Install (idempotent). Returns the settings path written. */
export function installHooks({ settingsPath = defaultSettingsPath(), nodePath, binPath, _seams } = {}) {
  updateSettings(settingsPath, (settings) => addOwnHooks(settings, { nodePath, binPath }), { _seams })
  return settingsPath
}

/** Uninstall: removes ONLY our own entries. Missing file is a no-op. */
export function uninstallHooks({ settingsPath = defaultSettingsPath(), _seams } = {}) {
  updateSettings(settingsPath, (settings) => (
    Object.keys(settings).length === 0 ? null : removeOwnHooks(settings)
  ), { _seams })
  return settingsPath
}
