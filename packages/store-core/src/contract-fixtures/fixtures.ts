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
            payload: { path: '/f.ts', content: 'x', language: 'typescript', size: 1, truncated: true, error: null },
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
      sessions: { s1: { messages: [{ type: 'tool_use', toolUseId: 'tu-1' }] } },
    },
  },
  {
    // budget_warning is a both-clients switch case (#5619): both clients append
    // the SAME system note to the target session's messages when it exists.
    // `msg.message` is echoed verbatim into the bubble content.
    name: 'budget_warning appends the warning system bubble to the target session',
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
]
