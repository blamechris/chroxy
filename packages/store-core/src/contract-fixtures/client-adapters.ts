/**
 * Per-client store adapters for the behavioral-contract fixtures (#5556.5).
 *
 * The shared dispatch table (`createDispatchTable` + `runDispatch`) is driven by
 * a {@link ClientStoreAdapter}. Both real clients build a byte-identical adapter
 * — `{ getActiveSessionId, hasSession, updateSession, setState, addMessage,
 * getSessions }` — over their own Zustand store. The ONLY place the two stores
 * diverge in a way the table can observe is inside `updateSession`:
 *
 *   - **App** (`packages/app/src/store/message-handler.ts:updateSession`): after
 *     merging the patch it derives an `activityState` from the new
 *     `{ isIdle, streamingMessageId, isPlanPending }` and writes
 *     `sessionStates` only. It does NOT mirror any field to flat state.
 *
 *   - **Dashboard** (`packages/dashboard/src/store/message-handler.ts:updateSession`):
 *     for the ACTIVE session it ALSO mirrors a fixed allow-list of fields
 *     (`messages`, `streamingMessageId`, `claudeReady`, `activeModel`,
 *     `permissionMode`, `contextUsage`, `lastResultCost`, `lastResultDuration`,
 *     `isIdle`) into flat top-level state, so the active session's view stays in
 *     sync with the flat slice the dashboard renders from.
 *
 * Both adapters here reproduce their client's real `updateSession` exactly, so a
 * fixture that asserts the resulting session/flat state proves the SHARED handler
 * produced identical mutations on both — and any surrounding-store divergence is
 * either pinned by a fixture's `divergent` block or fails the contract test.
 *
 * Pure logic, no platform deps — runs under store-core's vitest. (The per-client
 * SWITCH-case suites exercise the clients' REAL `handleMessage` directly.)
 */

import {
  createDispatchTable,
  runDispatch,
  type ClientStoreAdapter,
} from '../dispatch-table'
import type { ChatMessage, SessionInfo } from '../types'
import type { FixtureInitialState } from './fixtures'

/** A loose session shape — superset of the table's `DispatchSessionBase`. */
export interface FixtureSession {
  sessionId: string
  messages: ChatMessage[]
  [k: string]: unknown
}

/** The observable result of running a fixture through one client's adapter. */
export interface AdapterResult {
  /** Final per-session state (sessionStates equivalent). */
  sessions: Record<string, FixtureSession>
  /** Final flat (top-level) connection state. */
  flat: Record<string, unknown>
  /** Messages pushed via `addMessage`, in order. */
  added: ChatMessage[]
  /**
   * Imperative callbacks the table invoked, in order (#5653). Only the APP
   * adapter records these — it opts into `getCallback`; the dashboard adapter
   * has no `getCallback`, so the file-ops / git cases DECLINE there and never
   * reach a callback (the dashboard handles them in its local switch). An empty
   * array on the dashboard side IS the contract for those cases.
   */
  callbacks: Array<{ name: string; payload: unknown }>
  /**
   * Errors surfaced via the `addServerError` hook (#5618 Batch 3), in order.
   * BOTH clients record these — the contract asserts they receive the SAME
   * structured error for `session_restore_failed` / `session_persist_failed`
   * (each client renders it differently below the hook, which is out of scope).
   */
  serverErrors: Array<{ message: string; category?: string; sessionId?: string; recoverable?: boolean }>
  /**
   * Info toasts surfaced via the `addInfoNotification` hook (#5618 Batch 3), in
   * order. Only the DASHBOARD records these — the app omits the hook
   * (`session_stopped` shows no toast on mobile, #4879). An empty array on the
   * app side IS the contract for that case; the shared session patch is asserted
   * separately.
   */
  infoNotifications: string[]
  /**
   * Sessions switched to via `switchSession` (#5618 Batch 4), in order — the
   * client_focus_changed follow-mode auto-switch. BOTH clients call it
   * identically (the accessor hides where presence state lives), so the contract
   * asserts they switch to the same session(s).
   */
  switchedSessions: string[]
}

/** Which client an adapter models — drives the `updateSession` divergence. */
export type ClientKind = 'app' | 'dashboard'

