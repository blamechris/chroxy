/**
 * Device runtimes Control Room tab: iOS simulators (#6136), Android emulators (#6137), and WSL2 distros (#6138) — survey + action acks, each surface a 'Ready for Maestro' verdict / first-class unavailable state.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
/** One iOS simulator from `xcrun simctl list devices`. */
export declare const SimulatorDeviceSchema: z.ZodObject<{
    udid: z.ZodString;
    name: z.ZodString;
    state: z.ZodString;
    runtime: z.ZodString;
    deviceType: z.ZodNullable<z.ZodString>;
    isAvailable: z.ZodBoolean;
}, z.core.$strip>;
/** The composite "Ready for Maestro" verdict (CLAUDE.md pre-flight). */
export declare const ReadyForMaestroSchema: z.ZodObject<{
    ready: z.ZodBoolean;
    bootedSimulator: z.ZodNullable<z.ZodString>;
    metroReachable: z.ZodBoolean;
    mockServerReachable: z.ZodBoolean;
    reasons: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const ServerSimulatorStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"simulator_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    available: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    devices: z.ZodArray<z.ZodObject<{
        udid: z.ZodString;
        name: z.ZodString;
        state: z.ZodString;
        runtime: z.ZodString;
        deviceType: z.ZodNullable<z.ZodString>;
        isAvailable: z.ZodBoolean;
    }, z.core.$strip>>;
    readyForMaestro: z.ZodObject<{
        ready: z.ZodBoolean;
        bootedSimulator: z.ZodNullable<z.ZodString>;
        metroReachable: z.ZodBoolean;
        mockServerReachable: z.ZodBoolean;
        reasons: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6136 slice 2 — ack for a successful `simulator_action` (boot/shutdown).
 * Echoes `action`/`udid` (+ optional `requestId`) and carries the resulting
 * `status` (the device's new state, "Booted"/"Shutdown"). A failure replies with
 * a `SIMULATOR_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export declare const ServerSimulatorActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"simulator_action_ack">;
    action: z.ZodString;
    udid: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodNullable<z.ZodString>;
}, z.core.$loose>;
/**
 * One Android emulator/AVD. A running emulator has a `serial` (e.g.
 * "emulator-5554") and `state:"running"`; an installed-but-stopped AVD has
 * `serial:null` and `state:"stopped"`. `avd` may be null for a running emulator
 * whose AVD name couldn't be resolved.
 */
export declare const EmulatorDeviceSchema: z.ZodObject<{
    avd: z.ZodNullable<z.ZodString>;
    serial: z.ZodNullable<z.ZodString>;
    state: z.ZodString;
}, z.core.$strip>;
/** The composite Android "Ready for Maestro" verdict (CLAUDE.md pre-flight). */
export declare const EmulatorReadyForMaestroSchema: z.ZodObject<{
    ready: z.ZodBoolean;
    runningDevice: z.ZodNullable<z.ZodString>;
    metroReachable: z.ZodBoolean;
    mockServerReachable: z.ZodBoolean;
    reasons: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const ServerEmulatorStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"emulator_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    available: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    devices: z.ZodArray<z.ZodObject<{
        avd: z.ZodNullable<z.ZodString>;
        serial: z.ZodNullable<z.ZodString>;
        state: z.ZodString;
    }, z.core.$strip>>;
    readyForMaestro: z.ZodObject<{
        ready: z.ZodBoolean;
        runningDevice: z.ZodNullable<z.ZodString>;
        metroReachable: z.ZodBoolean;
        mockServerReachable: z.ZodBoolean;
        reasons: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6137 — ack for a successful `emulator_action` (boot/kill). Echoes `action`
 * (+ optional `avd`/`serial`/`requestId`) and carries the resulting `status`
 * ("starting" after a boot, "killed" after a kill). A failure replies with an
 * `EMULATOR_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export declare const ServerEmulatorActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"emulator_action_ack">;
    action: z.ZodString;
    avd: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    serial: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodNullable<z.ZodString>;
}, z.core.$loose>;
/** One WSL distro from `wsl.exe -l -v`. */
export declare const WslDistroSchema: z.ZodObject<{
    name: z.ZodString;
    state: z.ZodString;
    version: z.ZodNullable<z.ZodNumber>;
    isDefault: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerWslStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"wsl_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    available: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    defaultDistro: z.ZodNullable<z.ZodString>;
    distros: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        state: z.ZodString;
        version: z.ZodNullable<z.ZodNumber>;
        isDefault: z.ZodBoolean;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6138 — ack for a successful `wsl_action` (start/terminate). Echoes `action`/
 * `distro` (+ optional `requestId`) and carries the resulting `status`
 * ("running" after a start, "stopped" after a terminate). A failure replies with
 * a `WSL_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export declare const ServerWslActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"wsl_action_ack">;
    action: z.ZodString;
    distro: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodNullable<z.ZodString>;
}, z.core.$loose>;
