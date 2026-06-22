/**
 * Android emulator survey + actions (#6137, epic #5530) — macOS/Linux hosts with
 * the Android SDK. Sibling of `simulators.js`; feeds the same Control Room
 * "Device runtimes" tab.
 *
 * Surfaces `emulator -list-avds` (installed AVDs) joined with `adb devices`
 * (which are running) + a headline **"Ready for Maestro" verdict** — a running
 * emulator AND Metro (:8081) AND the mock server (:9876) reachable. Boot starts
 * an AVD (optionally headless `-no-window`); kill stops a running serial via
 * `adb emu kill`.
 *
 * Degradation-first: no `emulator` binary (SDK absent) → `available: false` with
 * a `note` and an empty list — a first-class state, never an error. Every
 * external interaction is injectable so tests never touch the real SDK / sockets:
 *   - `_execFile(file, args, opts)` — promisified `child_process.execFile`.
 *   - `_spawn(file, args, opts)` — `child_process.spawn` (boot is detached).
 *   - `_probePort(port)` — TCP reachability probe.
 *   - `_now()` — clock.
 *
 * Pure parse/classify helpers are exported individually for unit tests.
 */

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import net from 'net'
import { getErrorMessage } from '../utils/error-message.js'
import { EXEC_TIMEOUT_MS } from './constants.js'

const execFileAsync = promisify(execFile)

const EXEC_MAX_BUFFER = 16 * 1024 * 1024
const EXEC_OPTS = { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }

/** Ports the Maestro pre-flight depends on (CLAUDE.md), shared with iOS. */
export const METRO_PORT = 8081
export const MOCK_SERVER_PORT = 9876
/** Per-port reachability probe timeout. */
export const PROBE_TIMEOUT_MS = 1500

/** #6137: the mutating emulator actions the Control Room can run. */
export const EMULATOR_ACTIONS = ['boot', 'kill']

/**
 * Parse `emulator -list-avds` stdout into a sorted, de-duped AVD-name list.
 * The command prints one AVD name per line (plus occasional INFO/warning lines
 * that we drop — real AVD names have no whitespace). Tolerant of empty/garbage
 * output → `[]`. Never throws.
 *
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseAvdList(stdout) {
  if (typeof stdout !== 'string') return []
  const names = stdout
    .split('\n')
    .map((l) => l.trim())
    // AVD names are a single token (no spaces); this drops "INFO | ..." noise.
    .filter((l) => l.length > 0 && !/\s/.test(l))
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Parse `adb devices` stdout into emulator entries. Lines look like
 * `emulator-5554\tdevice`; we keep `emulator-*` serials and map the adb state:
 * `device` → `running` (usable), `offline` → `starting` (booting, not usable
 * yet but already live — surfacing it stops the UI from booting a duplicate and
 * lets `kill` target it). Other states / physical devices / the `adb` header
 * are dropped. Deduped by serial (preferring `running`), sorted. Never throws.
 *
 * @param {string} stdout
 * @returns {Array<{serial: string, state: 'running'|'starting'}>}
 */
export function parseAdbDevices(stdout) {
  if (typeof stdout !== 'string') return []
  const bySerial = new Map()
  for (const line of stdout.split('\n')) {
    const m = /^(emulator-\d+)\s+(\w+)/.exec(line.trim())
    if (!m) continue
    const state = m[2] === 'device' ? 'running' : m[2] === 'offline' ? 'starting' : null
    if (!state) continue
    const prev = bySerial.get(m[1])
    // Prefer the usable 'running' state if a serial somehow appears twice.
    if (!prev || (prev.state === 'starting' && state === 'running')) {
      bySerial.set(m[1], { serial: m[1], state })
    }
  }
  return [...bySerial.values()].sort((a, b) => (a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0))
}

/** Default TCP reachability probe for 127.0.0.1:port (no data sent). */
function defaultProbePort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    try {
      socket.connect(port, '127.0.0.1')
    } catch {
      done(false)
    }
  })
}

/**
 * Resolve a running emulator serial's AVD name via `adb -s <serial> emu avd
 * name` (best-effort — the first stdout line is the AVD name; on any failure
 * returns null so the survey still lists the serial).
 */
async function resolveAvdName(serial, execFn) {
  try {
    const { stdout } = await execFn('adb', ['-s', serial, 'emu', 'avd', 'name'], EXEC_OPTS)
    const first = String(stdout || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0 && l !== 'OK')
    return first || null
  } catch {
    return null
  }
}

/**
 * Survey Android emulators + compute the "Ready for Maestro" verdict.
 *
 * @param {object} [opts]
 * @param {Function} [opts._execFile]
 * @param {(port: number) => Promise<boolean>} [opts._probePort]
 * @param {() => Date} [opts._now]
 * @returns {Promise<{generatedAt: string, available: boolean, note: string|null,
 *   devices: Array, readyForMaestro: {ready: boolean, runningDevice: string|null,
 *   metroReachable: boolean, mockServerReachable: boolean, reasons: string[]}}>}
 */
