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
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('claude-config-dir')

/** The env key `os.homedir()` reads: `USERPROFILE` on Windows, `HOME` elsewhere. */
function homeEnvKey(platform) {
  return platform === 'win32' ? 'USERPROFILE' : 'HOME'
}

/**
 * The ONE acceptance policy for a home value taken from an env: the override's
 * (a string, no NUL, absolute, not the filesystem root even through symlinks).
 * Returns the value as written, or null.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function acceptClaudeHome(raw) {
  return resolveClaudeConfigDirOverride(raw) === null ? null : raw
}

/**
 * The home directory claude resolves for the process that runs with `env`: the
 * env's `HOME` (`USERPROFILE` on Windows, never `HOME` there), the same value
 * `os.homedir()` returns inside that child. When the env carries no ACCEPTED
 * home, the daemon's own `os.homedir()` is used; the child-env sanitiser removes
 * the same unusable value so the child falls back to the account's passwd home
 * (#8974).
 * @param {Record<string, unknown> | NodeJS.ProcessEnv | null | undefined} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function claudeHomeDir(env = process.env, platform = process.platform) {
  return acceptClaudeHome(env?.[homeEnvKey(platform)]) ?? homedir()
}

/** claude's default data dir, `<home>/.claude`. */
export function defaultClaudeConfigDir(env = process.env) {
  return join(claudeHomeDir(env), '.claude')
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
      const real = realpathSync.native(current)
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
  return resolveClaudeConfigDirOverride(env?.CLAUDE_CONFIG_DIR) ?? defaultClaudeConfigDir(env)
}

/** `<claude config dir>/projects`. */
export function claudeProjectsDir(env = process.env) {
  return join(claudeConfigDir(env), 'projects')
}

/**
 * claude's global config file (OAuth account metadata, user and per-project MCP
 * servers, workspace trust). claude picks ONE active file:
 *   1. `<config dir>/.config.json` when it is a regular file that is non-empty,
 *      or empty and writable while the modern file does not exist (legacy name);
 *   2. otherwise `join(CLAUDE_CONFIG_DIR || home, '.claude.json')` — directly in
 *      the override dir, but in the HOME directory (not `~/.claude/`) by default.
 * This returns that same file, so a reader and a writer never use a different one
 * than claude does (#8974). The override goes through the same acceptance policy
 * as {@link claudeConfigDir}; home comes from the env (see {@link claudeHomeDir}).
 * @param {Record<string, unknown> | NodeJS.ProcessEnv | null | undefined} [env] - env claude runs with
 * @returns {string} absolute path
 */
export function claudeGlobalConfigPath(env = process.env) {
  const override = resolveClaudeConfigDirOverride(env?.CLAUDE_CONFIG_DIR)
  const modern = join(override ?? claudeHomeDir(env), '.claude.json')
  const legacy = join(claudeConfigDir(env), '.config.json')
  try {
    // Exactly claude's rule: a regular legacy file that is non-empty, or that is
    // empty but writable while no modern file exists. A directory never qualifies.
    const st = statSync(legacy)
    if (st.isFile() && (st.size > 0 || ((st.mode & 0o222) !== 0 && !existsSync(modern)))) return legacy
  } catch {
    // absent / unreadable: not the active file
  }
  return modern
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
 * An unusable home value (HOME, or USERPROFILE on Windows) is removed the same way.
 * Mutates and returns `env`.
 * @param {Record<string, unknown>} env
 */
export function sanitizeClaudeConfigDirEnv(env, platform = process.platform) {
  if (!env) return env
  // The home value the child's os.homedir() reads: an unusable one is removed so
  // the child falls back to the account's passwd home, the same account the
  // daemon's claudeHomeDir() fallback names (#8974).
  const homeKey = homeEnvKey(platform)
  if (Object.hasOwn(env, homeKey) && env[homeKey] !== undefined && acceptClaudeHome(env[homeKey]) === null) {
    if (!warned.has(`home:${String(env[homeKey])}`)) {
      warned.add(`home:${String(env[homeKey])}`)
      log.warn('Ignoring an unusable home directory in the claude child env; the account home is used')
    }
    delete env[homeKey]
  }
  if (!Object.hasOwn(env, 'CLAUDE_CONFIG_DIR') || env.CLAUDE_CONFIG_DIR === undefined) return env
  if (resolveClaudeConfigDirOverride(env.CLAUDE_CONFIG_DIR) !== null) return env
  const key = String(env.CLAUDE_CONFIG_DIR)
  if (!warned.has(key)) {
    warned.add(key)
    log.warn('Ignoring CLAUDE_CONFIG_DIR: it must be an absolute path that is not the filesystem root; using ~/.claude')
  }
  delete env.CLAUDE_CONFIG_DIR
  return env
}
