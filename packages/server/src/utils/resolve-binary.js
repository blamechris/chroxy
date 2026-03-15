import { execFileSync } from 'child_process'
import { existsSync } from 'fs'

/**
 * Resolve the full path to a named binary.
 *
 * First tries `which <name>` so that any binary on the caller's PATH is found
 * automatically.  If that fails (e.g. the process was started with a minimal
 * PATH such as just the Node bin directory), each entry in `candidates` is
 * tested with `existsSync`.  If none exist, `name` is returned as-is so the
 * caller gets a descriptive ENOENT rather than a silent failure.
 *
 * @param {string}   name       - Binary name (e.g. 'git', 'gemini', 'codex')
 * @param {string[]} candidates - Ordered list of absolute fallback paths to try
 * @returns {string} Resolved absolute path, or `name` if not found anywhere
 */
export function resolveBinary(name, candidates) {
  // Try PATH first
  try {
    return execFileSync('which', [name], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch { /* binary not on PATH */ }

  // Fall back to well-known locations
  for (const c of candidates) {
    if (existsSync(c)) return c
  }

  // Last resort — return bare name and let the caller handle ENOENT
  return name
}
