import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Module-level, in-process lock for settings.json read-modify-write operations.
// Shared across all importers of this module in a single Node.js process so CLI
// and PTY sessions in that process serialize writes (does not prevent concurrent
// writes from multiple chroxy server processes).
let _settingsLock = Promise.resolve()
let _settingsLockHeld = 0

export function withSettingsLock(fn) {
  if (_settingsLockHeld > 0) {
    console.log('[config] Settings write queued (lock contended)')
  }

  _settingsLockHeld++

  const wrapped = () => {
    if (_settingsLockHeld > 1) {
      console.log('[config] Settings write proceeding (lock acquired)')
    }
    return Promise.resolve(fn()).finally(() => {
      _settingsLockHeld--
    })
  }

  const next = _settingsLock.then(wrapped, wrapped)
  _settingsLock = next.catch(() => {})
  return next
}

/**
 * Register the Chroxy permission hook in ~/.claude/settings.json.
 * Idempotent — removes any existing Chroxy hook entry before adding.
 */
function registerPermissionHookSync() {
  const hookScript = resolve(__dirname, '..', 'hooks', 'permission-hook.sh')
  const settingsPath = resolve(homedir(), '.claude', 'settings.json')

  let settings = {}
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch (err) {
    if (err.code === 'ENOENT') {
      mkdirSync(resolve(homedir(), '.claude'), { recursive: true })
    } else {
      throw err
    }
  }

  if (!settings.hooks) settings.hooks = {}
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = []

  // Remove any existing Chroxy hook entry
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
    (entry) => !entry._chroxy
  )

  // Add our hook — script reads CHROXY_PORT and CHROXY_TOKEN from env vars
  settings.hooks.PreToolUse.push({
    _chroxy: true,
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: hookScript,
        timeout: 300,
      },
    ],
  })

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  chmodSync(settingsPath, 0o600)
  console.log('[permission-hook] Registered hook in ~/.claude/settings.json')
}

/**
 * Remove the Chroxy permission hook from ~/.claude/settings.json.
 */
function unregisterPermissionHookSync() {
  const settingsPath = resolve(homedir(), '.claude', 'settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))

  if (settings.hooks?.PreToolUse) {
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
      (entry) => !entry._chroxy
    )
    if (settings.hooks.PreToolUse.length === 0) {
      delete settings.hooks.PreToolUse
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    chmodSync(settingsPath, 0o600)
    console.log('[permission-hook] Unregistered hook from ~/.claude/settings.json')
  }
}

/**
 * Create a permission hook manager that handles registration, retry, and cleanup.
 *
 * @param {EventEmitter} emitter - Used to emit 'error' events on failure
 * @returns {{ register(): Promise, unregister(): Promise, destroy(): void }}
 */
export function createPermissionHookManager(emitter) {
  let retryCount = 0
  let retryTimer = null
  let registered = false
  let destroying = false

  function scheduleRetry() {
    if (destroying || registered) return
    if (retryTimer) return

    retryCount++
    if (retryCount > 3) {
      const errMsg = 'Hook registration failed after 3 attempts. Please check ~/.claude/settings.json and restart the server. Permissions will not work until this is fixed.'
      console.error(`[permission-hook] ${errMsg}`)
      emitter.emit('error', { message: errMsg })
      return
    }

    const delays = [2000, 5000, 10000]
    const delay = delays[retryCount - 1]
    console.log(`[permission-hook] Registration failed, retrying in ${delay / 1000}s (attempt ${retryCount}/3)`)

    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!destroying && !registered) {
        register()
      }
    }, delay)
  }

  function register() {
    return withSettingsLock(() => {
      try {
        registerPermissionHookSync()
        if (retryTimer) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        registered = true
        retryCount = 0
      } catch (err) {
        const errMsg = `Failed to register permission hook: ${err.message}. Will retry hook registration.`
        console.error(`[permission-hook] ${errMsg}`)
        emitter.emit('error', { message: errMsg })
        scheduleRetry()
      }
    })
  }

  function unregister() {
    return withSettingsLock(() => {
      try {
        unregisterPermissionHookSync()
      } catch (err) {
        console.error(`[permission-hook] Failed to unregister: ${err.message}`)
      }
    })
  }

  function destroy() {
    destroying = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  return { register, unregister, destroy }
}
