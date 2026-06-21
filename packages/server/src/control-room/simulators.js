/**
 * iOS simulator survey (#6136, epic #5530) — READ-ONLY (macOS hosts).
 *
 * Surfaces `xcrun simctl list devices --json` in the Control Room: each
 * simulator's name / udid / state (Booted/Shutdown) / runtime / device type, plus
 * a headline **"Ready for Maestro" verdict** — a booted simulator AND Metro
 * (:8081) reachable AND the mock server (:9876) reachable — turning the manual
 * Maestro pre-flight (CLAUDE.md "UI Verification with Maestro") into one glance.
 *
 * Degradation-first: off macOS / no `xcrun` → `available: false` with a `note`
 * and an empty device list — a first-class state, never an error. Every external
 * interaction is injectable so tests never touch real simctl / sockets:
 *   - `_execFile(file, args, opts)` — promisified `child_process.execFile`.
 *   - `_probePort(port)` — resolves true if a TCP connect to 127.0.0.1:port works.
 *   - `_now()` — clock.
 *
 * Pure parse/classify helpers are exported individually for unit tests.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import net from 'net'
import { getErrorMessage } from '../utils/error-message.js'

const execFileAsync = promisify(execFile)

/** Bound the simctl probe so a stuck Simulator service rejects in finite time. */
export const EXEC_TIMEOUT_MS = 20000
const EXEC_MAX_BUFFER = 16 * 1024 * 1024
const EXEC_OPTS = { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }

/** Ports the Maestro pre-flight depends on (CLAUDE.md). */
export const METRO_PORT = 8081
export const MOCK_SERVER_PORT = 9876
/** Per-port reachability probe timeout. */
export const PROBE_TIMEOUT_MS = 1500

/**
 * Friendly runtime name from a simctl runtime key, e.g.
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-1` → `iOS 26.1`. A key whose tail
 * doesn't match the `OS-major[-minor[-patch]]` shape falls back to that raw tail
 * (e.g. `iOS-26-1-2` → `iOS-26-1-2`); a non-string falls back to `'unknown'`.
 * Never throws.
 *
 * @param {string} key
 * @returns {string}
 */
export function friendlyRuntime(key) {
  if (typeof key !== 'string' || !key) return 'unknown'
  const tail = key.split('.SimRuntime.').pop() || key
  // "iOS-26-1" → "iOS 26.1"; "watchOS-11-0" → "watchOS 11.0".
  const m = /^([A-Za-z]+)-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(tail)
  if (!m) return tail
  const os = m[1]
  const ver = [m[2], m[3], m[4]].filter((p) => p !== undefined).join('.')
  return `${os} ${ver}`
}

/**
 * Friendly device-type name, e.g.
 * `com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro` → `iPhone 16 Pro`.
 *
 * @param {string} id
 * @returns {string|null}
 */
export function friendlyDeviceType(id) {
  if (typeof id !== 'string' || !id) return null
  const tail = id.split('.SimDeviceType.').pop() || id
  return tail.replace(/-/g, ' ')
}

/**
 * Parse `xcrun simctl list devices --json` output into a flat device list. The
 * raw shape is `{ devices: { "<runtime key>": [ { udid, name, state,
 * isAvailable, deviceTypeIdentifier } ] } }`. Unavailable devices (runtime not
 * installed) are dropped. Tolerant of malformed JSON / missing fields — returns
 * `[]` rather than throwing.
 *
 * @param {string} stdout
 * @returns {Array<{udid: string, name: string, state: string, runtime: string, deviceType: string|null, isAvailable: boolean}>}
 */
