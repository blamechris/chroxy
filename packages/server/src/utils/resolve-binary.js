import { execFileSync } from 'child_process'
import { existsSync } from 'fs'

function pathCandidates(path) {
  if (process.platform !== 'win32') return [path]
  if (/\.[^\\/]+$/.test(path)) return [path]

  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)

  return [path, ...extensions.map((ext) => `${path}${ext.toLowerCase()}`), ...extensions.map((ext) => `${path}${ext.toUpperCase()}`)]
}

/**
 * Resolve the full path to a named binary.
 *
 * First tries the platform path lookup so that any binary on the caller's PATH
 * is found automatically. If that fails (e.g. the process was started with a minimal
 * PATH such as just the Node bin directory), each entry in `candidates` is
 * tested with `existsSync`. On Windows, extensionless candidates are also tested
 * with PATHEXT suffixes. If none exist, `name` is returned as-is so the
 * caller gets a descriptive ENOENT rather than a silent failure.
 *
 * @param {string}   name       - Binary name (e.g. 'git', 'gemini', 'codex')
 * @param {string[]} candidates - Ordered list of absolute fallback paths to try
 * @returns {string} Resolved absolute path, or `name` if not found anywhere
 */
export function resolveBinary(name, candidates) {
  // Try PATH first
  try {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
    const output = execFileSync(lookup, [name], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    const [first] = output.split(/\r?\n/).filter(Boolean)
    if (first) return first
  } catch { /* binary not on PATH */ }

  // Fall back to well-known locations
  for (const c of candidates) {
    for (const candidate of pathCandidates(c)) {
      if (existsSync(candidate)) return candidate
    }
  }

  // Last resort — return bare name and let the caller handle ENOENT
  return name
}
