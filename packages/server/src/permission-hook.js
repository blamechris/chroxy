import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createLogger } from './logger.js'
import { shellQuotePath } from './utils/verify-binary.js'
import { claudeConfigDir } from './utils/claude-config-dir.js'
import { updateClaudeConfig } from './byok-mcp-config.js'
import { HOOK_HOST_TIMEOUT_S } from './permission-deadlines.js'

const log = createLogger('permission-hook')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// The user-level settings file claude loads: `<claude config dir>/settings.json`.
// Resolved per call (not at import) so a CLAUDE_CONFIG_DIR override in the
// daemon env is honoured the same way the claude child sees it (#8974); an
// unusable override falls back to `~/.claude`, exactly as claudeConfigDir does.
function defaultSettingsPath() {
  return resolve(claudeConfigDir(), 'settings.json')
}

/** The user-level settings.json claude loads for the daemon's env (doctor seam). */
export function userSettingsPath() {
  return defaultSettingsPath()
}

// settings.json is written ONLY through `updateClaudeConfig` (#8983): the shared
// symlink-aware, mode-preserving atomic writer that re-reads the file just before
// the rename and re-merges if claude (or another daemon) changed it meanwhile.
// It writes THROUGH a symlinked path (a dotfiles link is kept, not replaced),
// uses a per-call sidecar name so two daemon processes never share a temp file,
// and refuses a link it will not follow (dangling, non-regular, foreign uid).
// A read refusal comes back as `{ ok: false }`; this maps it to the Error the
// callers (and `createPermissionHookManager`'s `invalid JSON` check) expect.
/**
 * Advisory (#8983): the settings.json mode is PRESERVED (never re-permissioned), so
 * when it is group/world-readable say so — the document can hold `env` credentials.
 * Returns null when there is nothing to warn about. Never echoes content.
 */
export function describeSettingsModeWarning({ filePath, mode, _isWindows = process.platform === 'win32' } = {}) {
  if (_isWindows || typeof mode !== 'number' || (mode & 0o044) === 0) return null
  return `${filePath} is mode ${mode.toString(8)} (readable beyond its owner) and may hold credentials in its env block. Chroxy preserved the existing permissions rather than changing them — tighten it yourself with: chmod 600 ${filePath}`
}

function updateSettingsFile(settingsPath, mutate, { onInvalidJson } = {}) {
  const updated = updateClaudeConfig(settingsPath, mutate, { createDir: true })
  if (updated.ok) return updated
  if (/not valid JSON/.test(updated.error)) {
    if (onInvalidJson) return onInvalidJson()
    throw new Error(`${settingsPath} contains invalid JSON and could not be parsed. Please fix or delete the file. Permissions will not work until this is resolved.`)
  }
  throw new Error(updated.error)
}
const DEFAULT_HOOK_SCRIPT = resolve(__dirname, '..', 'hooks', 'permission-hook.sh')

// Module-level, in-process lock for settings.json read-modify-write operations.
// Shared across all importers of this module in a single Node.js process so CLI
// and PTY sessions in that process serialize writes (does not prevent concurrent
// writes from multiple chroxy server processes).
let _settingsLock = Promise.resolve()
let _settingsLockHeld = 0

export function withSettingsLock(fn) {
  if (_settingsLockHeld > 0) {
    log.info('Settings write queued (lock contended)')
  }

  _settingsLockHeld++

  const wrapped = () => {
    if (_settingsLockHeld > 1) {
      log.info('Settings write proceeding (lock acquired)')
    }
    return Promise.resolve(fn()).finally(() => {
      _settingsLockHeld--
    })
  }

  const next = _settingsLock.then(wrapped, wrapped)
  _settingsLock = next.catch((err) => {
    log.warn(`Settings lock release failed: ${err.message} (non-critical, lock will reset)`)
  })
  return next
}

/**
 * Identifies any settings.json hook entry as one of ours so we can prune
 * it on register/unregister. Catches both the canonical `_chroxy: true`
 * marker AND orphans where the marker was lost (e.g. a user manually
 * edited the file, or an older chroxy version wrote without the flag).
 * Without the path-match arm, orphans accumulated across restarts —
 * Claude then fired the same script multiple times per tool call,
 * creating duplicate /permission requests and timeouts (#3714).
 *
 * @param {object} entry - One element of settings.hooks.PreToolUse
 * @returns {boolean}
 */
function _isChroxyHookEntry(entry) {
  if (entry?._chroxy === true) return true
  const inner = Array.isArray(entry?.hooks) ? entry.hooks : []
  // Path-match arm: tighten to chroxy-installed paths only — the basename
  // alone could match an unrelated user script that happens to share the
  // name. The regex accepts both `/` and `\\` separators so it works on
  // any platform where Claude Code might run. (Earlier draft had a
  // forward-slash-only `includes()` pre-filter that would have skipped
  // the regex on Windows paths — see #3715 review.)
  return inner.some(h =>
    typeof h?.command === 'string' &&
    // `'?$`: a command written with the script path shell-quoted ends in the
    // closing quote; entries written before quoting existed end in `.sh`.
    /(?:Chroxy\.app|chroxy[/\\]packages[/\\]server|@chroxy[/\\]server).*hooks[/\\]permission-hook\.sh'?$/.test(h.command)
  )
}

