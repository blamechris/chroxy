/**
 * Shared behavioral-contract fixtures (epic #5556, sub-item 5).
 *
 * THE PROBLEM THIS REPLACES
 * -------------------------
 * The static handler-coverage guard (`protocol/tests/handler-coverage.test.js`)
 * asserts that a wire message TYPE has a `case` in each client's switch (or is
 * explicitly excluded). That is a *spelling* check: it proves a case EXISTS, not
 * that the two clients produce the SAME store mutation for the same input. The
 * #5556 swarm-audit found the two clients had structurally drifted under that
 * guard for months — the guard was green the whole time.
 *
 * WHAT THIS ADDS
 * --------------
 * A single source-of-truth table of `(wire message in) → (expected store
 * mutation out)` fixtures. The SAME fixture rows are driven through BOTH
 * clients' real dispatch paths:
 *
 *   - The shared store-core dispatch table (`createDispatchTable` + `runDispatch`)
 *     — exercised here in store-core via two faithful per-client adapters
 *     (`client-adapters.ts`), which reproduce each client's real `_dispatchAdapter`
 *     + `updateSession` semantics. Identical resulting state in both ⇒ pass;
 *     divergence ⇒ a test FAILS instead of hiding.
 *   - Each client's own `handleMessage` switch — exercised in the app's jest
 *     suite and the dashboard's vitest suite (`contract-switch.test.ts` in each
 *     package), which import THIS module's `SWITCH_FIXTURES` and assert the
 *     resulting `sessionStates[id].messages` match across both clients.
 *
 * DIVERGENCE IS PINNED, NOT HIDDEN
 * --------------------------------
 * A fixture whose two clients legitimately differ carries a `divergent` block
 * with each client's OWN expected output. The contract test asserts each side
 * against its declared expectation — so a documented divergence is a green test
 * that DOCUMENTS the difference, and an UNdocumented divergence (a fixture with
 * no `divergent` block where the two clients disagree) is a red test.
 *
 * This module is PURE DATA + type-only imports — no runtime dependency — so all
 * four test runners (store-core/dashboard vitest, app jest, protocol node:test)
 * can consume it from one place.
 */

import type { ChatMessage, SessionInfo } from '../types'

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

/**
 * The minimal store snapshot a fixture starts from. Only the fields a dispatch
 * handler reads are modelled; both per-client adapters seed their store from it.
 */
export interface FixtureInitialState {
  /** Active session id, or null. */
  activeSessionId?: string | null
  /**
   * Per-session seed. Each value is merged onto a base session shell
   * (`{ sessionId, messages: [] }`) so a fixture only states the fields it needs.
   */
  sessions?: Record<string, Record<string, unknown>>
  /** Session list (for `session_updated`). */
  sessionList?: SessionInfo[]
  /** This client's own id (#5618 Batch 4 — for session_role / client_focus_changed). */
  myClientId?: string | null
  /** Follow-mode flag (#5618 Batch 4 — for client_focus_changed auto-switch). */
  followMode?: boolean
  /**
   * Flat `webTasks` slice (#6268) — both clients' `web_task_error` handler maps
   * over `state.webTasks` to flip a matching task to `failed`, so a fixture that
   * exercises the `taskId` path must seed the task it targets.
   */
  webTasks?: Array<Record<string, unknown>>
}

/**
 * The expected post-dispatch mutation. A fixture asserts only the slices it
 * cares about; an absent slice means "don't care".
 */
export interface FixtureExpectation {
  /**
   * Per-session expected field subset. The assertion does a partial deep-equal
   * (`toMatchObject`) against `sessionStates[id]` for each listed id.
   */
  sessions?: Record<string, Record<string, unknown>>
  /** Expected flat (top-level connection-state) field subset. */
  flat?: Record<string, unknown>
  /** Expected messages pushed via `addMessage` (partial deep-equal, in order). */
  added?: Array<Record<string, unknown>>
  /**
   * Expected imperative-callback invocations (#5653), in order. Each entry is
   * `{ name, payload }`: the channel name and a partial deep-equal of the
   * payload. An empty array asserts NO callback fired (the dashboard side of a
   * file-ops / git case, which DECLINES). Omit the slice to "don't care".
   */
  callbacks?: Array<{ name: string; payload: Record<string, unknown> }>
  /**
   * Expected `addServerError` invocations (#5618 Batch 3), in order. Each entry
   * is a partial deep-equal of the structured error. An empty array asserts NO
   * error was surfaced. Omit the slice to "don't care".
   */
  serverErrors?: Array<{ message?: string; category?: string; sessionId?: string; recoverable?: boolean }>
  /**
   * Expected `addInfoNotification` invocations (#5618 Batch 3), in order. Only
   * the dashboard records these; the app's array is always empty. Omit to "don't
   * care".
   */
  infoNotifications?: string[]
  /**
   * Expected `switchSession` invocations (#5618 Batch 4), in order — the
   * client_focus_changed follow-mode auto-switch. Both clients call it
   * identically; an empty array asserts NO switch fired. Omit to "don't care".
   */
  switchedSessions?: string[]
  /**
   * Expected `applyRotatedTunnelUrl` invocations (#5618 Batch 5b), in order. Both
   * clients call it identically; an empty array asserts NO rotation applied. Omit
   * to "don't care".
   */
  rotatedTunnelUrls?: Array<{ url: string; previousUrl: string | null }>
  /**
   * Expected ordered `appendTerminalData` call args (#6345) — the terminal-mirror
   * writes a fixture drives (raw / raw_background / terminal_output). Both harnesses
   * capture the strings passed to the store's `appendTerminalData`; this asserts
   * them in order. Omit the slice to "don't care".
   */
  terminalWrites?: string[]
  /** When true, assert NO mutation happened at all (state is untouched). */
  noop?: boolean
}

/**
 * A single contract fixture: one wire message in, the expected store mutation
 * out, optionally split per-client when the two legitimately diverge.
 */
export interface ContractFixture {
  /** Human-readable scenario name (also the test title). */
  name: string
  /** The wire message type (its `case`/table key). */
  type: string
  /** Starting store snapshot. */
  init?: FixtureInitialState
  /**
   * Optional ordered wire messages dispatched through the SAME real handleMessage
   * BEFORE `message`, to establish context a single message can't (#6344) — e.g. a
   * `history_replay_start` that seeds the rebuild baseline `history_replay_end`
   * resolves against. The harness asserts only the post-`message` state.
   */
  prelude?: Array<Record<string, unknown>>
  /** The raw wire message handed to the dispatch path. */
  message: Record<string, unknown>
  /**
   * The expected mutation when BOTH clients agree. Mutually exclusive with
   * `divergent` (a fixture is one or the other).
   */
  expect?: FixtureExpectation
  /**
   * Per-client expected mutation when the two legitimately differ. Each side is
   * asserted against its own block, so the difference is documented and locked.
   */
  divergent?: {
    app: FixtureExpectation
    dashboard: FixtureExpectation
    /** Why the two differ — surfaced in the test title and as living docs. */
    reason: string
  }
}

// ---------------------------------------------------------------------------
// Helpers for building fixture chat messages
// ---------------------------------------------------------------------------

function sysMsg(content: string): Partial<ChatMessage> {
  return { type: 'system', content }
}

// ---------------------------------------------------------------------------
// DISPATCH-TABLE FIXTURES — all 21 shared cases (epic #5556 sub-item 3)
//
// These run through `createDispatchTable` + `runDispatch` — the EXACT path both
// clients use (each builds the table from store-core and calls `runDispatch`
// first). The two clients differ only in their adapter wiring; this table proves
// the resulting state is identical (or pins the documented divergence).
// ---------------------------------------------------------------------------

