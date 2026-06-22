/**
 * Device runtimes Control Room tab: iOS simulators (#6136), Android emulators (#6137), and WSL2 distros (#6138) — survey + action acks, each surface a 'Ready for Maestro' verdict / first-class unavailable state.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */

import { z } from 'zod'

// ───────────────────────────────────────────────────────────────────────────
// #6136 (epic #5530) — Control Room iOS simulator survey + "Ready for Maestro"
// verdict. Read-only. Off macOS / no xcrun → available:false (a first-class
// state, not an error), same degraded-snapshot posture as the sibling surveys.
// ───────────────────────────────────────────────────────────────────────────

/** One iOS simulator from `xcrun simctl list devices`. */
export const SimulatorDeviceSchema = z.object({
  udid: z.string(),
  name: z.string(),
  state: z.string(),       // "Booted" | "Shutdown" | "Unknown" | …
  runtime: z.string(),     // friendly, e.g. "iOS 26.1"
  deviceType: z.string().nullable(),
  isAvailable: z.boolean(),
})

/** The composite "Ready for Maestro" verdict (CLAUDE.md pre-flight). */
export const ReadyForMaestroSchema = z.object({
  ready: z.boolean(),
  bootedSimulator: z.string().nullable(),
  metroReachable: z.boolean(),
  mockServerReachable: z.boolean(),
  reasons: z.array(z.string()),
})

export const ServerSimulatorStatusSnapshotSchema = z.object({
  type: z.literal('simulator_status_snapshot'),
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // false off macOS / no xcrun → devices empty, note set, verdict not-ready.
  available: z.boolean(),
  note: z.string().nullable(),
  devices: z.array(SimulatorDeviceSchema),
  readyForMaestro: ReadyForMaestroSchema,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough()

/**
 * #6136 slice 2 — ack for a successful `simulator_action` (boot/shutdown).
 * Echoes `action`/`udid` (+ optional `requestId`) and carries the resulting
 * `status` (the device's new state, "Booted"/"Shutdown"). A failure replies with
 * a `SIMULATOR_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export const ServerSimulatorActionAckSchema = z.object({
  type: z.literal('simulator_action_ack'),
  action: z.string(),
  udid: z.string(),
  requestId: z.string().max(128).nullable().optional(),
  status: z.string().nullable(),
}).passthrough()

// ───────────────────────────────────────────────────────────────────────────
// #6137 (epic #5530) — Control Room Android emulator survey + "Ready for Maestro"
// verdict (shares the Device runtimes tab with iOS). Read-only. No Android SDK →
// available:false (a first-class state), same degraded-snapshot posture.
// ───────────────────────────────────────────────────────────────────────────

/**
 * One Android emulator/AVD. A running emulator has a `serial` (e.g.
 * "emulator-5554") and `state:"running"`; an installed-but-stopped AVD has
 * `serial:null` and `state:"stopped"`. `avd` may be null for a running emulator
 * whose AVD name couldn't be resolved.
 */
export const EmulatorDeviceSchema = z.object({
  avd: z.string().nullable(),
  serial: z.string().nullable(),
  state: z.string(),       // "running" | "stopped"
})

/** The composite Android "Ready for Maestro" verdict (CLAUDE.md pre-flight). */
export const EmulatorReadyForMaestroSchema = z.object({
  ready: z.boolean(),
  runningDevice: z.string().nullable(),
  metroReachable: z.boolean(),
  mockServerReachable: z.boolean(),
  reasons: z.array(z.string()),
})

export const ServerEmulatorStatusSnapshotSchema = z.object({
  type: z.literal('emulator_status_snapshot'),
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // false with no Android SDK → devices empty, note set, verdict not-ready.
  available: z.boolean(),
  note: z.string().nullable(),
  devices: z.array(EmulatorDeviceSchema),
  readyForMaestro: EmulatorReadyForMaestroSchema,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough()

/**
 * #6137 — ack for a successful `emulator_action` (boot/kill). Echoes `action`
 * (+ optional `avd`/`serial`/`requestId`) and carries the resulting `status`
 * ("starting" after a boot, "killed" after a kill). A failure replies with an
 * `EMULATOR_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export const ServerEmulatorActionAckSchema = z.object({
  type: z.literal('emulator_action_ack'),
  action: z.string(),
  avd: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
  requestId: z.string().max(128).nullable().optional(),
  status: z.string().nullable(),
}).passthrough()

// ───────────────────────────────────────────────────────────────────────────
// #6138 (epic #5530) — Control Room WSL2 distro survey (shares the Device
// runtimes tab). Read-only. Off Windows / no wsl.exe → available:false (a
// first-class state), same degraded-snapshot posture.
// ───────────────────────────────────────────────────────────────────────────

/** One WSL distro from `wsl.exe -l -v`. */
export const WslDistroSchema = z.object({
  name: z.string(),
  state: z.string(),                 // "Running" | "Stopped" | "Unknown" | …
  version: z.number().nullable(),    // WSL version (1 | 2), null if unparseable
  isDefault: z.boolean(),
})

export const ServerWslStatusSnapshotSchema = z.object({
  type: z.literal('wsl_status_snapshot'),
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // false off Windows / no wsl.exe → distros empty, note set.
  available: z.boolean(),
  note: z.string().nullable(),
  defaultDistro: z.string().nullable(),
  distros: z.array(WslDistroSchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough()

/**
 * #6138 — ack for a successful `wsl_action` (start/terminate). Echoes `action`/
 * `distro` (+ optional `requestId`) and carries the resulting `status`
 * ("running" after a start, "stopped" after a terminate). A failure replies with
 * a `WSL_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export const ServerWslActionAckSchema = z.object({
  type: z.literal('wsl_action_ack'),
  action: z.string(),
  distro: z.string(),
  requestId: z.string().max(128).nullable().optional(),
  status: z.string().nullable(),
}).passthrough()
