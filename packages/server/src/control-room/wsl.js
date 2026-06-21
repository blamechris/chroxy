/**
 * WSL2 distro survey + actions (#6138, epic #5530) — Windows hosts only.
 * Sibling of `simulators.js` / `emulators.js`; feeds the same Control Room
 * "Device runtimes" tab.
 *
 * Surfaces `wsl.exe -l -v` (installed distros: name / state / WSL version, plus
 * which is the default). Start runs a no-op command in a distro to boot it
 * (`wsl.exe -d <name> -e true`); terminate stops a running distro
 * (`wsl.exe --terminate <name>`).
 *
 * Degradation-first: off Windows, OR no `wsl.exe` (WSL not installed) →
 * `available: false` with a `note` and an empty list — a first-class state,
 * never an error. Every external interaction is injectable so tests never touch
 * a real WSL / the platform:
 *   - `_execFile(file, args, opts)` — promisified `child_process.execFile`.
 *   - `_platform()` — `process.platform` (so a test can simulate win32).
 *   - `_now()` — clock.
 *
 * Pure parse/classify helpers are exported individually for unit tests.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { getErrorMessage } from '../utils/error-message.js'

const execFileAsync = promisify(execFile)

/** Bound each wsl.exe probe so a stuck distro/service rejects in finite time. */
export const EXEC_TIMEOUT_MS = 20000
const EXEC_MAX_BUFFER = 16 * 1024 * 1024
const EXEC_OPTS = { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }
// The survey reads `wsl.exe -l -v`, which emits UTF-16LE. execFile's default
// UTF-8 decode would corrupt non-ASCII distro names BEFORE the parser sees them,
// so capture raw bytes and decode explicitly (see decodeWslOutput).
const EXEC_OPTS_BUFFER = { ...EXEC_OPTS, encoding: 'buffer' }

/** #6138: the mutating WSL actions the Control Room can run. */
export const WSL_ACTIONS = ['start', 'terminate']

/** NUL byte, built without a control-char literal in source (see #6138 parse). */
const NUL = String.fromCharCode(0)

/**
 * Decode `wsl.exe` output to a string. wsl.exe emits UTF-16LE, so the survey
 * captures raw bytes (`encoding: 'buffer'`). Heuristic: a Buffer containing any
 * NUL byte is UTF-16LE (ASCII text in UTF-16LE has a NUL in every other byte;
 * valid UTF-8 never contains NUL) → decode `utf16le`; otherwise `utf8`. A value
 * that's already a string is returned as-is (test convenience + defensive). This
 * preserves non-ASCII distro names that a UTF-8 decode of UTF-16 bytes would
 * corrupt. Never throws.
 *
 * @param {Buffer|string} out
 * @returns {string}
 */
export function decodeWslOutput(out) {
  if (typeof out === 'string') return out
  if (!out || typeof out.includes !== 'function') return ''
  // Buffer.includes(0) → true when a NUL byte is present (UTF-16LE signature).
  return out.includes(0) ? out.toString('utf16le') : out.toString('utf8')
}

/**
 * Parse `wsl.exe -l -v` output into a distro list. The real command emits
 * UTF-16LE with a header row and a leading `*` marking the default distro, e.g.
 *
 *   ```
 *     NAME            STATE           VERSION
 *   * Ubuntu          Running         2
 *     Debian          Stopped         2
 *   ```
 *
 * We strip NUL bytes (so raw UTF-16-as-bytes decodes), drop the header, and read
 * the `*` flag + the three whitespace-delimited columns. Tolerant of empty /
 * garbage output → `[]`. Never throws.
 *
 * @param {string} stdout
 * @returns {Array<{name: string, state: string, version: number|null, isDefault: boolean}>}
 */
export function parseWslList(stdout) {
  if (typeof stdout !== 'string') return []
  // wsl.exe emits UTF-16LE; if it arrived as raw bytes interpreted as latin1 the
  // text is interleaved with NULs. Strip NULs + CRs so either encoding parses.
  const clean = stdout.split(NUL).join('').replace(/\r/g, '')
  const out = []
  for (const line of clean.split('\n')) {
    if (!line.trim()) continue
    // Default-distro marker is a leading '*' (possibly indented).
    const isDefault = /^\s*\*/.test(line)
    const body = line.replace(/^\s*\*?\s*/, '')
    // Header row — skip (its first column is the literal "NAME").
    const cols = body.split(/\s{2,}|\t+/).map((c) => c.trim()).filter(Boolean)
    if (cols.length === 0) continue
    if (cols[0].toUpperCase() === 'NAME') continue
    const [name, state, versionRaw] = cols
    if (!name) continue
    const v = Number.parseInt(versionRaw, 10)
    out.push({
      name,
      state: state || 'Unknown',
      version: Number.isFinite(v) ? v : null,
      isDefault,
    })
  }
  return out
}

/**
 * Survey WSL2 distros.
 *
 * @param {object} [opts]
 * @param {Function} [opts._execFile]
 * @param {() => string} [opts._platform]
 * @param {() => Date} [opts._now]
 * @returns {Promise<{generatedAt: string, available: boolean, note: string|null,
 *   defaultDistro: string|null, distros: Array}>}
 */
export async function surveyWsl(opts = {}) {
  const {
    _execFile = execFileAsync,
    _platform = () => process.platform,
    _now = () => new Date(),
  } = opts
  const now = _now()
  const base = { generatedAt: now.toISOString(), available: false, note: null, defaultDistro: null, distros: [] }

  // WSL is Windows-only — quiet, first-class "absent" everywhere else.
  if (_platform() !== 'win32') {
    return { ...base, note: 'WSL is only available on Windows hosts.' }
  }

  let distros
  try {
    // Capture raw bytes (wsl.exe emits UTF-16LE) and decode explicitly.
    const { stdout } = await _execFile('wsl.exe', ['-l', '-v'], EXEC_OPTS_BUFFER)
    distros = parseWslList(decodeWslOutput(stdout))
  } catch (err) {
    // No wsl.exe / WSL not installed — first-class "absent".
    return {
      ...base,
      note: `WSL is not available on this host (${getErrorMessage(err, 'wsl.exe -l -v failed')}).`,
    }
  }

  const def = distros.find((d) => d.isDefault) || null
  return {
    generatedAt: now.toISOString(),
    available: true,
    note: null,
    defaultDistro: def ? def.name : null,
    distros,
  }
}

/**
 * Start or terminate a WSL distro. Caller (the handler) validates the target
 * against a fresh survey and state-gates the action; this is the raw exec,
 * mirroring `runEmulatorAction`.
 *
 * start boots a stopped distro by running a trivial command in it
 * (`wsl.exe -d <name> -e true`) and returns 'running'; terminate stops a running
 * distro (`wsl.exe --terminate <name>`) and returns 'stopped'.
 *
 * @param {object} opts
 * @param {'start'|'terminate'} opts.action
 * @param {string} opts.distro
 * @param {Function} [opts._execFile]
 * @returns {Promise<'running'|'stopped'>}
 */
export async function runWslAction({ action, distro, _execFile = execFileAsync } = {}) {
  if (!WSL_ACTIONS.includes(action)) {
    throw new Error(`Unsupported WSL action: ${action || '(none)'}`)
  }
  if (typeof distro !== 'string' || !distro) {
    throw new Error('runWslAction requires a distro')
  }
  if (action === 'start') {
    await _execFile('wsl.exe', ['-d', distro, '-e', 'true'], EXEC_OPTS)
    return 'running'
  }
  // terminate
  await _execFile('wsl.exe', ['--terminate', distro], EXEC_OPTS)
  return 'stopped'
}