export const DISPATCH_FIXTURES: ContractFixture[] = [
  // --- slice 1 (#6449) — terminal-mirror pass-through. Moved here from
  // SWITCH_FIXTURES: raw / raw_background / terminal_output now live in the
  // shared dispatch table, so contract.test.ts drives them through runDispatch
  // (the contract adapter records one appendTerminalData write per accepted frame).
  {
    // #6345: raw PTY output. Both clients pass the shared handleRawOutput data
    // (msg.data verbatim, '' on non-string) to get().appendTerminalData —
    // unconditionally (no sessionId/active gate). The app also mirrors into the
    // mocked useTerminalStore, but only the main-store write is captured, so both
    // see exactly one identical write → a single terminalWrites expect. (Plain
    // ASCII data — the contract is "verbatim pass-through"; the byte content is
    // irrelevant and ANSI escapes only invite source-mangling.)
    name: 'raw writes the PTY chunk to the terminal mirror, unconditionally (both clients)',
    type: 'raw',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'raw', sessionId: 's1', data: 'raw-pty-chunk' },
    expect: { terminalWrites: ['raw-pty-chunk'] },
  },
  {
    // #6345: background-agent PTY output. Same as raw — unconditional verbatim
    // get().appendTerminalData write in both clients; no gate, no init needed.
    name: 'raw_background writes the decoded PTY chunk to the terminal mirror (both clients)',
    type: 'raw_background',
    message: { type: 'raw_background', data: 'background-agent-output' },
    expect: { terminalWrites: ['background-agent-output'] },
  },
  {
    // #6345: the opt-in live-PTY mirror channel (#5835). Both clients gate on
    // typeof msg.data === 'string' AND msg.sessionId === activeSessionId, then write
    // msg.data verbatim to get().appendTerminalData. Seed activeSessionId === the
    // message sessionId so the active-id guard passes.
    name: 'terminal_output writes the PTY chunk to the mirror for the active session (both clients)',
    type: 'terminal_output',
    init: { activeSessionId: 's1' },
    message: { type: 'terminal_output', sessionId: 's1', data: 'term-line file.txt' },
    expect: { terminalWrites: ['term-line file.txt'] },
  },
  // 1. available_permission_modes — flat list replace
  {
    name: 'available_permission_modes sets the flat mode list when payload parses',
    type: 'available_permission_modes',
    message: {
      type: 'available_permission_modes',
      modes: [
        { id: 'default', label: 'Default' },
        { id: 'plan', label: 'Plan', description: 'Plan mode' },
      ],
    },
    expect: {
      flat: {
        availablePermissionModes: [
          { id: 'default', label: 'Default' },
          { id: 'plan', label: 'Plan', description: 'Plan mode' },
        ],
      },
    },
  },
  {
    name: 'available_permission_modes is a no-op when modes is not an array',
    type: 'available_permission_modes',
    message: { type: 'available_permission_modes' },
    expect: { noop: true },
  },

  // 2. session_updated — rename in the session list
  {
    name: 'session_updated renames the matching session in the list',
    type: 'session_updated',
    init: {
      sessionList: [
        { sessionId: 's1', name: 'Old' } as SessionInfo,
        { sessionId: 's2', name: 'Keep' } as SessionInfo,
      ],
    },
    message: { type: 'session_updated', sessionId: 's1', name: 'New' },
    expect: {
      flat: {
        sessions: [
          { sessionId: 's1', name: 'New' },
          { sessionId: 's2', name: 'Keep' },
        ],
      },
    },
  },

  // 3. agent_busy — flip target session to non-idle
  {
    name: 'agent_busy flips the explicit target session to non-idle',
    type: 'agent_busy',
    init: { sessions: { s1: { isIdle: true } } },
    message: { type: 'agent_busy', sessionId: 's1' },
    expect: { sessions: { s1: { isIdle: false } } },
  },
  {
    name: 'agent_busy falls back to the active session when sessionId is absent',
    type: 'agent_busy',
    init: { activeSessionId: 'active', sessions: { active: { isIdle: true } } },
    message: { type: 'agent_busy' },
    expect: { sessions: { active: { isIdle: false } } },
  },

  // 3b. model_changed (#5618) — set the target session's activeModel. Reconciled
  // from the two clients' divergent edge fallbacks: a known target updates that
  // session (incl. the active session, whose flat mirror the dashboard adapter
  // keeps in sync); a stray unknown-session model_changed is a clean no-op.
  {
    name: 'model_changed sets activeModel on the explicit target session',
    type: 'model_changed',
    init: { sessions: { s1: { activeModel: 'claude-sonnet-4-6' } } },
    message: { type: 'model_changed', sessionId: 's1', model: 'claude-opus-4-8' },
    expect: { sessions: { s1: { activeModel: 'claude-opus-4-8' } } },
  },
  {
    name: 'model_changed falls back to the active session when sessionId is absent',
    type: 'model_changed',
    init: { activeSessionId: 'active', sessions: { active: { activeModel: 'claude-sonnet-4-6' } } },
    message: { type: 'model_changed', model: 'claude-opus-4-8' },
    expect: { sessions: { active: { activeModel: 'claude-opus-4-8' } } },
  },
  {
    name: 'model_changed for an unknown session is a no-op (reconciled edge)',
    type: 'model_changed',
    init: { activeSessionId: 'active', sessions: { active: { activeModel: 'keep' } } },
    message: { type: 'model_changed', sessionId: 'ghost', model: 'ignored' },
    expect: { noop: true },
  },

  // 4. budget_resumed — append system message (target session OR flat addMessage)
  {
    name: 'budget_resumed appends the system message to the target session',
    type: 'budget_resumed',
    init: { sessions: { s1: {} } },
    message: { type: 'budget_resumed', sessionId: 's1' },
    expect: {
      sessions: {
        s1: { messages: [sysMsg('Cost budget override — session resumed')] },
      },
    },
  },
  {
    name: 'budget_resumed falls back to addMessage when there is no target session',
    type: 'budget_resumed',
    message: { type: 'budget_resumed' },
    expect: { added: [sysMsg('Cost budget override — session resumed')] },
  },

  // 4c. user_question (#5618) — append the question prompt to its (resolved)
  // session, else the global log. The `pushSessionNotification` side-effect is a
  // UI concern OUTSIDE this store-state contract (no-op in the harness adapter),
  // so only the message append is asserted — byte-identical on both clients.
  {
    name: 'user_question appends the question prompt to the target session',
    type: 'user_question',
    init: { sessions: { s1: {} } },
    message: { type: 'user_question', sessionId: 's1', questions: [{ question: 'Proceed?' }] },
    expect: {
      sessions: { s1: { messages: [{ type: 'prompt', content: 'Proceed?' }] } },
    },
  },
  {
    name: 'user_question falls back to addMessage when no session resolves',
    type: 'user_question',
    message: { type: 'user_question', questions: [{ question: 'Proceed?' }] },
    expect: { added: [{ type: 'prompt', content: 'Proceed?' }] },
  },
  {
    name: 'user_question is a no-op when the questions payload is malformed',
    type: 'user_question',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'user_question', questions: [] },
    expect: { noop: true },
  },

  // 4d. multi_question_intervention (#5618) — append a dedup'd, ring-capped
  // SessionIntervention to the target session, and on the FIRST one push a
  // one-time system ChatMessage. Builder dedups by toolUseId (a stuck-model
  // re-emit is a no-op) — byte-identical on both clients.
  {
    name: 'multi_question_intervention appends the intervention + first-time system notice',
    type: 'multi_question_intervention',
    init: { sessions: { s1: {} } },
    message: { type: 'multi_question_intervention', sessionId: 's1', toolUseId: 'tu1', questionCount: 3 },
    expect: {
      sessions: {
        s1: {
          interventions: [{ kind: 'multi_question', toolUseId: 'tu1', count: 3 }],
          messages: [
            sysMsg('chroxy intercepted a multi-question form and asked the agent to break it into single questions.'),
          ],
        },
      },
    },
  },
  {
    name: 'multi_question_intervention dedups a repeat toolUseId (no-op, no re-render)',
    type: 'multi_question_intervention',
    init: { sessions: { s1: { interventions: [{ kind: 'multi_question', toolUseId: 'tu1', count: 3, timestamp: 1 }] } } },
    message: { type: 'multi_question_intervention', sessionId: 's1', toolUseId: 'tu1', questionCount: 3 },
    expect: { noop: true },
  },
  {
    name: 'multi_question_intervention is a no-op on a malformed payload (questionCount < 2)',
    type: 'multi_question_intervention',
    init: { sessions: { s1: {} } },
    message: { type: 'multi_question_intervention', sessionId: 's1', toolUseId: 'tu1', questionCount: 1 },
    expect: { noop: true },
  },

  // 4e. slash_commands / agent_list / provider_list (#5618 Batch 2) — flat
  // list-replacement. slash_commands / agent_list carry the broadcast-guard
  // sessionId (skip when it targets a non-active session). The app additionally
  // mirrors slash/agent lists into its secondary conversation store (out of the
  // shared contract — a no-op here) and tightens provider elements via
  // mapProviderList (LOCKED by the divergent provider fixture below).
  {
    name: 'slash_commands replaces the flat slash-command list (server-wide)',
    type: 'slash_commands',
    message: { type: 'slash_commands', commands: [{ name: '/compact' }, { name: '/clear' }] },
    expect: { flat: { slashCommands: [{ name: '/compact' }, { name: '/clear' }] } },
  },
  {
    name: 'slash_commands is dropped when it targets a non-active session',
    type: 'slash_commands',
    init: { activeSessionId: 'active' },
    message: { type: 'slash_commands', sessionId: 'other', commands: [{ name: '/x' }] },
    expect: { noop: true },
  },
  {
    name: 'slash_commands is a no-op when commands is not an array',
    type: 'slash_commands',
    message: { type: 'slash_commands' },
    expect: { noop: true },
  },
  {
    name: 'agent_list replaces the flat custom-agent list (server-wide)',
    type: 'agent_list',
    message: { type: 'agent_list', agents: [{ name: 'reviewer' }, { name: 'planner' }] },
    expect: { flat: { customAgents: [{ name: 'reviewer' }, { name: 'planner' }] } },
  },
  {
    name: 'agent_list is dropped when it targets a non-active session',
    type: 'agent_list',
    init: { activeSessionId: 'active' },
    message: { type: 'agent_list', sessionId: 'other', agents: [{ name: 'x' }] },
    expect: { noop: true },
  },
  {
    name: 'agent_list is a no-op when agents is not an array',
    type: 'agent_list',
    message: { type: 'agent_list' },
    expect: { noop: true },
  },
  {
    name: 'provider_list replaces the flat provider list (well-formed: identical in both)',
    type: 'provider_list',
    message: {
      type: 'provider_list',
      providers: [
        { name: 'claude', capabilities: { streaming: true }, auth: { type: 'oauth' } },
        { name: 'gemini', capabilities: { streaming: false } },
      ],
    },
    expect: {
      flat: {
        availableProviders: [
          { name: 'claude', capabilities: { streaming: true }, auth: { type: 'oauth' } },
          { name: 'gemini', capabilities: { streaming: false } },
        ],
      },
    },
  },
  {
    name: 'provider_list element handling (app mapProviderList tightens; dashboard writes verbatim)',
    type: 'provider_list',
    message: {
      type: 'provider_list',
      providers: [
        { name: 'claude', capabilities: { streaming: true }, extra: 'drop-me' },
        { noName: true },
      ],
    },
    divergent: {
      app: {
        // mapProviderList drops the nameless entry and the non-allow-listed
        // `extra` field, keeping only name + (object) capabilities.
        flat: { availableProviders: [{ name: 'claude', capabilities: { streaming: true } }] },
      },
      dashboard: {
        // verbatim passthrough — both elements kept, `extra` field retained.
        flat: {
          availableProviders: [
            { name: 'claude', capabilities: { streaming: true }, extra: 'drop-me' },
            { noName: true },
          ],
        },
      },
      reason:
        'app mapProviderList drops nameless entries + strips non-name/capabilities/auth fields; dashboard writes the payload verbatim',
    },
  },
  {
    name: 'provider_list is a no-op when providers is not an array',
    type: 'provider_list',
    message: { type: 'provider_list' },
    expect: { noop: true },
  },

  // 4f. error-sink / session-status cases (#5618 Batch 3). restore/persist
  // surface a recoverable error via the shared `addServerError` hook — both
  // clients receive the SAME structured error (each renders it differently below
  // the hook). session_stopped sets a shared session patch + a dashboard-only
  // info toast (the app shows none).
  {
    name: 'session_restore_failed surfaces a recoverable session error in both clients',
    type: 'session_restore_failed',
    message: {
      type: 'session_restore_failed',
      sessionId: 's1',
      name: 'My Session',
      errorMessage: 'missing API key',
    },
    expect: {
      serverErrors: [
        { message: 'Failed to restore My Session: missing API key', category: 'session', sessionId: 's1', recoverable: true },
      ],
    },
  },
  {
    name: 'session_persist_failed surfaces a recoverable "not saved" error in both clients',
    type: 'session_persist_failed',
    message: { type: 'session_persist_failed', sessionId: 's1', name: 'My Session' },
    expect: {
      serverErrors: [
        {
          message: 'Couldn\'t save "My Session" — the change may be lost on restart. Check the daemon\'s disk space and write permissions.',
          category: 'session',
          sessionId: 's1',
          recoverable: true,
        },
      ],
    },
  },
  {
    name: 'session_stopped sets stoppedCode on the target session (shared patch; toast is dashboard-only)',
    type: 'session_stopped',
    init: { sessions: { s1: {} } },
    message: { type: 'session_stopped', sessionId: 's1', code: 143 },
    // stoppedAt is Date.now() (differs per client run) so it is not asserted;
    // stoppedCode is deterministic. The dashboard's info toast is out of the
    // shared contract (covered by dispatch-table.test.ts units), so this asserts
    // only the shared session patch — identical in both clients.
    expect: { sessions: { s1: { stoppedCode: 143 } } },
  },
  {
    name: 'session_stopped with a clean exit (code 0) sets stoppedCode 0',
    type: 'session_stopped',
    init: { sessions: { s1: {} } },
    message: { type: 'session_stopped', sessionId: 's1', code: 0 },
    expect: { sessions: { s1: { stoppedCode: 0 } } },
  },

  // 4g. multi-client cases (#5618 Batch 4). The clients diverged only in where
  // presence state lives (app multi-client store vs dashboard flat) — hidden
  // behind the getMyClientId / getFollowMode / switchSession accessors — so the
  // mutations are identical. The app's extra setPrimaryClientId mirror is
  // out-of-contract (covered by dispatch-table.test.ts units).
  {
    name: 'primary_changed sets primaryClientId on the explicit target session',
    type: 'primary_changed',
    init: { sessions: { s1: {} } },
    message: { type: 'primary_changed', sessionId: 's1', clientId: 'c1' },
    expect: { sessions: { s1: { primaryClientId: 'c1' } } },
  },
  {
    name: 'primary_changed writes flat primaryClientId for the server-wide default',
    type: 'primary_changed',
    message: { type: 'primary_changed', clientId: 'c1' },
    expect: { flat: { primaryClientId: 'c1' } },
  },
  {
    name: 'session_role derives primary when the server names this client',
    type: 'session_role',
    init: { myClientId: 'c1', sessions: { s1: {} } },
    message: { type: 'session_role', sessionId: 's1', primaryClientId: 'c1' },
    expect: { sessions: { s1: { sessionRole: 'primary', primaryClientId: 'c1' } } },
  },
  {
    name: 'session_role derives observer when another client is primary',
    type: 'session_role',
    init: { myClientId: 'c1', sessions: { s1: {} } },
    message: { type: 'session_role', sessionId: 's1', primaryClientId: 'c2' },
    expect: { sessions: { s1: { sessionRole: 'observer', primaryClientId: 'c2' } } },
  },
  {
    name: 'client_focus_changed auto-switches when follow mode is on (another client, local target)',
    type: 'client_focus_changed',
    init: { myClientId: 'me', followMode: true, activeSessionId: 'cur', sessions: { cur: {}, other: {} } },
    message: { type: 'client_focus_changed', clientId: 'them', sessionId: 'other' },
    expect: { switchedSessions: ['other'] },
  },
  {
    name: 'client_focus_changed does NOT switch when follow mode is off',
    type: 'client_focus_changed',
    init: { myClientId: 'me', followMode: false, activeSessionId: 'cur', sessions: { cur: {}, other: {} } },
    message: { type: 'client_focus_changed', clientId: 'them', sessionId: 'other' },
    expect: { noop: true },
  },
  {
    name: 'client_focus_changed ignores self-focus events even with follow mode on',
    type: 'client_focus_changed',
    init: { myClientId: 'me', followMode: true, activeSessionId: 'cur', sessions: { cur: {}, other: {} } },
    message: { type: 'client_focus_changed', clientId: 'me', sessionId: 'other' },
    expect: { noop: true },
  },

  // 4h. models / cost cases (#5618 Batch 5a). available_models shares the flat
  // {availableModels, defaultModelId} write; the dashboard adds
  // availableModelsProvider via extendModelsPatch (divergent). cost_update shares
  // the per-session sessionCost patch; the app's flat/cost-store mirror is
  // out-of-contract (covered by dispatch-table.test.ts units).
  {
    name: 'available_models replaces the flat list (app vs dashboard provider divergence)',
    type: 'available_models',
    message: {
      type: 'available_models',
      models: [{ id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8' }],
      defaultModel: 'opus',
      provider: 'claude-tui',
    },
    divergent: {
      app: {
        flat: {
          availableModels: [{ id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8' }],
          defaultModelId: 'opus',
        },
      },
      dashboard: {
        flat: {
          availableModels: [{ id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8' }],
          defaultModelId: 'opus',
          availableModelsProvider: 'claude-tui',
        },
      },
      reason: 'dashboard tracks availableModelsProvider via extendModelsPatch; the app omits it',
    },
  },
  {
    name: 'available_models is a no-op for a non-array payload (preserves the existing list)',
    type: 'available_models',
    message: { type: 'available_models' },
    expect: { noop: true },
  },
  {
    name: 'cost_update applies the per-session sessionCost patch (explicit target)',
    type: 'cost_update',
    init: { sessions: { s1: {} } },
    message: { type: 'cost_update', sessionId: 's1', sessionCost: 1.23 },
    expect: { sessions: { s1: { sessionCost: 1.23 } } },
  },
  {
    name: 'cost_update falls back to the active session when sessionId is omitted',
    type: 'cost_update',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'cost_update', sessionCost: 0.5 },
    expect: { sessions: { s1: { sessionCost: 0.5 } } },
  },

  // 4i. connect-time burst / tunnel cases (#5618 Batch 5b). tunnel_url_changed's
  // only effect is the platform-local apply via applyRotatedTunnelUrl (both
  // clients call it identically). auth_bootstrap writes the shared flat lists
  // (providers verbatim for well-formed input; the app's mapProviderList +
  // syncSecondaryInventory extras are out-of-contract) + applies the tunnel URL.
  {
    name: 'tunnel_url_changed applies the rotated URL in both clients',
    type: 'tunnel_url_changed',
    message: { type: 'tunnel_url_changed', url: 'wss://new.example', previousUrl: 'wss://old.example' },
    expect: { rotatedTunnelUrls: [{ url: 'wss://new.example', previousUrl: 'wss://old.example' }] },
  },
  {
    name: 'tunnel_url_changed is a no-op when the url is missing/malformed',
    type: 'tunnel_url_changed',
    message: { type: 'tunnel_url_changed', url: 'http://not-wss' },
    expect: { noop: true },
  },
  {
    name: 'auth_bootstrap applies providers + slash/agent lists + the tunnel URL',
    type: 'auth_bootstrap',
    message: {
      type: 'auth_bootstrap',
      providers: [{ name: 'claude' }],
      slashCommands: [{ name: '/compact' }],
      agents: [{ name: 'reviewer' }],
      tunnelUrl: 'wss://boot.example',
    },
    expect: {
      flat: {
        availableProviders: [{ name: 'claude' }],
        slashCommands: [{ name: '/compact' }],
        customAgents: [{ name: 'reviewer' }],
      },
      rotatedTunnelUrls: [{ url: 'wss://boot.example', previousUrl: null }],
    },
  },
  {
    name: 'auth_bootstrap applies providers but skips slash/agents for a stale session burst',
    type: 'auth_bootstrap',
    init: { activeSessionId: 'active' },
    message: {
      type: 'auth_bootstrap',
      sessionId: 'stale',
      providers: [{ name: 'claude' }],
      slashCommands: [{ name: '/compact' }],
      agents: [{ name: 'reviewer' }],
    },
    // Providers are server-wide (applied); the session-scoped slash/agent lists
    // are skipped because the burst's sessionId no longer matches the active one.
    expect: { flat: { availableProviders: [{ name: 'claude' }] } },
  },

  // 4b. budget_resume_ack (#5752) — quiet "nothing to resume" note when the
  // session was not paused; no-op when it was (budget_resumed already noted it)
  {
    name: 'budget_resume_ack appends the "nothing to resume" note when not paused',
    type: 'budget_resume_ack',
    init: { sessions: { s1: {} } },
    message: { type: 'budget_resume_ack', sessionId: 's1', wasPaused: false },
    expect: {
      sessions: {
        s1: { messages: [sysMsg('Budget was not paused — nothing to resume')] },
      },
    },
  },
  {
    name: 'budget_resume_ack falls back to addMessage for the not-paused note',
    type: 'budget_resume_ack',
    message: { type: 'budget_resume_ack', wasPaused: false },
    expect: { added: [sysMsg('Budget was not paused — nothing to resume')] },
  },
  {
    name: 'budget_resume_ack is a no-op when the session was actually paused',
    type: 'budget_resume_ack',
    init: { sessions: { s1: {} } },
    message: { type: 'budget_resume_ack', sessionId: 's1', wasPaused: true },
    expect: { noop: true },
  },

  // 5. conversation_id — stamp onto explicit session (NO active fallback)
  {
    name: 'conversation_id stamps the conversation id onto the explicit session',
    type: 'conversation_id',
    init: { sessions: { s1: {} } },
    message: { type: 'conversation_id', sessionId: 's1', conversationId: 'conv-9' },
    expect: { sessions: { s1: { conversationId: 'conv-9' } } },
  },
  {
    name: 'conversation_id does NOT fall back to active session when sessionId is missing',
    type: 'conversation_id',
    init: { activeSessionId: 'active', sessions: { active: {} } },
    message: { type: 'conversation_id', conversationId: 'conv-9' },
    expect: { sessions: { active: { conversationId: undefined } } },
  },

  // 6. permission_rules_updated — replace session rules (active fallback)
  {
    name: 'permission_rules_updated replaces the explicit session rule set',
    type: 'permission_rules_updated',
    init: { sessions: { s1: { sessionRules: [] } } },
    message: {
      type: 'permission_rules_updated',
      sessionId: 's1',
      rules: [{ tool: 'Bash', action: 'allow' }],
    },
    expect: { sessions: { s1: { sessionRules: [{ tool: 'Bash', action: 'allow' }] } } },
  },
  {
    name: 'permission_rules_updated falls back to active session when sessionId absent',
    type: 'permission_rules_updated',
    init: { activeSessionId: 'active', sessions: { active: { sessionRules: [] } } },
    message: { type: 'permission_rules_updated', rules: [{ tool: 'Edit', action: 'deny' }] },
    expect: { sessions: { active: { sessionRules: [{ tool: 'Edit', action: 'deny' }] } } },
  },

  // 7. confirm_permission_mode — flat pending confirmation
  {
    name: 'confirm_permission_mode stores the pending confirmation with mode + warning',
    type: 'confirm_permission_mode',
    message: { type: 'confirm_permission_mode', mode: 'bypassPermissions', warning: 'Dangerous' },
    expect: {
      flat: { pendingPermissionConfirm: { mode: 'bypassPermissions', warning: 'Dangerous' } },
    },
  },
  {
    name: 'confirm_permission_mode defaults the warning when omitted',
    type: 'confirm_permission_mode',
    message: { type: 'confirm_permission_mode', mode: 'plan' },
    expect: { flat: { pendingPermissionConfirm: { mode: 'plan', warning: 'Are you sure?' } } },
  },

  // 8. agent_spawned — add active-agent entry
  {
    name: 'agent_spawned adds the spawned agent entry to its session',
    type: 'agent_spawned',
    init: { sessions: { s1: { activeAgents: [] } } },
    message: {
      type: 'agent_spawned',
      sessionId: 's1',
      toolUseId: 'tu-1',
      description: 'Search the repo',
      startedAt: 1000,
    },
    expect: {
      sessions: {
        s1: { activeAgents: [{ toolUseId: 'tu-1', description: 'Search the repo', startedAt: 1000 }] },
      },
    },
  },

  // 9. agent_completed — remove active-agent entry
  {
    name: 'agent_completed removes the completed agent entry',
    type: 'agent_completed',
    init: {
      sessions: {
        s1: {
          activeAgents: [
            { toolUseId: 'tu-1', description: 'a', startedAt: 1 },
            { toolUseId: 'tu-2', description: 'b', startedAt: 2 },
          ],
        },
      },
    },
    message: { type: 'agent_completed', sessionId: 's1', toolUseId: 'tu-1' },
    expect: {
      sessions: { s1: { activeAgents: [{ toolUseId: 'tu-2', description: 'b', startedAt: 2 }] } },
    },
  },

  // 10. agent_event — append child event to parent Task bubble
  {
    name: 'agent_event appends a child event to the parent Task tool_use bubble',
    type: 'agent_event',
    init: {
      sessions: {
        s1: { messages: [{ type: 'tool_use', toolUseId: 'parent-1' } as unknown as ChatMessage] },
      },
    },
    message: {
      type: 'agent_event',
      sessionId: 's1',
      parentToolUseId: 'parent-1',
      eventType: 'tool_start',
      payload: { name: 'Read' },
    },
    expect: {
      sessions: {
        s1: {
          messages: [
            {
              type: 'tool_use',
              toolUseId: 'parent-1',
              childAgentEvents: [{ type: 'tool_start', payload: { name: 'Read' } }],
            },
          ],
        },
      },
    },
  },

  // 11. background_work_changed — replace pending shells snapshot
  {
    name: 'background_work_changed replaces the pending-background-shells snapshot',
    type: 'background_work_changed',
    init: { sessions: { s1: { pendingBackgroundShells: [] } } },
    message: {
      type: 'background_work_changed',
      sessionId: 's1',
      pending: [{ shellId: 'sh-1', command: 'npm test', startedAt: 1000 }],
    },
    expect: {
      sessions: {
        s1: { pendingBackgroundShells: [{ shellId: 'sh-1', command: 'npm test', startedAt: 1000 }] },
      },
    },
  },

  // 12. plan_started — clear pending-plan state
  {
    name: 'plan_started clears pending-plan state on the target session',
    type: 'plan_started',
    init: { sessions: { s1: { isPlanPending: true, planAllowedPrompts: ['x'] } } },
    message: { type: 'plan_started', sessionId: 's1' },
    expect: { sessions: { s1: { isPlanPending: false, planAllowedPrompts: [] } } },
  },

  // 13. inactivity_warning — stamp soft check-in prompt
  {
    name: 'inactivity_warning stamps the soft check-in prompt onto its session',
    type: 'inactivity_warning',
    init: { sessions: { s1: {} } },
    message: { type: 'inactivity_warning', sessionId: 's1', idleMs: 60000, prefab: 'Still there?' },
    expect: { sessions: { s1: { inactivityWarning: { idleMs: 60000, prefab: 'Still there?' } } } },
  },
  {
    name: 'inactivity_warning is a no-op on an invalid payload (idleMs 0)',
    type: 'inactivity_warning',
    init: { sessions: { s1: {} } },
    message: { type: 'inactivity_warning', sessionId: 's1', idleMs: 0, prefab: 'x' },
    expect: { sessions: { s1: { inactivityWarning: undefined } } },
  },

  // 14. mcp_servers — replace MCP-server list (active fallback)
  {
    name: 'mcp_servers replaces the target session MCP-server list',
    type: 'mcp_servers',
    init: { sessions: { s1: { mcpServers: [] } } },
    message: { type: 'mcp_servers', sessionId: 's1', servers: [{ name: 'fs', status: 'connected' }] },
    expect: { sessions: { s1: { mcpServers: [{ name: 'fs', status: 'connected' }] } } },
  },

  // 15. session_usage — store cumulative usage
  {
    name: 'session_usage stores the session cumulative usage',
    type: 'session_usage',
    init: { sessions: { s1: {} } },
    message: {
      type: 'session_usage',
      sessionId: 's1',
      cumulativeUsage: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 },
    },
    expect: {
      sessions: { s1: { cumulativeUsage: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 } } },
    },
  },

  // 15b. session_context — merge the per-session git/project context (#5618)
  {
    name: 'session_context merges the git/project context into the target session',
    type: 'session_context',
    init: { sessions: { s1: {} } },
    message: {
      type: 'session_context',
      sessionId: 's1',
      gitBranch: 'main',
      gitDirty: 3,
      gitAhead: 1,
      projectName: 'chroxy',
    },
    expect: {
      sessions: {
        s1: { sessionContext: { gitBranch: 'main', gitDirty: 3, gitAhead: 1, projectName: 'chroxy' } },
      },
    },
  },
  {
    name: 'session_context coerces missing/typed fields to null/0 defaults',
    type: 'session_context',
    init: { sessions: { s1: {} } },
    message: { type: 'session_context', sessionId: 's1' },
    expect: {
      sessions: {
        s1: { sessionContext: { gitBranch: null, gitDirty: 0, gitAhead: 0, projectName: null } },
      },
    },
  },

  // 16. session_cost_threshold_crossed — one-shot cost banner (no active fallback)
  {
    name: 'session_cost_threshold_crossed stores the one-shot cost-warning banner',
    type: 'session_cost_threshold_crossed',
    init: { sessions: { s1: {} } },
    message: { type: 'session_cost_threshold_crossed', sessionId: 's1', costUsd: 5, thresholdUsd: 4 },
    expect: {
      sessions: { s1: { costThresholdWarning: { costUsd: 5, thresholdUsd: 4, dismissedAt: null } } },
    },
  },
  {
    name: 'session_cost_threshold_crossed does NOT fall back to the active session',
    type: 'session_cost_threshold_crossed',
    init: { activeSessionId: 'active', sessions: { active: {} } },
    message: { type: 'session_cost_threshold_crossed', costUsd: 5, thresholdUsd: 4 },
    expect: { sessions: { active: { costThresholdWarning: undefined } } },
  },

  // 17. dev_preview — add deduped-by-port
  {
    name: 'dev_preview adds a dev-preview entry deduped by port',
    type: 'dev_preview',
    init: { sessions: { s1: { devPreviews: [] } } },
    message: { type: 'dev_preview', sessionId: 's1', port: 3000, url: 'http://localhost:3000' },
    expect: { sessions: { s1: { devPreviews: [{ port: 3000, url: 'http://localhost:3000' }] } } },
  },

  // 18. dev_preview_stopped — remove by port
  {
    name: 'dev_preview_stopped removes the dev-preview entry matching the stopped port',
    type: 'dev_preview_stopped',
    init: {
      sessions: { s1: { devPreviews: [{ port: 3000, url: 'http://localhost:3000' }] } },
    },
    message: { type: 'dev_preview_stopped', sessionId: 's1', port: 3000 },
    expect: { sessions: { s1: { devPreviews: [] } } },
  },

  // 19. web_feature_status — flat availability flags (boolean coercion)
  {
    name: 'web_feature_status replaces the flat webFeatures availability flags (booleans coerced)',
    type: 'web_feature_status',
    message: { type: 'web_feature_status', available: 1, remote: true, teleport: 0 },
    expect: { flat: { webFeatures: { available: true, remote: true, teleport: false } } },
  },

  // 20. web_task_list — flat task list
  {
    name: 'web_task_list replaces the flat web-task list',
    type: 'web_task_list',
    message: { type: 'web_task_list', tasks: [{ taskId: 't1', status: 'running' }] },
    expect: { flat: { webTasks: [{ taskId: 't1', status: 'running' }] } },
  },
  {
    name: 'web_task_list defaults to an empty list when tasks is not an array',
    type: 'web_task_list',
    message: { type: 'web_task_list' },
    expect: { flat: { webTasks: [] } },
  },

  // 21. notification_prefs — validated flat snapshot (slice-2 reconcile)
  {
    name: 'notification_prefs stores the validated prefs snapshot incl. bypassCategories',
    type: 'notification_prefs',
    message: {
      type: 'notification_prefs',
      prefs: {
        categories: { permission: true, activity_error: false },
        devices: {},
        quietHours: null,
        bypassCategories: ['permission'],
      },
    },
    expect: {
      flat: {
        notificationPrefs: {
          categories: { permission: true, activity_error: false },
          devices: {},
          bypassCategories: ['permission'],
        },
      },
    },
  },
  {
    name: 'notification_prefs leaves state untouched on an invalid payload',
    type: 'notification_prefs',
    message: { type: 'notification_prefs', prefs: 'not-an-object' },
    expect: { noop: true },
  },

  // -------------------------------------------------------------------------
  // Slice 3 — file-ops / git wrapper cases (#5653).
  //
  // These do NOT mutate the store: their only effect is invoking a one-shot
  // imperative callback with the parsed payload. They DIVERGE by design — the
  // app routes through `adapter.getCallback` (so the callback fires through the
  // shared table), while the dashboard does NOT plug its callbacks into the
  // table and so DECLINES, handling these in its own switch. Each fixture
  // documents that split: app fires the callback (store surface is a no-op);
  // dashboard's shared-table surface is a no-op with NO callback.
  // -------------------------------------------------------------------------
  {
    name: 'directory_listing → app fires directoryListing callback; dashboard declines',
    type: 'directory_listing',
    message: {
      type: 'directory_listing',
      path: '/root',
      parentPath: '/',
      entries: [{ name: 'a.ts' }],
      error: null,
    },
    divergent: {
      reason:
        'app opts its imperative-callback registry into the shared table; dashboard reads _directoryListingCallback in its own switch (#5653)',
      app: {
        noop: true,
        callbacks: [
          {
            name: 'directoryListing',
            payload: { path: '/root', parentPath: '/', entries: [{ name: 'a.ts' }], error: null },
          },
        ],
      },
      dashboard: { noop: true, callbacks: [] },
    },
  },
  {
    name: 'file_listing → app fires fileBrowser callback; dashboard declines',
    type: 'file_listing',
    message: { type: 'file_listing', path: '/p', entries: [], error: 'oops' },
    divergent: {
      reason: 'app routes file_listing through the shared table; dashboard handles it locally (#5653)',
      app: {
        noop: true,
        callbacks: [{ name: 'fileBrowser', payload: { path: '/p', parentPath: null, entries: [], error: 'oops' } }],
      },
      dashboard: { noop: true, callbacks: [] },
    },
  },
  {
    name: 'file_content → app fires fileContent callback; dashboard declines',
    type: 'file_content',
    message: {
      type: 'file_content',
      path: '/f.ts',
      content: 'x',
      language: 'typescript',
      size: 1,
      truncated: true,
    },
    divergent: {
      reason: 'app routes file_content through the shared table; dashboard handles it locally (#5653)',
      app: {
        noop: true,
        callbacks: [
          {
            name: 'fileContent',
            payload: { path: '/f.ts', content: 'x', language: 'typescript', size: 1, truncated: true, error: null, requestId: null },
          },
        ],
      },
      dashboard: { noop: true, callbacks: [] },
    },
  },
  {
    name: 'write_file_result → app fires fileWrite callback; dashboard declines (app-only type)',
    type: 'write_file_result',
    message: { type: 'write_file_result', path: '/f.ts' },
    divergent: {
      reason: 'app-only type; dashboard has no write_file_result handler and DECLINES via the shared table (#5653)',
      app: { noop: true, callbacks: [{ name: 'fileWrite', payload: { path: '/f.ts', error: null } }] },
      dashboard: { noop: true, callbacks: [] },
    },
  },
  {
    name: 'diff_result → app fires diff callback with files + error; dashboard declines',
    type: 'diff_result',
    message: { type: 'diff_result', files: [], error: null },
    divergent: {
      reason: 'app routes diff_result through the shared table; dashboard handles it locally (#5653)',
      app: { noop: true, callbacks: [{ name: 'diff', payload: { files: [], error: null } }] },
      dashboard: { noop: true, callbacks: [] },
    },
  },
  {
    name: 'git_status_result → app fires gitStatus callback (5-field payload); dashboard declines',
    type: 'git_status_result',
    message: {
      type: 'git_status_result',
      branch: 'main',
      staged: [{ path: 'a.ts', status: 'modified' }],
      unstaged: [{ path: 'b.ts', status: 'added' }],
      untracked: ['c.ts'],
      error: null,
    },
    divergent: {
      reason: 'app routes git_status_result through the shared table; dashboard handles it locally (#5653)',
      app: {
        noop: true,
        callbacks: [
          {
            name: 'gitStatus',
            payload: {
              branch: 'main',
              staged: [{ path: 'a.ts', status: 'modified' }],
              unstaged: [{ path: 'b.ts', status: 'added' }],
              untracked: ['c.ts'],
              error: null,
            },
          },
        ],
      },
      dashboard: { noop: true, callbacks: [] },
    },
  },
  {
    name: 'git_branches_result → app fires gitBranches callback; dashboard declines (app-only type)',
    type: 'git_branches_result',
    message: {
      type: 'git_branches_result',
      branches: [{ name: 'main', isCurrent: true, isRemote: false }],
      currentBranch: 'main',
    },
    divergent: {
      reason: 'app-only type; dashboard has no git_branches_result handler and DECLINES via the shared table (#5653)',
      app: {
        noop: true,
        callbacks: [
          {
            name: 'gitBranches',
            payload: {
              branches: [{ name: 'main', isCurrent: true, isRemote: false }],
              currentBranch: 'main',
              error: null,
            },
          },
        ],
      },
      dashboard: { noop: true, callbacks: [] },
    },
  },
  {
    name: 'git_stage_result → app fires gitStage callback; dashboard declines (app-only type)',
    type: 'git_stage_result',
    message: { type: 'git_stage_result' },
    divergent: {
      reason: 'app-only type; dashboard has no git_stage_result handler and DECLINES via the shared table (#5653)',
      app: { noop: true, callbacks: [{ name: 'gitStage', payload: { error: null } }] },
      dashboard: { noop: true, callbacks: [] },
    },
  },
  {
    name: 'git_unstage_result → app routes to the SAME gitStage callback; dashboard declines (app-only type)',
    type: 'git_unstage_result',
    message: { type: 'git_unstage_result', error: 'nope' },
    divergent: {
      reason: 'app-only type sharing the gitStage channel; dashboard DECLINES via the shared table (#5653)',
      app: { noop: true, callbacks: [{ name: 'gitStage', payload: { error: 'nope' } }] },
      dashboard: { noop: true, callbacks: [] },
    },
  },
  {
    name: 'git_commit_result → app fires gitCommit callback; dashboard declines (app-only type)',
    type: 'git_commit_result',
    message: { type: 'git_commit_result', hash: 'abc', message: 'feat: x' },
    divergent: {
      reason: 'app-only type; dashboard has no git_commit_result handler and DECLINES via the shared table (#5653)',
      app: {
        noop: true,
        callbacks: [{ name: 'gitCommit', payload: { hash: 'abc', message: 'feat: x', error: null } }],
      },
      dashboard: { noop: true, callbacks: [] },
    },
  },

  // -------------------------------------------------------------------------
  // Slice 4 (epic #5556) — web-task upsert. BYTE-IDENTICAL on both clients:
  // validate the task, then filter-and-append into the flat `webTasks` list
  // via the shared table's `adapter.updateState`. Both clients are a table HIT
  // (NOT a decline) — so these use a single `expect`, not a `divergent` block.
  // The dedup-against-existing-task path needs a pre-seeded flat list, which the
  // fixture init does not model; it is covered in dispatch-table.test.ts.
  // -------------------------------------------------------------------------
  {
    name: 'web_task_created appends the task to the (empty) flat webTasks list',
    type: 'web_task_created',
    message: { type: 'web_task_created', task: { taskId: 't1', status: 'running' } },
    expect: { flat: { webTasks: [{ taskId: 't1', status: 'running' }] } },
  },
  {
    name: 'web_task_updated appends the task to the (empty) flat webTasks list',
    type: 'web_task_updated',
    message: { type: 'web_task_updated', task: { taskId: 't1', status: 'completed' } },
    expect: { flat: { webTasks: [{ taskId: 't1', status: 'completed' }] } },
  },
  {
    name: 'web_task_created is a no-op when the task payload is malformed (no taskId)',
    type: 'web_task_created',
    message: { type: 'web_task_created', task: { status: 'running' } },
    expect: { noop: true },
  },

  // 13. message_queued / message_dequeued — outgoing-message queue mirror (#5937)
  {
    name: 'message_queued flips the optimistic pending entry to confirmed (dedup by clientMessageId)',
    type: 'message_queued',
    init: {
      sessions: {
        s1: { queuedMessages: [{ clientMessageId: 'uin-1', text: 'draft', queuedAt: 10, status: 'pending' }] },
      },
    },
    message: { type: 'message_queued', sessionId: 's1', clientMessageId: 'uin-1', text: 'rewritten', queueLength: 1 },
    expect: {
      sessions: {
        s1: { queuedMessages: [{ clientMessageId: 'uin-1', text: 'rewritten', queuedAt: 10, status: 'confirmed' }] },
      },
    },
  },
  {
    name: 'message_dequeued removes the flushed entry by clientMessageId',
    type: 'message_dequeued',
    init: {
      sessions: {
        s1: {
          queuedMessages: [
            { clientMessageId: 'uin-1', text: 'a', queuedAt: 10, status: 'confirmed' },
            { clientMessageId: 'uin-2', text: 'b', queuedAt: 11, status: 'confirmed' },
          ],
        },
      },
    },
    message: { type: 'message_dequeued', sessionId: 's1', clientMessageId: 'uin-1', queueLength: 1, reason: 'flush' },
    expect: {
      sessions: {
        s1: { queuedMessages: [{ clientMessageId: 'uin-2', text: 'b', queuedAt: 11, status: 'confirmed' }] },
      },
    },
  },

  // 14. checkpoint_created / checkpoint_list (#5618 Batch 6) — flat checkpoint
  // list write, broadcast-guarded on the active session. The app's extra mirror
  // into its conversation store rides on `syncSecondaryCheckpoints` (OUTSIDE the
  // shared contract, like syncSecondaryInventory) — covered by the dispatch-table
  // unit tests, not asserted here. These pin the SHARED flat-state result.
  {
    name: 'checkpoint_created appends the checkpoint to the (empty) flat list',
    type: 'checkpoint_created',
    init: { activeSessionId: 's1' },
    message: { type: 'checkpoint_created', sessionId: 's1', checkpoint: { id: 'cp1', label: 'first' } },
    expect: { flat: { checkpoints: [{ id: 'cp1', label: 'first' }] } },
  },
  {
    name: 'checkpoint_created is dropped when it targets a non-active session',
    type: 'checkpoint_created',
    init: { activeSessionId: 'active' },
    message: { type: 'checkpoint_created', sessionId: 'other', checkpoint: { id: 'cp1' } },
    expect: { noop: true },
  },
  {
    name: 'checkpoint_created is a no-op when the checkpoint payload is missing/non-object',
    type: 'checkpoint_created',
    message: { type: 'checkpoint_created' },
    expect: { noop: true },
  },
  {
    name: 'checkpoint_list replaces the flat checkpoint list with the server array',
    type: 'checkpoint_list',
    init: { activeSessionId: 's1' },
    message: { type: 'checkpoint_list', sessionId: 's1', checkpoints: [{ id: 'a' }, { id: 'b' }] },
    expect: { flat: { checkpoints: [{ id: 'a' }, { id: 'b' }] } },
  },
  {
    name: 'checkpoint_list is dropped when it targets a non-active session',
    type: 'checkpoint_list',
    init: { activeSessionId: 'active' },
    message: { type: 'checkpoint_list', sessionId: 'other', checkpoints: [{ id: 'a' }] },
    expect: { noop: true },
  },
  {
    name: 'checkpoint_list is a no-op when checkpoints is not an array',
    type: 'checkpoint_list',
    message: { type: 'checkpoint_list' },
    expect: { noop: true },
  },
  {
    // #5618 — agent_idle migrated from SWITCH to the shared dispatch table. The
    // seeded-session path flips the session to idle ({ isIdle: true,
    // streamingMessageId: null, activeTools: [] }) via the shared dispatchAgentIdle
    // → updateSession. (The no-session FLAT fallback is preserved per-client by the
    // optional applyNoSessionFallback adapter hook — dashboard implements, app
    // omits — and is exercised by each client's own tests, not the shared contract.)
    name: 'agent_idle flips the seeded session to idle and clears the streaming id (both clients)',
    type: 'agent_idle',
    init: { activeSessionId: 's1', sessions: { s1: { isIdle: false, streamingMessageId: 'live-1' } } },
    message: { type: 'agent_idle', sessionId: 's1' },
    expect: {
      sessions: { s1: { isIdle: true, streamingMessageId: null } },
    },
  },
  {
    // #5618 — permission_mode_changed migrated from SWITCH to the shared dispatch
    // table. The seeded-session path sets the session field permissionMode via the
    // shared dispatchPermissionModeChanged (targetId-direct resolution, Decision A).
    // The no-session flat fallback + the app-only clearPending tracker are per-client
    // adapter hooks, exercised by each client's own tests, not this shared contract.
    name: 'permission_mode_changed updates the seeded session permissionMode (both clients)',
    type: 'permission_mode_changed',
    init: { activeSessionId: 's1', sessions: { s1: { permissionMode: 'default' } } },
    message: { type: 'permission_mode_changed', sessionId: 's1', mode: 'plan' },
    expect: {
      sessions: { s1: { permissionMode: 'plan' } },
    },
  },
  {
    // #5618 — budget_warning migrated SWITCH→DISPATCH. Both clients append the SAME
    // system note to the target session (the alert rides the shared adapter.alert,
    // not asserted here).
    name: 'budget_warning appends the warning system bubble to the target session (both clients)',
    type: 'budget_warning',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'budget_warning', sessionId: 's1', message: 'Approaching cost budget limit' },
    expect: {
      sessions: {
        s1: { messages: [{ type: 'system', content: 'Approaching cost budget limit' }] },
      },
    },
  },
  {
    // #5618 — plan_ready migrated SWITCH→DISPATCH. Both clients flip the session to
    // plan-pending and store the allowed prompts (the app's plan notification rides
    // the optional notifyPlanReady hook, not asserted here).
    name: 'plan_ready flips plan state to ready and stores the allowed prompts (both clients)',
    type: 'plan_ready',
    init: { sessions: { s1: { isPlanPending: false, planAllowedPrompts: [] } } },
    message: {
      type: 'plan_ready',
      sessionId: 's1',
      allowedPrompts: [{ tool: 'ExitPlanMode', prompt: 'Proceed with the plan' }],
    },
    expect: {
      sessions: {
        s1: {
          isPlanPending: true,
          planAllowedPrompts: [{ tool: 'ExitPlanMode', prompt: 'Proceed with the plan' }],
        },
      },
    },
  },
  {
    // #5618 — server_shutdown migrated SWITCH→DISPATCH. Both clients write the shared
    // patch to flat state (the app's setShutdown notification rides applyShutdownNotification).
    name: 'server_shutdown writes shutdownReason + restartEtaMs to the flat store (both clients)',
    type: 'server_shutdown',
    message: { type: 'server_shutdown', reason: 'restart', restartEtaMs: 30000 },
    expect: {
      flat: { shutdownReason: 'restart', restartEtaMs: 30000 },
    },
  },
  {
    // #5618 — rate_limited (#6334) migrated SWITCH→DISPATCH. Both clients append a
    // system throttle notice (with a retry hint) to the active session.
    name: 'rate_limited appends a system throttle notice with a retry hint (both clients)',
    type: 'rate_limited',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'rate_limited', retryAfterMs: 2000, message: 'Too many messages. Please slow down.' },
    expect: {
      sessions: {
        s1: { messages: [{ type: 'system', content: 'Too many messages. Please slow down. Retry in 2s.' }] },
      },
    },
  },
  {
    // #5618 — checkpoint_restored migrated SWITCH→DISPATCH. Both clients auto-switch
    // to the new checkpoint session via the required switchToRestoredSession hook;
    // the converged flat effect is activeSessionId = newSessionId (the DISPATCH test
    // adapter models the switch as writing activeSessionId, like the real stores).
    name: 'checkpoint_restored re-homes the active session to the new checkpoint session (both clients)',
    type: 'checkpoint_restored',
    init: { activeSessionId: 'old-sid', sessions: { 'old-sid': {} } },
    message: { type: 'checkpoint_restored', checkpointId: 'cp-1', newSessionId: 'cp-new-sid', name: 'Rewind: cp-1' },
    expect: { flat: { activeSessionId: 'cp-new-sid' } },
  },
  {
    // #5618 — conversations_list migrated SWITCH→DISPATCH. Both clients write the flat
    // conversationHistory from the parsed array (the app's error-clear + secondary-store
    // mirror ride the optional applyConversationsListExtras hook, not asserted here).
    name: 'conversations_list replaces the flat conversationHistory list (both clients)',
    type: 'conversations_list',
    message: {
      type: 'conversations_list',
      conversations: [
        {
          conversationId: 'conv-1',
          project: '/proj',
          projectName: 'proj',
          modifiedAt: '2026-06-24T00:00:00Z',
          modifiedAtMs: 1750000000000,
          sizeBytes: 1024,
          preview: 'first turn',
          cwd: '/proj',
        },
        {
          conversationId: 'conv-2',
          project: null,
          projectName: 'other',
          modifiedAt: '2026-06-23T00:00:00Z',
          modifiedAtMs: 1749900000000,
          sizeBytes: 2048,
          preview: null,
          cwd: null,
        },
      ],
    },
    expect: {
      flat: {
        conversationHistory: [
          { conversationId: 'conv-1', projectName: 'proj', preview: 'first turn' },
          { conversationId: 'conv-2', projectName: 'other', preview: null },
        ],
      },
    },
  },
  {
    // #5618 — search_results migrated SWITCH→DISPATCH. Both clients write the flat
    // searchResults + searchLoading:false (the staleness gate reads searchQuery via
    // getSearchQuery — unseeded here → apply). The app's searchError clear + secondary
    // store mirror ride the optional applySearchResultsExtras hook (not asserted).
    name: 'search_results replaces the flat searchResults list (both clients)',
    type: 'search_results',
    message: {
      type: 'search_results',
      query: 'auth',
      results: [
        {
          conversationId: 'conv-1',
          projectName: 'chroxy',
          project: 'chroxy',
          cwd: '/Users/me/chroxy',
          preview: 'auth handler',
          snippet: 'ws-auth.js validates the bearer token',
          matchCount: 3,
        },
      ],
    },
    expect: {
      flat: {
        searchResults: [
          {
            conversationId: 'conv-1',
            projectName: 'chroxy',
            preview: 'auth handler',
            matchCount: 3,
          },
        ],
        searchLoading: false,
      },
    },
  },
]

