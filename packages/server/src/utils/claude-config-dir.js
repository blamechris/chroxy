/**
 * claudeConfigDir: the ONE place chroxy decides where claude keeps its data
 * (#8270): `projects/<slug>/<id>.jsonl` transcripts, `sessions/<pid>.json`,
 * `commands/`, `agents/`, `CLAUDE.md`, per-project memory.
 *
 * claude honours `CLAUDE_CONFIG_DIR` from ITS environment and writes under it
 * instead of `~/.claude`, so a chroxy that joins `homedir()` + `.claude`
 * looks for files that were never written there.
 *
 * Whose env: the DAEMON's (`process.env`) by default. A caller that holds the
 * exact env a child is spawned with passes it.
 *
 * One policy for readers and the claude child: the child env is passed through
 * {@link sanitizeClaudeConfigDirEnv}, which drops a value this module would not
 * accept. Both sides then use `~/.claude` for it, so chroxy never reads a tree
 * claude is not writing.
 *
 * Accepted spelling (exactly as written, no trimming):
 *   - a string, no NUL byte, an absolute path
 *   - not the filesystem root, and not a path that RESOLVES to the filesystem
 *     root once symlinks are followed (the canonical value is what counts)
 * Anything else (unset, empty, padded with whitespace, relative, `~/x`, root,
 * a symlink alias of the root) falls back to `~/.claude`.
 *
 * The result is the CANONICAL path (symlinks resolved through the deepest
 * existing ancestor), so it is safe to use directly as a containment root. If
 * the path cannot be resolved it is treated as unusable and the default is used.
 *
 * This is claude's data dir only. chroxy's own `~/.chroxy` / `CHROXY_CONFIG_DIR`
 * are unrelated and untouched.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('claude-config-dir')

/** claude's default data dir, `~/.claude`. */
export function defaultClaudeConfigDir() {
  return join(homedir(), '.claude')
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// realpath of the deepest EXISTING ancestor plus the not-yet-created tail, so a
// config dir claude has not created yet is still canonicalised.
function canonicalize(absPath) {
  let current = absPath
  const tail = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err
      // A component that IS a symlink whose target is missing (dangling) is not
      // "a directory that does not exist yet": following its text could land
      // anywhere. Treat the whole value as unusable instead of walking past it.
      if (isSymlink(current)) throw err
      const parent = dirname(current)
      if (parent === current) throw err
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * The canonical config dir for an override spelling, or null when the spelling
 * is not accepted (see the module comment).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function resolveClaudeConfigDirOverride(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0') || !isAbsolute(raw)) return null
  const normalised = resolve(raw)
  if (normalised === parse(normalised).root) return null
  let canonical
  try {
    canonical = canonicalize(normalised)
  } catch {
    return null
  }
  if (canonical === parse(canonical).root) return null
  return canonical
}

/**
 * @param {Record<string, unknown> | NodeJS.ProcessEnv | null | undefined} [env] - env claude runs with
 * @returns {string} absolute, canonical path to claude's config dir
 */
export function claudeConfigDir(env = process.env) {
  return resolveClaudeConfigDirOverride(env?.CLAUDE_CONFIG_DIR) ?? defaultClaudeConfigDir()
}

/** `<claude config dir>/projects`. */
export function claudeProjectsDir(env = process.env) {
  return join(claudeConfigDir(env), 'projects')
}

const warned = new Set()

/** Is `p` a filesystem root (`/`, `C:\`)? For use sites that install a resolved dir as a containment root. */
export function isFilesystemRoot(p) {
  return typeof p === 'string' && p !== '' && parse(p).root === p
}

/**
 * Startup check: warn once (constant text, no path) when `CLAUDE_CONFIG_DIR` is
 * set but not usable. Does not modify `env`.
 * @param {Record<string, unknown>} [env]
 * @returns {boolean} true when a warning was due
 */
export function warnIfClaudeConfigDirUnusable(env = process.env) {
  if (env?.CLAUDE_CONFIG_DIR === undefined) return false
  const before = Object.hasOwn(env, 'CLAUDE_CONFIG_DIR')
  const copy = sanitizeClaudeConfigDirEnv({ CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR })
  return before && !Object.hasOwn(copy, 'CLAUDE_CONFIG_DIR')
}

/**
 * Make a claude child env agree with {@link claudeConfigDir}: when the env
 * carries a `CLAUDE_CONFIG_DIR` the resolver would reject, remove it (one
 * warning per distinct value) so claude falls back to `~/.claude` as chroxy does.
 * Mutates and returns `env`.
 * @param {Record<string, unknown>} env
 */
export function sanitizeClaudeConfigDirEnv(env) {
  if (!env || !Object.hasOwn(env, 'CLAUDE_CONFIG_DIR') || env.CLAUDE_CONFIG_DIR === undefined) return env
  if (resolveClaudeConfigDirOverride(env.CLAUDE_CONFIG_DIR) !== null) return env
  const key = String(env.CLAUDE_CONFIG_DIR)
  if (!warned.has(key)) {
    warned.add(key)
    log.warn('Ignoring CLAUDE_CONFIG_DIR: it must be an absolute path that is not the filesystem root; using ~/.claude')
  }
  delete env.CLAUDE_CONFIG_DIR
  return env
}