/**
 * The command string of the user-level registration.
 *
 * The entry lives in the user's own Claude settings, so every Claude Code
 * session on the machine loads it, and an entry can outlive the session that
 * wrote it (#3714). It also sets `onFailure: 'block'`. So the command decides
 * FIRST, without touching the script, whether this session is one it gates:
 *
 *   - no CHROXY_PORT: not a Chroxy session. Exit 0 with no output, which Claude
 *     Code reads as "no decision". A leftover entry whose script has since
 *     moved or been removed therefore does nothing, instead of failing and
 *     blocking every tool call in an ordinary Claude Code session.
 *   - CHROXY_TUI_CHILD=1: a claude-tui child, where only the session's own
 *     `--settings` copy may decide (#8263). Same: exit 0, nothing.
 *   - otherwise: a claude-cli session. `exec` the script. If that cannot run,
 *     the hook has failed, and the failure blocks the tool call.
 *
 * permission-hook.sh makes the same two checks itself; they are repeated here
 * because here they have to hold when the script cannot be run at all.
 *
 * @param {string} hookScript
 * @returns {string}
 */
export function userLevelHookCommand(hookScript) {
  const script = shellQuotePath(hookScript)
  return `[ -n "$CHROXY_PORT" ] && [ "$CHROXY_TUI_CHILD" != 1 ] || exit 0; exec ${script}`
}

/**
 * Register the Chroxy permission hook in settings.json.
 * Idempotent — removes any existing Chroxy hook entry before adding.
 * @param {string} [settingsPath] - Path to settings.json (defaults to <claude config dir>/settings.json)
 * @param {string} [hookScript] - Hook script path (defaults to the packaged script; a test seam
 *   so the written command can be checked against an install path that needs shell quoting)
 */
function registerPermissionHookSync(settingsPath, hookScript = DEFAULT_HOOK_SCRIPT) {
  settingsPath = settingsPath || defaultSettingsPath()

  let existingMode = null
  const updated = updateSettingsFile(settingsPath, (settings, info) => {
    existingMode = info.existed ? info.mode : null
    if (!settings.hooks) settings.hooks = {}
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = []

    // Remove any existing Chroxy hook entry — catches the canonical
    // `_chroxy:true` marker AND orphan entries that lost the flag (#3714).
    const before = settings.hooks.PreToolUse.length
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
      (entry) => !_isChroxyHookEntry(entry)
    )
    const removed = before - settings.hooks.PreToolUse.length
    if (removed > 1) {
      // Logging the orphan count makes future regressions visible in the
      // boot log instead of silently piling up.
      log.warn(`Removed ${removed} chroxy permission-hook entries from ${settingsPath} (>1 indicates leaked orphans from a prior install — see #3714)`)
    }

    // Add our hook — script reads CHROXY_PORT and CHROXY_TOKEN from env vars
    settings.hooks.PreToolUse.push({
      _chroxy: true,
      matcher: '',
      hooks: [
        {
          type: 'command',
          // Claude runs this string through a shell, so the script path is
          // shell-quoted when it needs it (an install path with a space would
          // otherwise split into words). See userLevelHookCommand for the rest.
          command: userLevelHookCommand(hookScript),
          // Longer than the script's budgeted envelope, so that within it the
          // daemon's answer (a decision, or its no-answer deny) is what ends the
          // wait and not the host cancelling the hook. A budget, not a
          // guarantee: see permission-deadlines.js.
          timeout: HOOK_HOST_TIMEOUT_S,
          // A hook that Claude Code cancels at that timeout, or that cannot run
          // in a claude-cli session, blocks the tool call rather than being
          // skipped. Claude Code builds that predate the option ignore the key.
          onFailure: 'block',
        },
      ],
    })

    return {}
  })
  const modeWarning = describeSettingsModeWarning({ filePath: updated.path, mode: existingMode })
  if (modeWarning) log.warn(modeWarning)
  log.info(`Registered hook in ${settingsPath}`)
  return updated.path
}

/**
 * Remove the Chroxy permission hook from settings.json.
 * @param {string} [settingsPath] - Path to settings.json (defaults to <claude config dir>/settings.json)
 */