// ---------------------------------------------------------------------------
// SWITCH-CASE FIXTURES — high-traffic cases that still live in each client's
// own `handleMessage` switch / HANDLERS map (NOT migrated to the shared table).
//
// These are driven through each client's REAL `handleMessage` in the per-client
// suites (app jest, dashboard vitest), asserting the resulting
// `sessionStates[id].messages` agree across both clients. The cases here are the
// session-state-LOCAL stream/turn lifecycle ones whose mutation is observable
// without standing up either client's external Zustand stores (lifecycle,
// multi-client, terminal): stream + tool + turn lifecycle, plus a plain `message`.
//
// `expect.sessions[id].messages` is asserted as a partial deep-equal that
// IGNORES non-deterministic fields (timestamp, generated ids) — the per-client
// driver strips those before comparing (see each suite's `normalize`).
// ---------------------------------------------------------------------------

export const SWITCH_FIXTURES: ContractFixture[] = [
  {
    // The `message` envelope carries the real bubble type in `messageType`
    // (here 'response'); `content` and `timestamp` are required by the shared
    // handler's runtime validation.
    name: 'message appends a response bubble to the active session',
    type: 'message',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: {
      type: 'message',
      sessionId: 's1',
      messageType: 'response',
      messageId: 'resp-msg-1',
      content: 'Hello from the agent',
      timestamp: 1000,
    },
    expect: {
      sessions: {
        s1: { messages: [{ id: 'resp-msg-1', type: 'response', content: 'Hello from the agent' }] },
      },
    },
  },
  {
    name: 'stream_start opens an empty response bubble on the active session',
    type: 'stream_start',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'stream_start', sessionId: 's1', messageId: 'resp-1' },
    expect: {
      sessions: { s1: { messages: [{ id: 'resp-1', type: 'response', content: '' }] } },
    },
  },
  {
    name: 'stream_start reuses an existing response bubble (replay dedup, no duplicate)',
    type: 'stream_start',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'partial' } as unknown as ChatMessage],
        },
      },
    },
    message: { type: 'stream_start', sessionId: 's1', messageId: 'resp-1' },
    expect: {
      sessions: { s1: { messages: [{ id: 'resp-1', type: 'response', content: 'partial' }] } },
    },
  },
  {
    name: 'tool_start appends a tool_use bubble to the active session',
    type: 'tool_start',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: {
      type: 'tool_start',
      sessionId: 's1',
      toolUseId: 'tu-1',
      tool: 'Read',
      input: { file_path: '/tmp/x' },
    },
    expect: {
      sessions: { s1: { messages: [{ type: 'tool_use', tool: 'Read' }] } },
    },
  },
  {
    name: 'tool_result attaches the result to its in-flight tool_use bubble',
    type: 'tool_result',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [
            {
              id: 'tool-tu-1',
              type: 'tool_use',
              tool: 'Read',
              toolUseId: 'tu-1',
              content: '',
            } as unknown as ChatMessage,
          ],
          activeTools: [{ toolUseId: 'tu-1', tool: 'Read', startedAt: 1 }],
        },
      },
    },
    message: {
      type: 'tool_result',
      sessionId: 's1',
      toolUseId: 'tu-1',
      result: 'file contents here',
    },
    expect: {
      // Both clients attach the result onto the same bubble; assert the bubble
      // is still a single tool_use entry carrying the result text.
      sessions: { s1: { messages: [{ type: 'tool_use', toolUseId: 'tu-1', toolResult: 'file contents here' }] } },
    },
  },
  {
    // #6712 — a FAILED tool_result (codex mcpToolCall failure / orphan sweep)
    // flags `isError` on the wire; both clients must attach `toolResultIsError`
    // (+ the error text) onto the tool_use bubble so the renderers can style it.
    name: 'tool_result flags isError + truncated onto the tool_use bubble',
    type: 'tool_result',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [
            { id: 'tool-tu-2', type: 'tool_use', tool: 'db/query', toolUseId: 'tu-2', content: '' } as unknown as ChatMessage,
          ],
          activeTools: [{ toolUseId: 'tu-2', tool: 'db/query', startedAt: 1 }],
        },
      },
    },
    message: {
      type: 'tool_result',
      sessionId: 's1',
      toolUseId: 'tu-2',
      result: 'connection refused',
      isError: true,
      truncated: false,
    },
    expect: {
      sessions: {
        s1: {
          messages: [
            { type: 'tool_use', toolUseId: 'tu-2', toolResult: 'connection refused', toolResultIsError: true, toolResultTruncated: false },
          ],
        },
      },
    },
  },
  {
    // budget_exceeded is a DOCUMENTED divergence (#5619): both append a
    // "session paused" system note, but the dashboard auto-resumes and tacks
    // ". Budget will auto-resume." onto the same bubble (the app does not — it
    // shows a manual "Resume" Alert action instead). The `divergent` block pins
    // each client's own content so the difference is locked, not hidden.
    name: 'budget_exceeded appends a paused system bubble (dashboard notes auto-resume)',
    type: 'budget_exceeded',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'budget_exceeded', sessionId: 's1', message: 'Cost budget exceeded' },
    divergent: {
      reason:
        'dashboard auto-resumes and appends ". Budget will auto-resume." to the bubble; ' +
        'the app surfaces a manual Resume Alert and leaves the bubble at "— session paused"',
      app: {
        sessions: {
          s1: { messages: [{ type: 'system', content: 'Cost budget exceeded — session paused' }] },
        },
      },
      dashboard: {
        sessions: {
          s1: {
            messages: [
              { type: 'system', content: 'Cost budget exceeded — session paused. Budget will auto-resume.' },
            ],
          },
        },
      },
    },
  },
  {
    name: 'history_replay_start (full) keeps existing messages visible (no blank-flash wipe)',
    type: 'history_replay_start',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'old-1', type: 'response', content: 'stale' } as unknown as ChatMessage],
        },
      },
    },
    message: { type: 'history_replay_start', sessionId: 's1', fullHistory: true },
    expect: {
      // #5555.4 — the pre-replay prefix MUST stay on screen during a full rebuild
      // (the whole point of the reconcile). Asserts no wipe-to-empty.
      sessions: { s1: { messages: [{ id: 'old-1', type: 'response', content: 'stale' }] } },
    },
  },

  // -------------------------------------------------------------------------
  // Hot both-clients types (#6032). The five highest-traffic / highest-risk
  // switch cases the #5619 lint allow-listed with NO behavioural fixture:
  // the permission lifecycle (request → resolved), the turn-completion teardown
  // (result), the streaming teardown (stream_end), and the global error path.
  // Both clients parse these through the SAME store-core shared handlers
  // (`handlePermissionRequest`, `handlePermissionResolved`, `handleResultUsage`,
  // `handleStreamEnd`, `handleError`), so their `messages`-array effect is
  // byte-identical — a single `expect` (no `divergent` block). The contract
  // runners assert ONLY `sessions[id].messages` (normalised to
  // {id,type,content,tool,toolUseId}); the per-client side effects these types
  // also carry — the app's 'Allow for Session' option vs the dashboard's
  // hardcoded allow/deny, the app's native error Alert vs the dashboard toast,
  // the completion-notification gate — live OUTSIDE that slice and are covered
  // by each client's own suites, so they do not surface here.
  // -------------------------------------------------------------------------
  {
    // permission_request ADDS a 'prompt' bubble to the target session (the wire
    // sessionId, else the active session). Both clients build the same bubble
    // content from the shared parser: the tool name alone, or `"<tool>: <desc>"`.
    // The options array differs per client (app gates 'Allow for Session') but
    // is stripped by the runners' normalise, so the asserted slice agrees.
    name: 'permission_request appends a prompt bubble to the active session',
    type: 'permission_request',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: {
      type: 'permission_request',
      requestId: 'req-1',
      tool: 'Bash',
      description: 'rm -rf /tmp/x',
      input: { command: 'rm -rf /tmp/x' },
    },
    expect: {
      sessions: {
        s1: { messages: [{ type: 'prompt', content: 'Bash: rm -rf /tmp/x', tool: 'Bash' }] },
      },
    },
  },
  {
    // result ends a turn: both clients tear down streaming state and refresh the
    // messages REFERENCE (`[...ss.messages]`) but DO NOT add/remove/edit any
    // bubble — the transcript is preserved verbatim. Seed a response bubble and
    // assert it is still the sole, unchanged entry after the teardown. (The
    // completion-notification gate is a side effect outside the messages slice.)
    name: 'result tears down the turn without mutating the transcript',
    type: 'result',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'done' } as unknown as ChatMessage],
        },
      },
    },
    message: { type: 'result', sessionId: 's1', cost: 0.01, duration: 1200 },
    expect: {
      sessions: { s1: { messages: [{ id: 'resp-1', type: 'response', content: 'done' }] } },
    },
  },
  {
    // #6627/#6707 — a turn-complete `result` carries the server's authoritative
    // outgoing-queue length. When a `message_dequeued` was dropped/late the
    // client still shows a flushed message as "Queued"; both clients self-heal on
    // the result by trimming the stale CONFIRMED orphan (oldest-first, FIFO) down
    // to queueLength. The transcript is untouched. This fixture locks app +
    // dashboard to the same outcome — the reconcile lives in each client's REAL
    // `case 'result'`, not the shared dispatch table, so only the both-clients
    // SWITCH harness enforces parity (the #6705 review's deferred gap).
    name: 'result reconciles a stale queued orphan against queueLength (self-heal)',
    type: 'result',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'done' } as unknown as ChatMessage],
          queuedMessages: [
            { clientMessageId: 'uin-1', text: 'a', queuedAt: 10, status: 'confirmed' },
            { clientMessageId: 'uin-2', text: 'b', queuedAt: 11, status: 'confirmed' },
          ],
        },
      },
    },
    message: { type: 'result', sessionId: 's1', cost: 0.01, duration: 1200, queueLength: 1 },
    expect: {
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'done' }],
          // The oldest confirmed orphan (uin-1) is trimmed; the newest survives.
          queuedMessages: [{ clientMessageId: 'uin-2', text: 'b', queuedAt: 11, status: 'confirmed' }],
        },
      },
    },
  },
  {
    // #6627/#6707 — when the client queue already matches the result's
    // queueLength, the reconcile is a referential no-op: the genuinely-queued
    // entry survives untouched. Guards against an over-eager trim clobbering a
    // live queued message on every turn boundary.
    name: 'result leaves the queue intact when queueLength already matches',
    type: 'result',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'done' } as unknown as ChatMessage],
          queuedMessages: [{ clientMessageId: 'uin-1', text: 'still queued', queuedAt: 10, status: 'confirmed' }],
        },
      },
    },
    message: { type: 'result', sessionId: 's1', cost: 0.01, duration: 1200, queueLength: 1 },
    expect: {
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'done' }],
          queuedMessages: [{ clientMessageId: 'uin-1', text: 'still queued', queuedAt: 10, status: 'confirmed' }],
        },
      },
    },
  },
  {
    // #6627/#6707 — status-aware parity: with an interleaved queue
    // [confirmed-orphan, pending, confirmed] and queueLength 1, both clients must
    // reap ONLY the oldest CONFIRMED orphan (a dropped dequeue) and preserve the
    // optimistic pending entry (a live, not-yet-confirmed send) plus the newest
    // confirmed one. This is the strong removal-guard fixture: seed length 3 →
    // expect length 2, so a deleted/stripped reconcile fails it, and a client
    // that trims the pending entry (the #5950-class regression) fails too.
    name: 'result reap keeps an interleaved pending entry while trimming a confirmed orphan',
    type: 'result',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'done' } as unknown as ChatMessage],
          queuedMessages: [
            { clientMessageId: 'uin-0', text: 'orphan', queuedAt: 9, status: 'confirmed' },
            { clientMessageId: 'uin-1', text: 'live', queuedAt: 10, status: 'pending' },
            { clientMessageId: 'uin-2', text: 'a', queuedAt: 11, status: 'confirmed' },
          ],
        },
      },
    },
    message: { type: 'result', sessionId: 's1', cost: 0.01, duration: 1200, queueLength: 1 },
    expect: {
      sessions: {
        s1: {
          queuedMessages: [
            { clientMessageId: 'uin-1', text: 'live', queuedAt: 10, status: 'pending' },
            { clientMessageId: 'uin-2', text: 'a', queuedAt: 11, status: 'confirmed' },
          ],
        },
      },
    },
  },
  {
    // stream_end is the asymmetric teardown gap (stream_start IS pinned above):
    // both clients clear `streamingMessageId` and refresh the messages REFERENCE
    // but leave the transcript untouched. Seed the in-flight response bubble and
    // assert it survives the teardown unchanged.
    name: 'stream_end closes streaming without mutating the transcript',
    type: 'stream_end',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'partial' } as unknown as ChatMessage],
          streamingMessageId: 'resp-1',
        },
      },
    },
    message: { type: 'stream_end', messageId: 'resp-1' },
    expect: {
      sessions: { s1: { messages: [{ id: 'resp-1', type: 'response', content: 'partial' }] } },
    },
  },
  {
    // permission_resolved (another client answered) flips the matching 'prompt'
    // bubble to answered IN PLACE — both clients keep exactly ONE bubble and do
    // NOT add/remove/retype it. Each client scans its session states for the
    // requestId and rewrites that one bubble ({...m, answered, answeredAt,
    // options: undefined}); the answered/answeredAt/options fields are STRIPPED by
    // each runner's `normalize`, so the asserted slice is the unchanged prompt
    // bubble (same id/type/content/tool). The contract this pins is the
    // both-clients shape invariant: one in-place flip, never a duplicate prompt or
    // a wiped transcript. (#6058; deferred from #6032.) The dashboard's extra
    // sessionNotifications-drain + flat-messages-fallback and the app's banner
    // filter are per-client side effects outside the messages slice.
    name: 'permission_resolved flips the prompt to answered in place (one bubble, shape unchanged)',
    type: 'permission_resolved',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [
            {
              id: 'prompt-req-1',
              type: 'prompt',
              content: 'Bash: rm -rf /tmp/x',
              tool: 'Bash',
              requestId: 'req-1',
            } as unknown as ChatMessage,
          ],
        },
      },
    },
    message: { type: 'permission_resolved', requestId: 'req-1', decision: 'allow' },
    expect: {
      sessions: {
        s1: { messages: [{ id: 'prompt-req-1', type: 'prompt', content: 'Bash: rm -rf /tmp/x', tool: 'Bash' }] },
      },
    },
  },
  {
    // error is a GLOBAL surface (app → native Alert, dashboard → toast) — neither
    // client routes it into a session transcript. Seed a response bubble on the
    // active session and assert the error leaves the transcript completely
    // untouched (the divergent Alert/toast side effect is outside this slice).
    name: 'error does not touch the session transcript (surfaced globally)',
    type: 'error',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'before error' } as unknown as ChatMessage],
        },
      },
    },
    message: { type: 'error', code: 'GENERIC', message: 'something failed' },
    expect: {
      sessions: { s1: { messages: [{ id: 'resp-1', type: 'response', content: 'before error' }] } },
    },
  },
  {
    // web_task_error (#5619): both clients parse via the shared
    // `handleWebTaskError` and, on the common path, append ONE identical
    // `system` bubble (content = the error message) to the ACTIVE session
    // (`activeSessionId`). The message carries no session key of its own
    // (its fields are taskId / message / code / boundSession*), so there is no
    // per-session routing for the two clients to diverge on. The app
    // additionally short-circuits to a native Alert (NO bubble) ONLY when
    // `code === 'SESSION_TOKEN_MISMATCH' && boundSessionName` is set; a plain
    // error message (no `code`/`boundSessionName`) never trips that, so both
    // clients agree — a single `expect`, no `divergent` block. `taskId` is
    // omitted deliberately: its presence drives a `webTasks` status update the
    // fixture harness can't seed (init has no `webTasks` slice), and that update
    // is a flat-state side effect OUTSIDE the asserted `messages` slice anyway.
    name: 'web_task_error appends a system error bubble to the active session',
    type: 'web_task_error',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'web_task_error', message: 'Web task failed: network timeout' },
    expect: {
      sessions: {
        s1: { messages: [{ type: 'system', content: 'Web task failed: network timeout' }] },
      },
    },
  },
  {
    // #6325 (drain #6314): the server broadcasts `user_input` to all OTHER
    // clients when one client sends a message — a multi-client live echo. Both
    // clients route it through the shared `sharedUserInput`/parseUserInputMessage
    // path: it builds a `user_input`-typed bubble (content from `text`, id from
    // the server's stable `messageId`) and appends it. The gate skips a message
    // from THIS client (clientId === myClientId), so the fixture uses a different
    // sender. The dashboard additionally writes the prompt to its terminal buffer
    // (a mocked side effect outside the asserted `messages` slice).
    name: 'user_input echoes another client’s message as a user_input bubble',
    type: 'user_input',
    init: { activeSessionId: 's1', myClientId: 'me', sessions: { s1: {} } },
    message: {
      type: 'user_input',
      sessionId: 's1',
      clientId: 'other-device',
      messageId: 'ui-1',
      text: 'hello from another device',
      timestamp: 1000,
    },
    expect: {
      sessions: {
        s1: { messages: [{ id: 'ui-1', type: 'user_input', content: 'hello from another device' }] },
      },
    },
  },
  {
    // #6325 (drain #6314): a pending permission expired/could-not-route. Both
    // clients call the shared handlePermissionExpired, which appends a fixed
    // "(Expired — …)" suffix to the matching `prompt` bubble IN PLACE (matched by
    // requestId + type==='prompt') and clears its options (options is dropped by
    // the harness normalize, so not asserted). Target = msg.sessionId ||
    // activeSessionId; no-op if requestId is null or the session/prompt is absent
    // — so the fixture seeds a prompt carrying the requestId. The dashboard's
    // #2833 already-resolved early-return is gated on `resolvedPermissions`, which
    // FixtureInitialState can't seed, so both clients take the same path → single
    // expect. The banner-drain is a sessionNotifications side effect outside the
    // asserted messages slice.
    name: 'permission_expired appends the expired suffix to the matching prompt in place (both clients)',
    type: 'permission_expired',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [
            {
              id: 'prompt-req-1',
              type: 'prompt',
              content: 'Bash: rm -rf /tmp/x',
              tool: 'Bash',
              requestId: 'req-1',
              options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
            } as unknown as ChatMessage,
          ],
        },
      },
    },
    message: {
      type: 'permission_expired',
      requestId: 'req-1',
      sessionId: 's1',
      message: 'permission response could not be routed (expired/handled)',
    },
    expect: {
      sessions: {
        s1: {
          messages: [
            {
              id: 'prompt-req-1',
              type: 'prompt',
              content: 'Bash: rm -rf /tmp/x\n(Expired — this permission was already handled or timed out)',
              tool: 'Bash',
            },
          ],
        },
      },
    },
  },
  {
    // #6325 (drain #6314): streaming partial tool input. Both clients delegate to
    // the shared handleToolInputDelta, which locates the in-flight tool_use bubble
    // by toolUseId and appends `partialJson` onto its `toolInputPartial`
    // accumulator (seeded undefined → ''), leaving a single tool_use entry. The
    // assertion on `toolInputPartial` requires that field in the harness
    // `normalize()` whitelist (added in this PR for both clients).
    name: 'tool_input_delta accumulates the partial JSON onto its in-flight tool_use bubble',
    type: 'tool_input_delta',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [
            {
              id: 'tool-tu-1',
              type: 'tool_use',
              tool: 'Bash',
              toolUseId: 'tu-1',
              content: '',
            } as unknown as ChatMessage,
          ],
        },
      },
    },
    message: {
      type: 'tool_input_delta',
      sessionId: 's1',
      toolUseId: 'tu-1',
      partialJson: '{"command":"ls',
    },
    expect: {
      sessions: {
        s1: { messages: [{ type: 'tool_use', toolUseId: 'tu-1', toolInputPartial: '{"command":"ls' }] },
      },
    },
  },
  {
    // #6325 (drain #6314): session ready. Both clients apply the shared
    // handleClaudeReady patch ({ claudeReady: true, stoppedAt: null,
    // stoppedCode: null }) onto the session — no message bubble. With no
    // backgroundTasks on the wire, the app (calls it with no msg arg) and the
    // dashboard (calls it with msg) produce the identical scalar patch → single
    // expect. Asserts the session-scalar field via the #6325 harness extension.
    name: 'claude_ready sets the session claudeReady flag (both clients)',
    type: 'claude_ready',
    init: { activeSessionId: 's1', sessions: { s1: { claudeReady: false } } },
    message: { type: 'claude_ready', sessionId: 's1' },
    expect: {
      sessions: { s1: { claudeReady: true } },
    },
  },
  {
    // #6325 (drain #6314): a session crashed. Both clients (shared handleSessionError,
    // category 'crash') flip the target session's `health` to 'crashed'. crashedId
    // resolves to the active session, so the pushSessionNotification side effect
    // early-returns (sessionId === activeSessionId) and never hits the mocked store.
    // Non-vacuous: seeds health:'ok' so the handler must flip it.
    name: 'session_error (crash) flips the target session health to crashed (both clients)',
    type: 'session_error',
    init: { activeSessionId: 's1', sessions: { s1: { health: 'ok' } } },
    message: { type: 'session_error', category: 'crash', sessionId: 's1' },
    expect: { sessions: { s1: { health: 'crashed' } } },
  },
  {
    // #6325 (drain #6314): a legacy server_status (no phase) — both clients append
    // the ANSI-stripped status message as a `system` bubble to the active session.
    name: 'server_status (legacy, no phase) appends the status message to the active session (both clients)',
    type: 'server_status',
    init: {
      activeSessionId: 's1',
      sessions: { s1: { messages: [{ id: 'seed-1', type: 'user', content: 'hello', timestamp: 1 } as unknown as ChatMessage] } },
    },
    message: { type: 'server_status', message: 'Tunnel reconnected' },
    expect: {
      sessions: {
        s1: {
          messages: [
            { type: 'user', content: 'hello' },
            { type: 'system', content: 'Tunnel reconnected' },
          ],
        },
      },
    },
  },
  {
    // #6325 (drain #6314): a stream_delta buffers behind the coalescing flush timer,
    // then applyDeltaBatch appends the text onto the in-flight response bubble's
    // content on flush. The contract harness drains the timer before asserting, so
    // the concatenated content is observable. Seeds non-empty content so the append
    // is non-vacuous.
    name: 'stream_delta appends the delta text onto its in-flight response bubble (both clients)',
    type: 'stream_delta',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'Hello' } as unknown as ChatMessage],
          streamingMessageId: 'resp-1',
        },
      },
    },
    message: { type: 'stream_delta', sessionId: 's1', messageId: 'resp-1', delta: ', world' },
    expect: {
      sessions: { s1: { messages: [{ id: 'resp-1', type: 'response', content: 'Hello, world' }] } },
    },
  },
  {
    // #6325 (drain #6314): a live-activity delta. Its PRIMARY effect (the flat
    // `activity` tree) isn't switch-harness-assertable, but it has a deterministic
    // both-clients session-scalar side effect: clearing the target session's
    // inactivityWarning to null (live activity = the user is back). lastClientActivityAt
    // is also written but is Date.now() (non-deterministic) → deliberately not asserted.
    name: 'activity_delta clears any inactivityWarning on its target session (live-activity bump)',
    type: 'activity_delta',
    init: { sessions: { s1: { inactivityWarning: { idleMs: 60000, prefab: 'Still there?', receivedAt: 1000 } } } },
    message: {
      type: 'activity_delta',
      sessionId: 's1',
      schemaVersion: 1,
      op: 'started',
      entry: { id: 'a1', kind: 'shell', label: 'npm test', status: 'running', startedAt: 1000 },
    },
    expect: { sessions: { s1: { inactivityWarning: null } } },
  },
  {
    // #6325 (drain #6314): another client connected. With ONE seeded (active)
    // session the app's active-only append and the dashboard's all-sessions append
    // converge → a plain expect (the divergence is only observable with 2+ seeded
    // sessions). Seeds a prior bubble so the 2-entry expect is non-vacuous.
    name: 'client_joined appends a connected-device system bubble to the active session',
    type: 'client_joined',
    init: {
      activeSessionId: 's1',
      sessions: { s1: { messages: [{ id: 'seed-1', type: 'response', content: 'prior' } as unknown as ChatMessage] } },
    },
    message: {
      type: 'client_joined',
      client: { clientId: 'c2', deviceName: 'iPhone 16 Pro', deviceType: 'phone', platform: 'ios' },
    },
    expect: {
      sessions: {
        s1: {
          messages: [
            { id: 'seed-1', type: 'response', content: 'prior' },
            { type: 'system', content: 'iPhone 16 Pro connected' },
          ],
        },
      },
    },
  },
  {
    // #6325 (drain #6314): a pending permission auto-denied after the server
    // timeout. Both clients (shared handlePermissionTimeout) scan sessionStates for
    // the matching `prompt` (requestId + type==='prompt') and append a fixed
    // '(Auto-denied — permission timed out)' suffix in place (options cleared, not
    // asserted). Targeting is by requestId alone, so the fixture seeds the prompt.
    name: 'permission_timeout appends the auto-denied suffix to the matching prompt in place (both clients)',
    type: 'permission_timeout',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [
            {
              id: 'prompt-req-1',
              type: 'prompt',
              content: 'Bash: rm -rf /tmp/x',
              tool: 'Bash',
              requestId: 'req-1',
              options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
            } as unknown as ChatMessage,
          ],
        },
      },
    },
    message: { type: 'permission_timeout', requestId: 'req-1', tool: 'Bash' },
    expect: {
      sessions: {
        s1: {
          messages: [
            { id: 'prompt-req-1', type: 'prompt', content: 'Bash: rm -rf /tmp/x\n(Auto-denied — permission timed out)', tool: 'Bash' },
          ],
        },
      },
    },
  },
  {
    // #6325 (drain #6314): a server-side error tagged to a session. Both clients
    // (shared handleServerError) append an `error` bubble to the tagged session and
    // clear streamingMessageId + pendingClientMessageId. The serverErrors ring +
    // notification toast are off the sessions[id] slice.
    name: 'server_error appends an error bubble to the tagged session and clears the live stream (both clients)',
    type: 'server_error',
    init: {
      activeSessionId: 's1',
      sessions: {
        s1: {
          messages: [{ id: 'resp-1', type: 'response', content: 'working' } as unknown as ChatMessage],
          streamingMessageId: 'live-1',
          pendingClientMessageId: 'uin-1',
        },
      },
    },
    message: { type: 'server_error', sessionId: 's1', category: 'session', message: 'Disk write failed', recoverable: true },
    expect: {
      sessions: {
        s1: {
          messages: [
            { id: 'resp-1', type: 'response', content: 'working' },
            { type: 'error', content: 'Disk write failed' },
          ],
          streamingMessageId: null,
          pendingClientMessageId: null,
        },
      },
    },
  },
  {
    // #6325 (drain #6314): a session_list refresh patches conversationId onto a
    // pre-existing session (the patch loop skips ids not already in sessionStates).
    // Seeds a different starting conversationId so the patch is non-vacuous.
    name: 'session_list patches conversationId onto a pre-existing session (both clients)',
    type: 'session_list',
    init: { activeSessionId: 's1', sessions: { s1: { conversationId: 'conv-OLD' } } },
    message: {
      type: 'session_list',
      sessions: [
        {
          sessionId: 's1',
          name: 'Session 1',
          cwd: '/tmp',
          type: 'cli',
          hasTerminal: false,
          model: null,
          permissionMode: null,
          isBusy: false,
          createdAt: 0,
          conversationId: 'conv-NEW',
        },
      ],
    },
    expect: { sessions: { s1: { conversationId: 'conv-NEW' } } },
  },
  {
    // #6325 (drain #6314): a session_warning legitimately DIVERGES. The dashboard
    // pushes a `system` warning bubble into the target session's messages; the app
    // instead writes the warning to its flat `timeoutWarning` banner slot and leaves
    // messages untouched. Target = the active session so the dashboard's
    // non-active-session Alert side effect doesn't fire.
    name: 'session_warning diverges: dashboard appends a warning bubble; the app keeps messages untouched',
    type: 'session_warning',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: {
      type: 'session_warning',
      sessionId: 's1',
      name: 'My Session',
      reason: 'idle_timeout',
      message: 'Session will time out in 2 minutes',
      remainingMs: 120000,
    },
    divergent: {
      reason:
        'the dashboard pushes the shared system ChatMessage into the target session’s messages; the app writes the parsed ' +
        'warning into the flat timeoutWarning slot (banner UI) + useNotificationStore and leaves sessions[id].messages untouched. ' +
        'Target = the active session so the dashboard’s non-active-session Alert side effect does not fire.',
      app: { sessions: { s1: { messages: [] } } },
      dashboard: { sessions: { s1: { messages: [{ type: 'system', content: 'Session will time out in 2 minutes' }] } } },
    },
  },
  {
    // #6325 (bucket-B flat-assert): an activity_snapshot REPLACES the target
    // session's flat `activity` tree ({byId, order} per session) — both clients run
    // the same applyActivitySnapshot + set({ activity }). A snapshot is a full-state
    // resync, so (unlike activity_delta) it does NOT touch any session scalar. The
    // harness seeds activity:{bySession:{}}, so populate-from-empty is non-vacuous.
    name: "activity_snapshot replaces the target session's flat activity tree",
    type: 'activity_snapshot',
    message: {
      type: 'activity_snapshot',
      sessionId: 's1',
      schemaVersion: 1,
      entries: [
        { id: 'a1', kind: 'shell', label: 'npm test', status: 'running', startedAt: 1000 },
        { id: 'a2', kind: 'agent', label: 'review', status: 'done', startedAt: 1000, endedAt: 2000 },
      ],
    },
    expect: {
      flat: {
        activity: {
          bySession: {
            s1: {
              byId: {
                a1: { id: 'a1', kind: 'shell', label: 'npm test', status: 'running', startedAt: 1000 },
                a2: { id: 'a2', kind: 'agent', label: 'review', status: 'done', startedAt: 1000, endedAt: 2000 },
              },
              order: ['a1', 'a2'],
            },
          },
        },
      },
    },
  },
  {
    // #6325 (bucket-B): another client disconnected. With ONE seeded (active)
    // session the app's active-only append and the dashboard's all-sessions append
    // converge → a plain expect (mirrors client_joined). The bubble label is
    // 'A device' (not the wire id): handleClientLeft looks the departing client up
    // in connectedClients, which the harness seeds to [] → fallback 'A device'. The
    // roster flat effect ([]→[]) is vacuous, so we assert the bubble, not the roster.
    name: 'client_left appends a disconnected-device system bubble to the active session',
    type: 'client_left',
    init: {
      activeSessionId: 's1',
      sessions: { s1: { messages: [{ id: 'seed-1', type: 'response', content: 'prior' } as unknown as ChatMessage] } },
    },
    message: { type: 'client_left', clientId: 'c2' },
    expect: {
      sessions: {
        s1: {
          messages: [
            { id: 'seed-1', type: 'response', content: 'prior' },
            { type: 'system', content: 'A device disconnected' },
          ],
        },
      },
    },
  },
  {
    // #6325 (bucket-B): server_mode legitimately DIVERGES. The dashboard sets the
    // flat main-store `serverMode`; the app routes it into the mocked
    // useConnectionLifecycleStore (setServerInfo) and only conditionally sets
    // viewMode (guarded on viewMode==='terminal', never seeded) — so the app makes
    // no observable main-store mutation. Dashboard asserts flat serverMode; app no-op.
    name: 'server_mode sets the flat serverMode on the dashboard; the app routes it to the mocked lifecycle store (divergent)',
    type: 'server_mode',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'server_mode', mode: 'cli' },
    divergent: {
      reason:
        "the dashboard writes the flat main-store field serverMode (set({serverMode:'cli'})); the app routes serverMode into the " +
        'secondary useConnectionLifecycleStore (mocked here) and only conditionally sets viewMode (guarded on a terminal viewMode the ' +
        'harness never seeds), so the app makes no observable main-store mutation.',
      app: {},
      dashboard: { flat: { serverMode: 'cli' } },
    },
  },
  {
    // #6325 (bucket-B): the active session switched. Both clients (shared
    // handleSessionSwitched) set the flat activeSessionId to the new id and lazily
    // init sessionStates[newId], stamping conversationId. Seeds a different starting
    // activeSessionId so the flip is non-vacuous; the switched-to session is created
    // by the handler. fetchSlashCommands/fetchCustomAgents at the tail are stubbed.
    name: 'session_switched flips activeSessionId and initialises the switched-to session with its conversationId (both clients)',
    type: 'session_switched',
    init: { activeSessionId: 's-old', sessions: { 's-old': {} } },
    message: { type: 'session_switched', sessionId: 's-new', conversationId: 'conv-7' },
    expect: {
      flat: { activeSessionId: 's-new' },
      sessions: { 's-new': { conversationId: 'conv-7' } },
    },
  },
  {
    // #6325 (bucket-B): session_timeout deletes the timed-out session and, when it
    // was active, reassigns the flat activeSessionId to the first remaining session.
    // s1 (active) times out, s2 survives → both set activeSessionId 's2'. The deleted
    // session is NOT listed under expect.sessions (the harness does toBeDefined()
    // per id); only the flat activeSessionId effect is asserted (both agree).
    name: 'session_timeout removes the active session and switches activeSessionId to the next remaining session',
    type: 'session_timeout',
    init: { activeSessionId: 's1', sessions: { s1: {}, s2: {} } },
    message: { type: 'session_timeout', sessionId: 's1', name: 'Old Session' },
    expect: {
      flat: { activeSessionId: 's2' },
    },
  },
  {
    // #6325 (auth_ok close-out): the handshake-complete frame. Both clients run the
    // shared handleAuthOk parser, then write a SHARED slice onto the flat main store
    // via set(connectedState): the boolean-coerced webFeatures map AND the
    // shutdown-state clear (shutdownReason/restartEtaMs/restartingSince → null, "clear
    // shutdown on a successful connect"). The dashboard ALSO writes serverMode/version/
    // etc. flat; the app routes those into the mocked lifecycle/multi-client stores —
    // so those DIVERGE and are not asserted. webFeatures (unseeded; the wire carries
    // mixed-truthy values the parser coerces to strict booleans) + the shutdown trio
    // (unseeded → the null clear) are the non-vacuous both-clients flat slice.
    name: 'auth_ok writes the shared webFeatures map and clears shutdown state on the flat main store (both clients)',
    type: 'auth_ok',
    message: {
      type: 'auth_ok',
      webFeatures: { available: 1, remote: true, teleport: 0 },
    },
    expect: {
      flat: {
        webFeatures: { available: true, remote: true, teleport: false },
        shutdownReason: null,
        restartEtaMs: null,
        restartingSince: null,
      },
    },
  },
  {
    // #6325 (auth_fail close-out): the server rejected the bearer token. Both clients
    // close the socket and tear down, but record the phase in DIFFERENT stores: the
    // dashboard writes the flat main-store connectionPhase (set({ connectionPhase:
    // 'disconnected', socket: null }), seeded 'connected' → non-vacuous); the app keeps
    // connectionPhase in the secondary useConnectionLifecycleStore (mocked) and only
    // writes socket: null (a WebSocket ref, not a meaningful assert) — so no observable
    // main-store mutation. Same divergence shape as server_mode.
    name: 'auth_fail flips the dashboard flat connectionPhase to disconnected; the app routes the phase to the mocked lifecycle store (divergent)',
    type: 'auth_fail',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'auth_fail', reason: 'expired token' },
    divergent: {
      reason:
        "the dashboard writes the flat main-store field connectionPhase via set({ connectionPhase: 'disconnected', socket: null }) " +
        '(seeded connected → non-vacuous); the app keeps connectionPhase in the secondary useConnectionLifecycleStore (mocked here) and ' +
        'writes only socket: null to the main store, so the app makes no observable main-store mutation.',
      app: {},
      dashboard: { flat: { connectionPhase: 'disconnected' } },
    },
  },
  {
    // #6325 (pair_fail close-out): pairing rejected — same divergence as auth_fail.
    // The dashboard flips the flat connectionPhase to disconnected; the app routes the
    // phase into the mocked lifecycle store and only does the vacuous set({socket:null}).
    // Default reason 'unknown' (no reason field) skips the dashboard's requires_approval
    // branch; activeServerId is unseeded so removeServer is never called.
    name: 'pair_fail flips the dashboard flat connectionPhase to disconnected; the app routes the phase to the mocked lifecycle store (divergent)',
    type: 'pair_fail',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: { type: 'pair_fail' },
    divergent: {
      reason:
        "the dashboard writes the flat main-store field connectionPhase via set({ connectionPhase: 'disconnected', socket: null }) " +
        '(seeded connected → non-vacuous); the app routes the phase into the secondary useConnectionLifecycleStore (mocked here) and ' +
        'only does the vacuous set({ socket: null }), so the app makes no observable main-store mutation.',
      app: {},
      dashboard: { flat: { connectionPhase: 'disconnected' } },
    },
  },
  {
    // #6344 (multi-message): history_replay_end's observable effect is the deferred
    // atomic swap that slices off the pre-baseline prefix. That's only non-vacuous
    // when (a) a full-rebuild baseline exists AND (b) entries were appended after it,
    // so this fixture uses a prelude: history_replay_start(fullHistory) records the
    // baseline at the seeded prefix length (1, no wipe — the #5555.4 contract), then
    // a replayed `message` envelope appends after it. history_replay_end then swaps
    // to the post-baseline tail → the seeded 'stale' prefix is removed, leaving only
    // the replayed turn (1 in → 1 DIFFERENT out; a no-op would leave both = 2).
    name: 'history_replay_end swaps to the replayed tail, dropping the pre-baseline prefix (multi-message)',
    type: 'history_replay_end',
    init: {
      activeSessionId: 's1',
      sessions: { s1: { messages: [{ id: 'old-1', type: 'response', content: 'stale' } as unknown as ChatMessage] } },
    },
    prelude: [
      { type: 'history_replay_start', sessionId: 's1', fullHistory: true },
      { type: 'message', sessionId: 's1', messageType: 'response', messageId: 'replayed-1', content: 'authoritative replayed turn', timestamp: 2000 },
    ],
    message: { type: 'history_replay_end', sessionId: 's1', latestSeq: 1 },
    expect: {
      sessions: {
        s1: { messages: [{ id: 'replayed-1', type: 'response', content: 'authoritative replayed turn' }] },
      },
    },
  },
  {
    // #6344 (multi-message): key_exchange_ok's only store-writing branch is the
    // invalid-publicKey error path, gated behind `if (_pendingKeyPair)` — so alone
    // it's a total no-op. The prelude auth_ok (encryption:'required', no
    // serverPublicKey, unpinned→TOFU) takes the discrete-handshake fallback and
    // stashes _pendingKeyPair; the asserted key_exchange_ok (publicKey omitted →
    // null) then enters the guard and runs the error teardown. The divergence is the
    // same shape as auth_fail/pair_fail: the dashboard flips the flat main-store
    // connectionPhase; the app routes phase to the mocked lifecycle store (no
    // observable main-store change).
    name: 'key_exchange_ok (invalid server key) flips the dashboard flat connectionPhase; the app routes it to the mocked lifecycle store (divergent, multi-message)',
    type: 'key_exchange_ok',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    prelude: [{ type: 'auth_ok', encryption: 'required' }],
    message: { type: 'key_exchange_ok' },
    divergent: {
      reason:
        "key_exchange_ok's only store-writing branch is the invalid-publicKey error path, gated behind if (_pendingKeyPair) — so " +
        'without the prelude the handler is a pure no-op. The prelude auth_ok (encryption required, no serverPublicKey, unpinned→TOFU) ' +
        'stashes _pendingKeyPair via the discrete-handshake fallback; the asserted key_exchange_ok (publicKey null) then runs the error ' +
        'teardown. The dashboard writes the flat connectionPhase (seeded connected → non-vacuous); the app keeps phase in the mocked ' +
        'lifecycle store and writes only socket: null, so it makes no observable main-store mutation.',
      app: {},
      dashboard: { flat: { connectionPhase: 'disconnected' } },
    },
  },
  {
    // #6268: web_task_error carrying a taskId flips the matching flat webTask to
    // `failed` with the error text — identical in both clients (the shared
    // state.webTasks.map). Seeds a 'running' task so the transition is non-vacuous;
    // updatedAt is Date.now() so it is deliberately not asserted. (The common
    // taskId-less bubble path is pinned by the existing web_task_error fixture.)
    name: 'web_task_error with a taskId flips the matching webTask to failed (both clients)',
    type: 'web_task_error',
    init: {
      activeSessionId: 's1',
      sessions: { s1: {} },
      webTasks: [{ taskId: 't1', status: 'running', prompt: 'do the thing' }],
    },
    message: { type: 'web_task_error', taskId: 't1', message: 'task blew up' },
    expect: {
      flat: { webTasks: [{ taskId: 't1', status: 'failed', error: 'task blew up' }] },
    },
  },
  {
    // #6268: web_task_error with code SESSION_TOKEN_MISMATCH + boundSessionName
    // legitimately DIVERGES (#2944). The app short-circuits to a native Alert and
    // appends NO bubble (this device is paired to a different session); the
    // dashboard has no such guard and always appends the system bubble. No taskId,
    // so the webTasks slice is untouched. Target = the active session.
    name: 'web_task_error SESSION_TOKEN_MISMATCH diverges: app shows an Alert with no bubble; the dashboard appends the bubble',
    type: 'web_task_error',
    init: { activeSessionId: 's1', sessions: { s1: {} } },
    message: {
      type: 'web_task_error',
      code: 'SESSION_TOKEN_MISMATCH',
      boundSessionName: 'My Session',
      message: 'This action is bound to another session',
    },
    divergent: {
      reason:
        'on a SESSION_TOKEN_MISMATCH with a boundSessionName the app short-circuits to showBoundSessionMismatchAlert and appends NO ' +
        'bubble (#2944), while the dashboard has no such guard and always appends the system error bubble. The Alert is a side effect ' +
        'outside the asserted messages slice.',
      app: { sessions: { s1: { messages: [] } } },
      dashboard: { sessions: { s1: { messages: [{ type: 'system', content: 'This action is bound to another session' }] } } },
    },
  },
  // permission_input (#6558, follow-up to #6543 PR-4) — the get_permission_input
  // pull reply. Became a both-clients switch type when the mobile app gained a
  // `case 'permission_input':` (dashboard handles it via its HANDLERS map). Both
  // reducers are byte-identical: a single flat write
  // `set({ permissionInputs: { ...get().permissionInputs, [requestId]: data } })`,
  // Zod-validated (drop-on-malformed). A flat-assert fixture drives BOTH clients'
  // real handleMessage, so any future drift in either reducer fails here. Replaces
  // the PENDING_CONTRACT_TYPES allowlist entry.
  {
    name: 'permission_input (found) stores the full redacted tool input by requestId (both clients)',
    type: 'permission_input',
    message: {
      type: 'permission_input',
      requestId: 'r1',
      found: true,
      tool: 'Write',
      input: { file_path: '/x', content: 'a\nb' },
    },
    expect: {
      flat: {
        permissionInputs: {
          r1: { type: 'permission_input', requestId: 'r1', found: true, tool: 'Write', input: { file_path: '/x', content: 'a\nb' } },
        },
      },
    },
  },
  {
    // The found:false security shape carries only an `error`. The "can't leak any
    // tool input" invariant is enforced by ServerPermissionInputSchema (its
    // found:false branch is a plain z.object, so Zod STRIPS any stray input/tool at
    // parse); the reducer stores the parsed data, so a leak is structurally
    // impossible. This fixture drives that shape through both reducers and asserts
    // the stored error (a toMatchObject partial — it documents the branch, the
    // schema does the enforcing).
    name: 'permission_input (not found) stores the security error shape without any input (both clients)',
    type: 'permission_input',
    message: {
      type: 'permission_input',
      requestId: 'r2',
      found: false,
      error: { code: 'NOT_PENDING', message: 'gone' },
    },
    expect: {
      flat: {
        permissionInputs: {
          r2: { type: 'permission_input', requestId: 'r2', found: false, error: { code: 'NOT_PENDING', message: 'gone' } },
        },
      },
    },
  },
]