export function parseSimctlDevices(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  const byRuntime = parsed && typeof parsed === 'object' ? parsed.devices : null
  if (!byRuntime || typeof byRuntime !== 'object') return []
  const out = []
  for (const [runtimeKey, list] of Object.entries(byRuntime)) {
    if (!Array.isArray(list)) continue
    for (const d of list) {
      if (!d || typeof d.udid !== 'string') continue
      if (d.isAvailable === false) continue
      out.push({
        udid: d.udid,
        name: typeof d.name === 'string' ? d.name : d.udid,
        state: typeof d.state === 'string' ? d.state : 'Unknown',
        runtime: friendlyRuntime(runtimeKey),
        deviceType: friendlyDeviceType(d.deviceTypeIdentifier),
        isAvailable: d.isAvailable !== false,
      })
    }
  }
  // Booted first (operator's attention), then by name for stable output.
  out.sort((a, b) => {
    const ab = a.state === 'Booted' ? 0 : 1
    const bb = b.state === 'Booted' ? 0 : 1
    if (ab !== bb) return ab - bb
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return out
}

/** #6136 slice 2: the mutating simulator actions the Control Room can run. */
export const SIMULATOR_ACTIONS = ['boot', 'shutdown']

/**
 * Boot or shut down a single iOS simulator via `xcrun simctl <action> <udid>`.
 * Caller (the handler) is responsible for validating `udid` against a fresh
 * survey and state-gating the action — this is the raw exec, mirroring
 * `runHostPrune` in host-prune.js. Returns the device's expected new state.
 *
 * @param {object} opts
 * @param {'boot'|'shutdown'} opts.action
 * @param {string} opts.udid
 * @param {Function} [opts._execFile]
 * @returns {Promise<'Booted'|'Shutdown'>}
 */
export async function runSimulatorAction({ action, udid, _execFile = execFileAsync } = {}) {
  if (!SIMULATOR_ACTIONS.includes(action)) {
    throw new Error(`Unsupported simulator action: ${action || '(none)'}`)
  }
  if (typeof udid !== 'string' || !udid) {
    throw new Error('runSimulatorAction requires a udid')
  }
  await _execFile('xcrun', ['simctl', action, udid], EXEC_OPTS)
  return action === 'boot' ? 'Booted' : 'Shutdown'
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
 * Survey iOS simulators + compute the "Ready for Maestro" verdict.
 *
 * @param {object} [opts]
 * @param {Function} [opts._execFile]
 * @param {(port: number) => Promise<boolean>} [opts._probePort]
 * @param {() => Date} [opts._now]
 * @returns {Promise<{generatedAt: string, available: boolean, note: string|null,
 *   devices: Array, readyForMaestro: {ready: boolean, bootedSimulator: string|null,
 *   metroReachable: boolean, mockServerReachable: boolean, reasons: string[]}}>}
 */
export async function surveySimulators(opts = {}) {
  const {
    _execFile = execFileAsync,
    _probePort = defaultProbePort,
    _now = () => new Date(),
  } = opts
  const now = _now()
  const emptyVerdict = { ready: false, bootedSimulator: null, metroReachable: false, mockServerReachable: false, reasons: [] }
  const base = { generatedAt: now.toISOString(), available: false, note: null, devices: [], readyForMaestro: emptyVerdict }

  let devices
  try {
    const { stdout } = await _execFile('xcrun', ['simctl', 'list', 'devices', '--json'], EXEC_OPTS)
    devices = parseSimctlDevices(stdout)
  } catch (err) {
    // No xcrun (not macOS / no Xcode) or simctl failed — first-class "absent".
    return {
      ...base,
      note: `iOS simulators are not available on this host (${getErrorMessage(err, 'xcrun simctl failed')}).`,
    }
  }

  const booted = devices.find((d) => d.state === 'Booted') || null
  // Probe Metro + mock-server concurrently (independent ports).
  const [metroReachable, mockServerReachable] = await Promise.all([
    _probePort(METRO_PORT).catch(() => false),
    _probePort(MOCK_SERVER_PORT).catch(() => false),
  ])

  const reasons = []
  if (!booted) reasons.push('No booted simulator')
  if (!metroReachable) reasons.push(`Metro not reachable on :${METRO_PORT}`)
  if (!mockServerReachable) reasons.push(`Mock server not reachable on :${MOCK_SERVER_PORT}`)

  return {
    generatedAt: now.toISOString(),
    available: true,
    note: null,
    devices,
    readyForMaestro: {
      ready: Boolean(booted) && metroReachable && mockServerReachable,
      bootedSimulator: booted ? booted.name : null,
      metroReachable,
      mockServerReachable,
      reasons,
    },
  }
}
