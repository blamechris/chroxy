import { homedir } from 'os'
import { join } from 'path'

/**
 * The daemon's config/state root — the single resolver for `~/.chroxy`.
 *
 * **This is a function, and that is the whole point (#7052).** The obvious
 * shape is a module-scope constant:
 *
 *     const CONFIG_DIR = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
 *
 * and it is silently wrong. A `const` evaluates once, at *import*, so it
 * captures whatever the environment happened to be when the module graph was
 * first walked. Pointing such a constant at an env-reading expression changes
 * nothing: the variable still is not consulted at the moment that matters.
 * That is not a hypothetical — sixteen modules independently grew their own
 * inline `process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')` copy
 * *because* the shared constant could not be made to work, while sixteen
 * others kept a hardcoded home-rooted `const` and quietly ignored the
 * override. `CHROXY_CONFIG_DIR` therefore relocated only half the daemon's
 * state, which is exactly the split-brain #7052 describes.
 *
 * The subtle case is a default parameter:
 *
 *     export function readRepos(configPath = DEFAULT_CONFIG_PATH) {}   // frozen
 *     export function readRepos(configPath = defaultConfigPath()) {}   // live
 *
 * The default *expression* is evaluated per call either way — but in the first
 * form all it does is re-read a binding that was assigned once. Only the second
 * re-reads the environment.
 *
 * So: no caching, no memoization, no module-scope capture. A test's
 * `beforeEach` that sets `CHROXY_CONFIG_DIR` to a temp dir must be respected by
 * calls made after it, which is only true if the read happens per call.
 *
 * @returns {string} Absolute path to the config/state root.
 */
export function configDir() {
  return process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
}

/**
 * A path inside {@link configDir}, resolved at call time.
 *
 *     configPath('config.json')            // <root>/config.json
 *     configPath('logs')                   // <root>/logs
 *     configPath('snapshots', 'a.json')    // <root>/snapshots/a.json
 *
 * An empty `CHROXY_CONFIG_DIR` falls back to `~/.chroxy`, matching the `||`
 * semantics every inline copy this replaces already had — the migration is a
 * true no-op for the sites that were already correct.
 *
 * @param {...string} segments Path segments appended to the root.
 * @returns {string} Absolute path.
 */
export function configPath(...segments) {
  return join(configDir(), ...segments)
}