/**
 * The dashboard's active-session flat-mirror allow-list
 * (`updateSession`, dashboard message-handler.ts). Exported so the contract test
 * can document it; kept in lock-step with the real client by the fixtures that
 * cover the active-session path.
 */
export const DASHBOARD_FLAT_MIRROR_KEYS = [
  'messages',
  'streamingMessageId',
  'claudeReady',
  'activeModel',
  'permissionMode',
  'contextUsage',
  'lastResultCost',
  'lastResultDuration',
  'isIdle',
] as const

/**
 * Build a faithful in-memory store + adapter for one client kind, seeded from a
 * fixture's initial state. Returns the adapter (for `runDispatch`) and live refs
 * to the resulting state.
 */
export function makeClientEnv(kind: ClientKind, init?: FixtureInitialState) {
  const sessions: Record<string, FixtureSession> = {}
  for (const [id, seed] of Object.entries(init?.sessions ?? {})) {
    sessions[id] = { sessionId: id, messages: [], ...seed } as FixtureSession
  }
  let activeSessionId = init?.activeSessionId ?? null
  let sessionList: SessionInfo[] = init?.sessionList ?? []
  const myClientId = init?.myClientId ?? null
  const followMode = init?.followMode ?? false
  const flat: Record<string, unknown> = {}
  const added: ChatMessage[] = []
  const callbacks: Array<{ name: string; payload: unknown }> = []
  const serverErrors: AdapterResult['serverErrors'] = []
  const infoNotifications: string[] = []
  const switchedSessions: string[] = []

  // Reproduce each client's real `updateSession`. Both share the
  // "no-op on missing session / empty patch" guard; they diverge only in the
  // post-merge step.
  function updateSession(id: string, updater: (s: FixtureSession) => Partial<FixtureSession>): void {
    const current = sessions[id]
    if (!current) return
    const patch = updater(current)
    if (Object.keys(patch).length === 0) return
    const updated = { ...current, ...patch }
    sessions[id] = updated

    if (kind === 'dashboard' && id === activeSessionId) {
      // Dashboard mirrors a fixed allow-list of fields onto flat state for the
      // active session.
      for (const key of DASHBOARD_FLAT_MIRROR_KEYS) {
        if (key in patch) flat[key] = (patch as Record<string, unknown>)[key]
      }
    }
    // App derives `activityState` here (session-local only); none of the
    // dispatch fixtures assert it, and it never touches flat state, so it is a
    // no-op for the contract surface. Modelled as intentionally omitted.
  }

  const adapter: ClientStoreAdapter<FixtureSession> = {
    getActiveSessionId: () => activeSessionId,
    hasSession: (id) => Object.prototype.hasOwnProperty.call(sessions, id),
    updateSession,
    setState: (patch) => Object.assign(flat, patch),
    // #5556 slice 4 — functional flat-state update. Both clients back it with
    // their Zustand `set((state) => …)`, modelled here as a read-merge of the
    // live `flat` ref so the web-task upsert fixtures observe identical results.
    updateState: (updater) => Object.assign(flat, updater(flat)),
    addMessage: (m) => added.push(m),
    getSessions: () => sessionList,
    // #5618 — `pushSessionNotification` is a UI side-effect OUTSIDE the shared
    // store-state contract (the app additionally mirrors into its mobile push
    // store; the dashboard does not). Modelled as a no-op here, exactly like the
    // app's `activityState` derivation above — no fixture asserts on it.
    pushSessionNotification: () => {},
    // #5618 Batch 3 — BOTH clients surface recoverable errors via `addServerError`
    // (the error-sink for session_restore_failed / session_persist_failed). Record
    // the (message + structured opts) so the contract asserts both clients receive
    // the SAME error. How each renders it (app structured ServerError + ring +
    // notification store; dashboard string banner) is below the hook, out of scope.
    addServerError: (message, opts) => {
      serverErrors.push({ message, ...(opts ?? {}) })
    },
    // #5618 Batch 4 — multi-client accessors. BOTH clients supply them (the
    // accessor hides where presence state lives — app multi-client store vs
    // dashboard flat). `switchSession` is recorded so the client_focus_changed
    // contract asserts both clients auto-switch to the same session.
    getMyClientId: () => myClientId,
    getFollowMode: () => followMode,
    switchSession: (sessionId) => switchedSessions.push(sessionId),
    // #5653 — only the APP opts its imperative-callback registry into the table.
    // Model it as "a callback IS registered for every channel" so the contract
    // can observe the invocation + payload. The DASHBOARD omits `getCallback`
    // entirely (no spread below), so the file-ops / git cases DECLINE there.
    ...(kind === 'app'
      ? {
          getCallback: ((name: string) => (payload: unknown) => {
            callbacks.push({ name, payload })
          }) as ClientStoreAdapter<FixtureSession>['getCallback'],
          // #5618 Batch 2 — model the app's `mapProviderList` element-tightening
          // (packages/app/src/store/message-handler.ts) so `provider_list`
          // fixtures observe the REAL app filtering: drop non-object / nameless
          // entries; copy only `name` / `capabilities` / `auth` (each kept only
          // when a non-array object). The DASHBOARD omits this hook → writes the
          // server payload verbatim. The divergence is locked by a `divergent`
          // provider_list fixture.
          mapProviderList: ((providers: unknown[]) =>
            providers
              .filter(
                (p): p is { name: string; [k: string]: unknown } =>
                  !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string',
              )
              .map((p) => {
                const entry: Record<string, unknown> = { name: p.name }
                const caps = (p as { capabilities?: unknown }).capabilities
                if (caps && typeof caps === 'object' && !Array.isArray(caps)) entry.capabilities = caps
                const auth = (p as { auth?: unknown }).auth
                if (auth && typeof auth === 'object' && !Array.isArray(auth)) entry.auth = auth
                return entry
              })) as ClientStoreAdapter<FixtureSession>['mapProviderList'],
          // #5618 Batch 2 — the app mirrors slash/agent inventory into its
          // secondary conversation store. Like `pushSessionNotification`, this is
          // a UI side-effect OUTSIDE the shared store-state contract; modelled as
          // a no-op here (no fixture asserts on it — the dispatch-table unit tests
          // cover the hook invocation directly).
          syncSecondaryInventory: () => {},
          // #5618 Batch 4 — the app mirrors the primary pointer into its
          // secondary multi-client store. Out of the shared contract (like
          // pushSessionNotification); modelled as a no-op (the shared
          // session/flat primaryClientId write IS asserted; the dispatch-table
          // unit tests cover the hook invocation). The dashboard omits it.
          setPrimaryClientId: () => {},
          // #5618 Batch 5a — cost_update's app-only flat/cost-store mirror. Out
          // of the shared contract (the shared sessionCost patch IS asserted);
          // modelled as a no-op, with the hook invocation covered by the
          // dispatch-table unit tests. The dashboard omits it.
          setCostUpdate: () => {},
        }
      : {}),
    // #5618 Batch 3 — only the DASHBOARD shows the session_stopped info toast
    // (#4878); the app OMITS `addInfoNotification` (#4879). Record it on the
    // dashboard side so a unit/contract assertion can observe the divergence;
    // the app's empty array IS the contract for that case.
    // #5618 Batch 5a — only the DASHBOARD contributes availableModelsProvider to
    // the available_models patch (the app omits the hook). Locked by a divergent
    // fixture (dashboard flat carries the extra field; app's does not).
    ...(kind === 'dashboard'
      ? {
          addInfoNotification: (message: string) => infoNotifications.push(message),
          extendModelsPatch: (msg: Record<string, unknown>) => ({
            availableModelsProvider: typeof msg.provider === 'string' ? msg.provider : null,
          }),
        }
      : {}),
  }

  return {
    adapter,
    get result(): AdapterResult {
      return { sessions, flat, added, callbacks, serverErrors, infoNotifications, switchedSessions }
    },
    setActive: (id: string | null) => {
      activeSessionId = id
    },
    setSessionList: (l: SessionInfo[]) => {
      sessionList = l
    },
  }
}

/**
 * Drive a single fixture message through the shared dispatch table for one
 * client kind. Returns the observable result + whether the table owned the
 * message (a `false` here means the type isn't a shared-table case).
 */
export function runFixtureOnClient(
  kind: ClientKind,
  init: FixtureInitialState | undefined,
  message: Record<string, unknown>,
): { result: AdapterResult; handled: boolean } {
  const env = makeClientEnv(kind, init)
  const table = createDispatchTable<FixtureSession>()
  const handled = runDispatch(table, message, env.adapter)
  return { result: env.result, handled }
}
