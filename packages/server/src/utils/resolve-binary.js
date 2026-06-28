import { execFileSync } from 'child_process'
import { existsSync } from 'fs'

const isWindows = process.platform === 'win32'

// Windows extension preference. We want a form that can be spawned DIRECTLY by
// `child_process.spawn` (no shell) AND by node-pty: `.exe`/`.com` qualify, so
// they win. The `.cmd`/`.bat` shims npm also installs work under node-pty and,
// on the plain-subprocess path, only after cmd.exe routing (see win-spawn.js) —
// so they rank below the native executables but above anything else. The bare
// extensionless entry npm installs alongside them is a POSIX shell wrapper: it
// is NOT a valid Win32 executable and BOTH spawn paths refuse it (child_process
// → ENOENT, node-pty → "error code 193"), so it is never selected.
const WIN_EXT_PRIORITY = ['.exe', '.com', '.cmd', '.bat']

// PATHEXT is the OS's authority on which extensions are "executable" on this
// host. Anything outside it (the extensionless POSIX wrapper) is not runnable.
function windowsExecutableExtensions() {
  return (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function extensionOf(filePath) {
  const sep = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  const base = sep >= 0 ? filePath.slice(sep + 1) : filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

// `where` prints every match on PATH, one per line and in PATH/PATHEXT order.
// Pick the best directly-runnable executable from that list (see WIN_EXT_PRIORITY).
// Exported for unit testing the selection logic independent of the host platform.
export function pickWindowsExecutable(lines) {
  const pathext = windowsExecutableExtensions()
  const runnable = lines.filter((p) => pathext.includes(extensionOf(p)))
  for (const wanted of WIN_EXT_PRIORITY) {
    const hit = runnable.find((p) => extensionOf(p) === wanted)
    if (hit) return hit
  }
  // Some other PATHEXT-registered executable (rare for our binaries) still beats
  // the extensionless wrapper, which is filtered out above.
  return runnable[0] || null
}

/**
 * Resolve the full path to a named binary.
 *
 * First tries the OS PATH lookup so any binary on the caller's PATH is found
 * automatically — `which` on POSIX, `where` on Windows (`which` does not exist
 * on native Windows; calling it threw ENOENT and silently dropped every
 * PATH-installed binary into the candidates/bare-name fallback). On Windows
 * `where` returns one match per line and may include a non-runnable POSIX shell
 * wrapper, so we select the best directly-spawnable executable rather than the
 * first line (see pickWindowsExecutable).
 *
 * If the PATH lookup fails (e.g. the process was started with a minimal PATH
 * such as just the Node bin directory), each entry in `candidates` is tested
 * with `existsSync`. If none exist, `name` is returned as-is so the caller gets
 * a descriptive ENOENT rather than a silent failure.
 *
 * @param {string}   name       - Binary name (e.g. 'git', 'gemini', 'codex')
 * @param {string[]} candidates - Ordered list of absolute fallback paths to try
 * @returns {string} Resolved absolute path, or `name` if not found anywhere
 */
export function resolveBinary(name, candidates) {
  // Try PATH first
  try {
    const finder = isWindows ? 'where' : 'which'
    const out = execFileSync(finder, [name], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (isWindows) {
      const picked = pickWindowsExecutable(lines)
      if (picked) return picked
    } else if (lines.length > 0) {
      return lines[0]
    }
  } catch { /* binary not on PATH (or the finder itself is unavailable) */ }

  // Fall back to well-known locations
  for (const c of candidates || []) {
    if (existsSync(c)) return c
  }

  // Last resort — return bare name and let the caller handle ENOENT
  return name
}