function unregisterPermissionHookSync(settingsPath) {
  settingsPath = settingsPath || defaultSettingsPath()
  const updated = updateSettingsFile(settingsPath, (settings, info) => {
    // Nothing to remove from a file that does not exist or has no hooks — and a
    // no-op must not rewrite the user's settings (nor race claude for nothing).
    if (!info.existed || !settings.hooks?.PreToolUse) return { write: false }
    // Same predicate as register — also strips orphans without the flag (#3714).
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
      (entry) => !_isChroxyHookEntry(entry)
    )
    if (settings.hooks.PreToolUse.length === 0) {
      delete settings.hooks.PreToolUse
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks
    }
    return {}
  }, {
    onInvalidJson: () => {
      log.warn(`Cannot unregister: ${settingsPath} contains invalid JSON. Skipping cleanup.`)
      return { ok: true, wrote: false }
    },
  })
  if (updated.wrote) log.info(`Unregistered hook from ${settingsPath}`)
}

/**
 * Report whether the user-level settings file holds a chroxy permission-hook
 * entry (#8263). Read-only; used by `chroxy doctor`. Never throws.
 *
 * @param {{settingsPath?: string}} [options]
 * @returns {{found: number, settingsPath: string, error?: string}}
 */
export function countUserLevelChroxyHooks({ settingsPath } = {}) {
  const target = settingsPath || defaultSettingsPath()
  try {
    const settings = JSON.parse(readFileSync(target, 'utf-8'))
    const entries = settings?.hooks?.PreToolUse
    const found = Array.isArray(entries) ? entries.filter(_isChroxyHookEntry).length : 0
    return { found, settingsPath: target }
  } catch (err) {
    if (err.code === 'ENOENT') return { found: 0, settingsPath: target }
    return { found: 0, settingsPath: target, error: err.message }
  }
}

/**
 * Create a permission hook manager that handles registration, retry, and cleanup.
 *
 * @param {EventEmitter} emitter - Used to emit 'error' events on failure
 * @param {{ settingsPath?: string, hookScript?: string }} [options] - Optional settings path for test
 *   isolation, and a hook script path override (test seam, see registerPermissionHookSync)
 * @returns {{ register(): Promise, unregister(): Promise, destroy(): Promise }}
 */
export function createPermissionHookManager(emitter, { settingsPath, hookScript } = {}) {
  let retryCount = 0
  let retryTimer = null
  let registered = false
  let destroying = false
  // Tracks the most recent in-flight register() promise so destroy() can
  // chain unregister() after it, preventing a register-after-unregister race.
  let pendingRegister = null
  // Pinned on first use: register, retry messages, unregister and cleanup all
  // act on the SAME file, so an env change or a retargeted override link after
  // registration cannot send cleanup to a different profile.
  let pinnedPath = null
  const targetPath = () => (pinnedPath ??= settingsPath || defaultSettingsPath())
  // The file the registration actually landed in (a symlinked settings.json
  // resolved to its target). Cleanup acts on THIS, so retargeting the link
  // afterwards strands nothing and never touches the new target.
  let registeredTarget = null

  function scheduleRetry() {
    if (destroying || registered) return
    if (retryTimer) return

    retryCount++
    if (retryCount > 3) {
      const effectivePath = targetPath()
      const errMsg = `Hook registration failed after 3 attempts. Please check ${effectivePath} and restart the server. Permissions will not work until this is fixed.`
      log.error(errMsg)
      emitter.emit('error', { message: errMsg })
      return
    }

    const delays = [2000, 5000, 10000]
    const delay = delays[retryCount - 1]
    log.info(`Registration failed, retrying in ${delay / 1000}s (attempt ${retryCount}/3)`)

    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!destroying && !registered) {
        register()
      }
    }, delay)
  }

  function register() {
    const p = withSettingsLock(() => {
      // Guard: if destroy() was called while we were waiting for the lock,
      // skip the write so we don't leave a dead hook behind.
      if (destroying) {
        log.info('Hook registration skipped — session already destroyed')
        return
      }
      try {
        registeredTarget = registerPermissionHookSync(targetPath(), hookScript)
        if (retryTimer) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        registered = true
        retryCount = 0
      } catch (err) {
        // Corrupt JSON is non-retryable — retrying won't fix the file
        if (err.message.includes('invalid JSON')) {
          log.error(err.message)
          emitter.emit('error', { message: err.message })
          return
        }
        const errMsg = `Failed to register permission hook: ${err.message}. Will retry hook registration.`
        log.error(errMsg)
        emitter.emit('error', { message: errMsg })
        scheduleRetry()
      }
    })
    pendingRegister = p.catch(() => {})
    return p
  }

  function unregister() {
    return withSettingsLock(() => {
      try {
        unregisterPermissionHookSync(registeredTarget ?? targetPath())
        registeredTarget = null
      } catch (err) {
        log.error(`Failed to unregister: ${err.message}`)
      }
    })
  }

  function destroy() {
    destroying = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    // Chain unregister after any in-flight register so we never leave a
    // dead hook when destroy() races with a pending settings-lock acquire.
    const pending = pendingRegister || Promise.resolve()
    return pending.then(() => unregister())
  }

  return { register, unregister, destroy }
}
