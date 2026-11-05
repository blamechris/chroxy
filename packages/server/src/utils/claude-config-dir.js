/**
 * claudeConfigDir — the ONE place chroxy decides where claude keeps its data
 * (#8270): `projects/<slug>/<id>.jsonl` transcripts, `sessions/<pid>.json`,
 * `commands/`, `agents/`, `CLAUDE.md`, per-project memory.
 *
 * claude honours `CLAUDE_CONFIG_DIR` from ITS environment and writes under it
 * instead of `~/.claude`, so a chroxy that joins `homedir()` + `.claude`
 * looks for files that were never written there.
 *
 * Whose env: the DAEMON's (`process.env`) by default. Every claude child is
 * spawned from the daemon env through `buildSpawnEnv`, which forwards
 * `CLAUDE_CONFIG_DIR` untouched (it is not in the secret denylist), so the two
 * agree. A caller that holds the exact env a child is spawned with passes it.
 *
 * Safe handling of odd values: this path feeds transcript/memory read
 * surfaces whose containment is rooted at the result, so a surprising value
 * must never widen what they can reach.
 *   - unset, empty, whitespace-only      -> `~/.claude` (claude's default)
 *   - not a string, or contains NUL      -> `~/.claude`
 *   - relative (`.`, `foo`, `~/x`)       -> `~/.claude`. claude would resolve it
 *     against ITS cwd, which the daemon cannot know; guessing could point the
 *     containment root at an arbitrary directory.
 *   - the filesystem root (`/`, `C:\`)   -> `~/.claude`. Rooting containment at
 *     `/` makes every file "inside" it.
 *   - otherwise                          -> `path.resolve()`-normalised
 *     (trailing slashes and `..` collapsed).
 *
 * This is claude's data dir only. chroxy's own `~/.chroxy` / `CHROXY_CONFIG_DIR`
 * are unrelated and untouched.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'

/** claude's default data dir, `~/.claude`. */
export function defaultClaudeConfigDir() {
  return join(homedir(), '.claude')
}

/**
 * @param {Record<string, string|undefined>} [env] - env claude runs with
 * @returns {string} absolute path to claude's config dir
 */
export function claudeConfigDir(env = process.env) {
  const raw = env?.CLAUDE_CONFIG_DIR
  if (typeof raw !== 'string') return defaultClaudeConfigDir()
  const value = raw.trim()
  if (value === '' || value.includes('\0') || !isAbsolute(value)) return defaultClaudeConfigDir()
  const normalised = resolve(value)
  if (normalised === parse(normalised).root) return defaultClaudeConfigDir()
  return normalised
}

/** `<claude config dir>/projects`. */
export function claudeProjectsDir(env = process.env) {
  return join(claudeConfigDir(env), 'projects')
}