export async function surveyEmulators(opts = {}) {
  const {
    _execFile = execFileAsync,
    _probePort = defaultProbePort,
    _now = () => new Date(),
  } = opts
  const now = _now()
  const emptyVerdict = { ready: false, runningDevice: null, metroReachable: false, mockServerReachable: false, reasons: [] }
  const base = { generatedAt: now.toISOString(), available: false, note: null, devices: [], readyForMaestro: emptyVerdict }

  let avds
  try {
    const { stdout } = await _execFile('emulator', ['-list-avds'], EXEC_OPTS)
    avds = parseAvdList(stdout)
  } catch (err) {
    // No `emulator` binary (Android SDK absent) — first-class "absent".
    return {
      ...base,
      note: `Android emulators are not available on this host (${getErrorMessage(err, 'emulator -list-avds failed')}).`,
    }
  }

  // `adb devices` is best-effort: if adb is missing we still list AVDs (all
  // stopped) rather than failing the whole survey. Each entry is {serial, state}
  // where state is 'running' (usable) or 'starting' (booting / adb 'offline').
  let adbRows = []
  try {
    const { stdout } = await _execFile('adb', ['devices'], EXEC_OPTS)
    adbRows = parseAdbDevices(stdout)
  } catch {
    adbRows = []
  }

  // Resolve each live serial's AVD name so we can fold it into the AVD list,
  // carrying the adb state ('running' | 'starting').
  const live = []
  for (const row of adbRows) {
    const avd = await resolveAvdName(row.serial, _execFile)
    live.push({ serial: row.serial, avd, state: row.state })
  }
  const liveAvdNames = new Set(live.map((r) => r.avd).filter(Boolean))

  const devices = [
    // Live emulators first (operator's attention): running or starting, serial known.
    ...live.map((r) => ({ avd: r.avd, serial: r.serial, state: r.state })),
    // Then installed-but-stopped AVDs: bootable, no serial yet.
    ...avds
      .filter((name) => !liveAvdNames.has(name))
      .map((name) => ({ avd: name, serial: null, state: 'stopped' })),
  ]

  const [metroReachable, mockServerReachable] = await Promise.all([
    _probePort(METRO_PORT).catch(() => false),
    _probePort(MOCK_SERVER_PORT).catch(() => false),
  ])

  // "Ready for Maestro" needs a FULLY running emulator — a booting ('starting')
  // one isn't usable yet.
  const fullyRunning = live.filter((r) => r.state === 'running')
  const hasRunning = fullyRunning.length > 0
  const reasons = []
  if (!hasRunning) reasons.push('No running emulator')
  if (!metroReachable) reasons.push(`Metro not reachable on :${METRO_PORT}`)
  if (!mockServerReachable) reasons.push(`Mock server not reachable on :${MOCK_SERVER_PORT}`)

  return {
    generatedAt: now.toISOString(),
    available: true,
    note: null,
    devices,
    readyForMaestro: {
      ready: hasRunning && metroReachable && mockServerReachable,
      runningDevice: hasRunning ? (fullyRunning[0].avd || fullyRunning[0].serial) : null,
      metroReachable,
      mockServerReachable,
      reasons,
    },
  }
}

/**
 * Boot an AVD or kill a running emulator. Caller (the handler) validates the
 * target against a fresh survey and state-gates the action; this is the raw
 * exec, mirroring `runSimulatorAction`.
 *
 * boot is a long-lived foreground process, so it is SPAWNED DETACHED (and
 * unref'd). We AWAIT the child's `spawn` event (so an async spawn failure —
 * ENOENT/EACCES — rejects here and surfaces as EMULATOR_ACTION_FAILED rather
 * than crashing the server on an unhandled `error` event), then resolve with
 * 'starting' — the next survey shows it as running. kill is a quick
 * `adb emu kill` and returns 'killed'.
 *
 * @param {object} opts
 * @param {'boot'|'kill'} opts.action
 * @param {string} [opts.avd]      AVD name (boot)
 * @param {string} [opts.serial]   running serial (kill)
 * @param {boolean} [opts.headless] boot with `-no-window`
 * @param {Function} [opts._execFile]
 * @param {Function} [opts._spawn]
 * @returns {Promise<'starting'|'killed'>}
 */
export async function runEmulatorAction({ action, avd, serial, headless = false, _execFile = execFileAsync, _spawn = spawn } = {}) {
  if (!EMULATOR_ACTIONS.includes(action)) {
    throw new Error(`Unsupported emulator action: ${action || '(none)'}`)
  }
  if (action === 'boot') {
    if (typeof avd !== 'string' || !avd) throw new Error('runEmulatorAction boot requires an avd')
    const args = ['-avd', avd]
    if (headless) args.push('-no-window')
    // Detached + unref so the emulator outlives this request; ignore stdio so
    // the parent isn't held open by the child's pipes. Resolve on 'spawn',
    // reject on 'error' — an unhandled 'error' on a ChildProcess would crash
    // the process.
    return await new Promise((resolve, reject) => {
      let settled = false
      const child = _spawn('emulator', args, { detached: true, stdio: 'ignore' })
      const onError = (err) => {
        if (settled) return
        settled = true
        reject(err instanceof Error ? err : new Error(`emulator spawn failed: ${err}`))
      }
      const onSpawn = () => {
        if (settled) return
        settled = true
        if (typeof child.unref === 'function') child.unref()
        resolve('starting')
      }
      if (child && typeof child.once === 'function') {
        child.once('error', onError)
        child.once('spawn', onSpawn)
      } else {
        // A stub child without an event emitter (defensive): treat as started.
        onSpawn()
      }
    })
  }
  // kill
  if (typeof serial !== 'string' || !serial) throw new Error('runEmulatorAction kill requires a serial')
  await _execFile('adb', ['-s', serial, 'emu', 'kill'], EXEC_OPTS)
  return 'killed'
}
