import { describe, it, expect } from 'vitest'
import {
  createDispatchTable,
  runDispatch,
  DISPATCH_TABLE_TYPES,
  type ClientStoreAdapter,
} from './dispatch-table'
import type {
  ChatMessage,
  SessionInfo,
  AgentInfo,
  DevPreview,
  PendingBackgroundShell,
  QueuedSessionMessage,
} from './types'
import type { PermissionRule } from './handlers'

// ---------------------------------------------------------------------------
// Fake adapter — a minimal in-memory store that records every mutation a
// dispatch handler makes. Generic over a loose session shape so the table's
// `updateSession` updater type-checks against it.
// ---------------------------------------------------------------------------

interface FakeSession {
  sessionId: string
  messages: ChatMessage[]
  isIdle?: boolean
  conversationId?: string | null
  sessionRules?: PermissionRule[]
  // slice 2 reads
  activeAgents?: AgentInfo[]
  pendingBackgroundShells?: PendingBackgroundShell[]
  devPreviews?: DevPreview[]
  // outgoing-message queue (#5937)
  queuedMessages?: QueuedSessionMessage[]
  [k: string]: unknown
}

function makeAdapter(init?: {
  activeSessionId?: string | null
  sessions?: Record<string, FakeSession>
  sessionList?: SessionInfo[]
  /**
   * When provided, the adapter implements `getCallback` (the app opts into the
   * imperative-callback registry for the #5653 file-ops / git cases). When
   * omitted, the adapter has NO `getCallback`, so those cases DECLINE (the
   * dashboard's behaviour — fall through to the local switch).
   */
  callbacks?: Partial<Record<string, ((payload: unknown) => void) | null>>
  /**
   * When true, the adapter wires the app-only inventory hooks (#5618 Batch 2):
   * `syncSecondaryInventory` (records into `inventorySyncs`) and `mapProviderList`
   * (a marker transform that proves the dispatcher writes the HOOK's output, not
   * the raw payload). When omitted, both hooks are absent — the dashboard's
   * verbatim behaviour (no secondary-store mirror; provider list written as-is).
   */
  inventoryHooks?: boolean
}) {
  const sessions: Record<string, FakeSession> = init?.sessions ?? {}
  let activeSessionId = init?.activeSessionId ?? null
  let sessionList: SessionInfo[] = init?.sessionList ?? []
  const flat: Record<string, unknown> = {}
  const addedMessages: ChatMessage[] = []
  const notifications: Array<{ sessionId: string; eventType: string; message: string }> = []
  const inventorySyncs: Array<{ kind: string; list: unknown[] }> = []

  const adapter: ClientStoreAdapter<FakeSession> = {
    getActiveSessionId: () => activeSessionId,
    hasSession: (id) => Object.prototype.hasOwnProperty.call(sessions, id),
    updateSession: (id, updater) => {
      const current = sessions[id]
      if (!current) return
      sessions[id] = { ...current, ...updater(current) }
    },
    setState: (patch) => Object.assign(flat, patch),
    updateState: (updater) => Object.assign(flat, updater(flat)),
    addMessage: (m) => addedMessages.push(m),
    getSessions: () => sessionList,
    pushSessionNotification: (sessionId, eventType, message) =>
      notifications.push({ sessionId, eventType, message }),
    ...(init?.callbacks
      ? {
          getCallback: ((name: string) =>
            (init.callbacks?.[name] ?? null)) as ClientStoreAdapter<FakeSession>['getCallback'],
        }
      : {}),
    ...(init?.inventoryHooks
      ? {
          syncSecondaryInventory: (kind, list) => inventorySyncs.push({ kind, list }),
          // Marker transform: prepend a sentinel so a test can prove the flat
          // write used the hook's RETURN value, not the raw `providers`. (The
          // contract test models the real app `mapProviderList` filtering.)
          mapProviderList: (providers) => ['__mapped__', ...providers],
        }
      : {}),
  }

  return {
    adapter,
    sessions,
    flat,
    addedMessages,
    notifications,
    inventorySyncs,
    setActive: (id: string | null) => {
      activeSessionId = id
    },
    setSessionList: (l: SessionInfo[]) => {
      sessionList = l
    },
  }
}

const table = createDispatchTable<FakeSession>()

function dispatch(env: ReturnType<typeof makeAdapter>, msg: Record<string, unknown>): boolean {
  return runDispatch(table, msg, env.adapter)
}

describe('shared dispatch table', () => {
  describe('runner mechanics', () => {
    it('returns false (table miss) for an unregistered type so the caller falls through', () => {
      const env = makeAdapter()
      // permission_mode_changed stays platform-local (divergent dashboard
      // flat-state fallback), so it is NOT in the shared table — a clean miss.
      expect(dispatch(env, { type: 'permission_mode_changed', mode: 'plan' })).toBe(false)
    })

    it('returns false for a non-string type', () => {
      const env = makeAdapter()
      expect(dispatch(env, { type: 42 } as unknown as Record<string, unknown>)).toBe(false)
    })

    it('returns true and runs the handler on a hit', () => {
      const env = makeAdapter()
      expect(dispatch(env, { type: 'available_permission_modes', modes: [] })).toBe(true)
    })

    it('does NOT treat inherited Object.prototype keys as registered types', () => {
      const env = makeAdapter()
      // 'toString' / 'constructor' live on Object.prototype but must not match.
      expect(dispatch(env, { type: 'toString' })).toBe(false)
      expect(dispatch(env, { type: 'constructor' })).toBe(false)
    })

    it('DISPATCH_TABLE_TYPES matches the table keys exactly', () => {
      expect([...DISPATCH_TABLE_TYPES].sort()).toEqual(Object.keys(table).sort())
    })
  })

  describe('available_permission_modes', () => {
    it('sets availablePermissionModes when the payload parses', () => {
      const env = makeAdapter()
      dispatch(env, {
        type: 'available_permission_modes',
        modes: [
          { id: 'default', label: 'Default' },
          { id: 'plan', label: 'Plan', description: 'Plan mode' },
        ],
      })
      expect(env.flat.availablePermissionModes).toEqual([
        { id: 'default', label: 'Default' },
        { id: 'plan', label: 'Plan', description: 'Plan mode' },
      ])
    })

    it('leaves state untouched when modes is not an array', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'available_permission_modes' })
      expect(env.flat.availablePermissionModes).toBeUndefined()
    })
  })

  describe('session_updated', () => {
    it('renames the matching session in the list', () => {
      const env = makeAdapter({
        sessionList: [
          { sessionId: 's1', name: 'Old' } as SessionInfo,
          { sessionId: 's2', name: 'Keep' } as SessionInfo,
        ],
      })
      dispatch(env, { type: 'session_updated', sessionId: 's1', name: 'New' })
      expect(env.flat.sessions).toEqual([
        { sessionId: 's1', name: 'New' },
        { sessionId: 's2', name: 'Keep' },
      ])
    })

    it('no-ops (no setState) when name or sessionId is missing', () => {
      const env = makeAdapter({ sessionList: [{ sessionId: 's1', name: 'Old' } as SessionInfo] })
      dispatch(env, { type: 'session_updated', sessionId: 's1' } as unknown as Record<string, unknown>)
      expect(env.flat.sessions).toBeUndefined()
    })
  })

  describe('agent_busy', () => {
    it('flips the explicit target session to non-idle', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [], isIdle: true } },
      })
      dispatch(env, { type: 'agent_busy', sessionId: 's1' })
      expect(env.sessions.s1.isIdle).toBe(false)
    })

    it('falls back to the active session when sessionId is absent', () => {
      const env = makeAdapter({
        activeSessionId: 'active',
        sessions: { active: { sessionId: 'active', messages: [], isIdle: true } },
      })
      dispatch(env, { type: 'agent_busy' })
      expect(env.sessions.active.isIdle).toBe(false)
    })

    it('no-ops when the resolved session does not exist locally', () => {
      const env = makeAdapter({ activeSessionId: 'gone' })
      dispatch(env, { type: 'agent_busy' })
      expect(Object.keys(env.sessions)).toHaveLength(0)
    })
  })

  describe('budget_resumed', () => {
    it('appends the system message to the target session', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      dispatch(env, { type: 'budget_resumed', sessionId: 's1' })
      expect(env.sessions.s1.messages).toHaveLength(1)
      expect(env.sessions.s1.messages[0]).toMatchObject({
        type: 'system',
        content: 'Cost budget override — session resumed',
      })
      expect(env.addedMessages).toHaveLength(0)
    })

    it('falls back to addMessage when there is no target session', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'budget_resumed' })
      expect(env.addedMessages).toHaveLength(1)
      expect(env.addedMessages[0]).toMatchObject({
        type: 'system',
        content: 'Cost budget override — session resumed',
      })
    })
  })

  describe('user_question (#5618)', () => {
    it('appends the question prompt to the target session and notifies', () => {
      const env = makeAdapter({
        activeSessionId: 'other',
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      const handled = dispatch(env, {
        type: 'user_question',
        sessionId: 's1',
        questions: [{ question: 'Proceed with the deploy?' }],
      })
      expect(handled).toBe(true)
      expect(env.sessions.s1.messages).toHaveLength(1)
      expect(env.sessions.s1.messages[0]).toMatchObject({
        type: 'prompt',
        content: 'Proceed with the deploy?',
      })
      expect(env.addedMessages).toHaveLength(0)
      expect(env.notifications).toEqual([
        { sessionId: 's1', eventType: 'question', message: 'Proceed with the deploy?' },
      ])
    })

    it('honours a finite wire timestamp on the appended prompt (#4613)', () => {
      const env = makeAdapter({
        activeSessionId: 'other',
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      dispatch(env, {
        type: 'user_question',
        sessionId: 's1',
        questions: [{ question: 'Deploy now?' }],
        timestamp: 1_700_000_000_000,
      })
      expect(env.sessions.s1.messages[0]).toMatchObject({
        type: 'prompt',
        content: 'Deploy now?',
        timestamp: 1_700_000_000_000,
      })
    })

    it('falls back to addMessage (global log) and skips notify when no session resolves', () => {
      const env = makeAdapter() // no activeSessionId, no explicit sessionId
      const handled = dispatch(env, {
        type: 'user_question',
        questions: [{ question: 'Anyone there?' }],
      })
      expect(handled).toBe(true)
      expect(env.addedMessages).toHaveLength(1)
      expect(env.addedMessages[0]).toMatchObject({ type: 'prompt', content: 'Anyone there?' })
      // sessionId is null → no per-session notification.
      expect(env.notifications).toHaveLength(0)
    })

    it('is handled (no mutation) when the questions payload is malformed', () => {
      const env = makeAdapter({ activeSessionId: 's1', sessions: { s1: { sessionId: 's1', messages: [] } } })
      const handled = dispatch(env, { type: 'user_question', questions: [] })
      // The table OWNS the type (returns true) but the parser rejects it.
      expect(handled).toBe(true)
      expect(env.sessions.s1.messages).toHaveLength(0)
      expect(env.addedMessages).toHaveLength(0)
      expect(env.notifications).toHaveLength(0)
    })
  })

  describe('multi_question_intervention (#5618)', () => {
    it('appends the intervention and a first-time system notice', () => {
      const env = makeAdapter({ sessions: { s1: { sessionId: 's1', messages: [] } } })
      const handled = dispatch(env, {
        type: 'multi_question_intervention',
        sessionId: 's1',
        toolUseId: 'tu1',
        questionCount: 3,
      })
      expect(handled).toBe(true)
      expect(env.sessions.s1.interventions).toMatchObject([{ kind: 'multi_question', toolUseId: 'tu1', count: 3 }])
      expect(env.sessions.s1.messages).toHaveLength(1)
      expect(env.sessions.s1.messages[0]).toMatchObject({
        type: 'system',
        content: 'chroxy intercepted a multi-question form and asked the agent to break it into single questions.',
      })
    })

    it('dedups a repeat toolUseId — no second intervention, no second notice', () => {
      const env = makeAdapter({
        sessions: {
          s1: {
            sessionId: 's1',
            messages: [],
            interventions: [{ kind: 'multi_question', toolUseId: 'tu1', count: 3, timestamp: 1 }],
          } as unknown as FakeSession,
        },
      })
      const handled = dispatch(env, {
        type: 'multi_question_intervention',
        sessionId: 's1',
        toolUseId: 'tu1',
        questionCount: 3,
      })
      expect(handled).toBe(true)
      expect(env.sessions.s1.interventions).toHaveLength(1) // unchanged
      expect(env.sessions.s1.messages).toHaveLength(0) // no repeat notice
    })

    it('is handled (no mutation) on a malformed payload (questionCount < 2)', () => {
      const env = makeAdapter({ sessions: { s1: { sessionId: 's1', messages: [] } } })
      const handled = dispatch(env, {
        type: 'multi_question_intervention',
        sessionId: 's1',
        toolUseId: 'tu1',
        questionCount: 1,
      })
      expect(handled).toBe(true) // table OWNS the type; the parser rejects the payload
      expect(env.sessions.s1.interventions).toBeUndefined()
      expect(env.sessions.s1.messages).toHaveLength(0)
    })
  })

  describe('slash_commands / agent_list / provider_list (#5618 Batch 2)', () => {
    it('slash_commands replaces the flat list and mirrors into the secondary store (app)', () => {
      const env = makeAdapter({ inventoryHooks: true })
      const handled = dispatch(env, {
        type: 'slash_commands',
        commands: [{ name: '/compact' }, { name: '/clear' }],
      })
      expect(handled).toBe(true)
      expect(env.flat.slashCommands).toEqual([{ name: '/compact' }, { name: '/clear' }])
      expect(env.inventorySyncs).toEqual([
        { kind: 'slashCommands', list: [{ name: '/compact' }, { name: '/clear' }] },
      ])
    })

    it('slash_commands replaces the flat list with NO mirror when the hook is absent (dashboard)', () => {
      const env = makeAdapter()
      const handled = dispatch(env, { type: 'slash_commands', commands: [{ name: '/x' }] })
      expect(handled).toBe(true)
      expect(env.flat.slashCommands).toEqual([{ name: '/x' }])
      expect(env.inventorySyncs).toEqual([])
    })

    it('slash_commands is owned-but-no-op when it targets a non-active session', () => {
      const env = makeAdapter({ activeSessionId: 'active', inventoryHooks: true })
      const handled = dispatch(env, {
        type: 'slash_commands',
        sessionId: 'other',
        commands: [{ name: '/x' }],
      })
      expect(handled).toBe(true)
      expect(env.flat.slashCommands).toBeUndefined()
      expect(env.inventorySyncs).toEqual([])
    })

    it('slash_commands is owned-but-no-op when commands is not an array', () => {
      const env = makeAdapter({ inventoryHooks: true })
      expect(dispatch(env, { type: 'slash_commands' })).toBe(true)
      expect(env.flat.slashCommands).toBeUndefined()
      expect(env.inventorySyncs).toEqual([])
    })

    it('agent_list replaces the flat list and mirrors into the secondary store (app)', () => {
      const env = makeAdapter({ inventoryHooks: true })
      const handled = dispatch(env, {
        type: 'agent_list',
        agents: [{ name: 'reviewer' }],
      })
      expect(handled).toBe(true)
      expect(env.flat.customAgents).toEqual([{ name: 'reviewer' }])
      expect(env.inventorySyncs).toEqual([{ kind: 'customAgents', list: [{ name: 'reviewer' }] }])
    })

    it('agent_list is owned-but-no-op when agents is not an array', () => {
      const env = makeAdapter({ inventoryHooks: true })
      expect(dispatch(env, { type: 'agent_list' })).toBe(true)
      expect(env.flat.customAgents).toBeUndefined()
      expect(env.inventorySyncs).toEqual([])
    })

    it('provider_list writes the payload verbatim when no mapProviderList hook is set (dashboard)', () => {
      const env = makeAdapter()
      const handled = dispatch(env, {
        type: 'provider_list',
        providers: [{ name: 'claude' }, { name: 'gemini' }],
      })
      expect(handled).toBe(true)
      expect(env.flat.availableProviders).toEqual([{ name: 'claude' }, { name: 'gemini' }])
    })

    it('provider_list writes the mapProviderList hook output when present (app)', () => {
      const env = makeAdapter({ inventoryHooks: true })
      const handled = dispatch(env, {
        type: 'provider_list',
        providers: [{ name: 'claude' }],
      })
      expect(handled).toBe(true)
      // The marker proves the dispatcher wrote the HOOK's return value.
      expect(env.flat.availableProviders).toEqual(['__mapped__', { name: 'claude' }])
    })

    it('provider_list is owned-but-no-op when providers is not an array', () => {
      const env = makeAdapter()
      expect(dispatch(env, { type: 'provider_list' })).toBe(true)
      expect(env.flat.availableProviders).toBeUndefined()
    })
  })

  describe('budget_resume_ack', () => {
    it('appends a "nothing to resume" note when the session was not paused', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      dispatch(env, { type: 'budget_resume_ack', sessionId: 's1', wasPaused: false })
      expect(env.sessions.s1.messages).toHaveLength(1)
      expect(env.sessions.s1.messages[0]).toMatchObject({
        type: 'system',
        content: 'Budget was not paused — nothing to resume',
      })
      expect(env.addedMessages).toHaveLength(0)
    })

    it('is a no-op when the session was actually paused (budget_resumed already noted it)', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      dispatch(env, { type: 'budget_resume_ack', sessionId: 's1', wasPaused: true })
      expect(env.sessions.s1.messages).toHaveLength(0)
      expect(env.addedMessages).toHaveLength(0)
    })

    it('falls back to addMessage for the not-paused note when there is no target session', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'budget_resume_ack', wasPaused: false })
      expect(env.addedMessages).toHaveLength(1)
      expect(env.addedMessages[0]).toMatchObject({
        type: 'system',
        content: 'Budget was not paused — nothing to resume',
      })
    })
  })

  describe('conversation_id', () => {
    it('stamps the conversation id onto the explicit session', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      dispatch(env, { type: 'conversation_id', sessionId: 's1', conversationId: 'conv-9' })
      expect(env.sessions.s1.conversationId).toBe('conv-9')
    })

    it('does NOT fall back to the active session when sessionId is missing', () => {
      const env = makeAdapter({
        activeSessionId: 'active',
        sessions: { active: { sessionId: 'active', messages: [] } },
      })
      dispatch(env, { type: 'conversation_id', conversationId: 'conv-9' })
      expect(env.sessions.active.conversationId).toBeUndefined()
    })
  })

  describe('permission_rules_updated', () => {
    it('replaces the explicit session rule set', () => {
      const rules = [{ tool: 'Bash', action: 'allow' }]
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [], sessionRules: [] } },
      })
      dispatch(env, { type: 'permission_rules_updated', sessionId: 's1', rules })
      expect(env.sessions.s1.sessionRules).toEqual(rules)
    })

    it('falls back to the active session when sessionId is absent', () => {
      const rules = [{ tool: 'Edit', action: 'deny' }]
      const env = makeAdapter({
        activeSessionId: 'active',
        sessions: { active: { sessionId: 'active', messages: [], sessionRules: [] } },
      })
      dispatch(env, { type: 'permission_rules_updated', rules })
      expect(env.sessions.active.sessionRules).toEqual(rules)
    })

    it('defaults to an empty rule set when rules is not an array', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [], sessionRules: [{ tool: 'Bash', decision: 'allow' }] } },
      })
      dispatch(env, { type: 'permission_rules_updated', sessionId: 's1' })
      expect(env.sessions.s1.sessionRules).toEqual([])
    })
  })

  describe('confirm_permission_mode', () => {
    it('stores the pending confirmation with mode + warning', () => {
      const env = makeAdapter()
      dispatch(env, {
        type: 'confirm_permission_mode',
        mode: 'bypassPermissions',
        warning: 'Dangerous',
      })
      expect(env.flat.pendingPermissionConfirm).toEqual({
        mode: 'bypassPermissions',
        warning: 'Dangerous',
      })
    })

    it('defaults the warning when the server omits it', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'confirm_permission_mode', mode: 'plan' })
      expect(env.flat.pendingPermissionConfirm).toEqual({
        mode: 'plan',
        warning: 'Are you sure?',
      })
    })

    it('leaves state untouched when mode is missing', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'confirm_permission_mode' })
      expect(env.flat.pendingPermissionConfirm).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Slice 2 (epic #5556) — next batch of byte-identical pure cases
  // -------------------------------------------------------------------------

  describe('agent_spawned', () => {
    it('adds the spawned agent entry to its session', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [], activeAgents: [] } },
      })
      dispatch(env, {
        type: 'agent_spawned',
        sessionId: 's1',
        toolUseId: 'tu-1',
        description: 'Search the repo',
        startedAt: 1000,
      })
      expect(env.sessions.s1.activeAgents).toEqual([
        { toolUseId: 'tu-1', description: 'Search the repo', startedAt: 1000 },
      ])
    })

    it('dedupes a repeat spawn for the same toolUseId (same-reference no-op)', () => {
      const env = makeAdapter({
        sessions: {
          s1: {
            sessionId: 's1',
            messages: [],
            activeAgents: [{ toolUseId: 'tu-1', description: 'x', startedAt: 1 }],
          },
        },
      })
      dispatch(env, { type: 'agent_spawned', sessionId: 's1', toolUseId: 'tu-1' })
      expect(env.sessions.s1.activeAgents).toHaveLength(1)
    })

    it('no-ops when the session is not present locally', () => {
      const env = makeAdapter({ activeSessionId: 'gone' })
      dispatch(env, { type: 'agent_spawned', toolUseId: 'tu-1' })
      expect(Object.keys(env.sessions)).toHaveLength(0)
    })
  })

  describe('agent_completed', () => {
    it('removes the completed agent entry', () => {
      const env = makeAdapter({
        sessions: {
          s1: {
            sessionId: 's1',
            messages: [],
            activeAgents: [
              { toolUseId: 'tu-1', description: 'a', startedAt: 1 },
              { toolUseId: 'tu-2', description: 'b', startedAt: 2 },
            ],
          },
        },
      })
      dispatch(env, { type: 'agent_completed', sessionId: 's1', toolUseId: 'tu-1' })
      expect(env.sessions.s1.activeAgents).toEqual([
        { toolUseId: 'tu-2', description: 'b', startedAt: 2 },
      ])
    })
  })

  describe('agent_event', () => {
    it('appends a child event to the parent Task tool_use bubble', () => {
      const env = makeAdapter({
        sessions: {
          s1: {
            sessionId: 's1',
            messages: [
              { type: 'tool_use', toolUseId: 'parent-1' } as unknown as ChatMessage,
            ],
          },
        },
      })
      dispatch(env, {
        type: 'agent_event',
        sessionId: 's1',
        parentToolUseId: 'parent-1',
        eventType: 'tool_start',
        payload: { name: 'Read' },
      })
      const parent = env.sessions.s1.messages[0] as unknown as {
        childAgentEvents?: { type: string; payload: Record<string, unknown> }[]
      }
      expect(parent.childAgentEvents).toEqual([{ type: 'tool_start', payload: { name: 'Read' } }])
    })

    it('same-reference no-op when the parent bubble is not present', () => {
      const original = [
        { type: 'tool_use', toolUseId: 'other' } as unknown as ChatMessage,
      ]
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: original } },
      })
      dispatch(env, {
        type: 'agent_event',
        sessionId: 's1',
        parentToolUseId: 'missing',
        eventType: 'tool_start',
        payload: {},
      })
      // No parent match → builder returns the same array reference → the
      // dispatch wrapper patches nothing, so the slot is untouched.
      expect(env.sessions.s1.messages).toBe(original)
    })

    it('no-ops when the session is not present locally', () => {
      const env = makeAdapter({ activeSessionId: 'gone' })
      dispatch(env, {
        type: 'agent_event',
        parentToolUseId: 'p',
        eventType: 'tool_start',
        payload: {},
      })
      expect(Object.keys(env.sessions)).toHaveLength(0)
    })
  })

  describe('background_work_changed', () => {
    it('replaces the pending-background-shells snapshot for the session', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [], pendingBackgroundShells: [] } },
      })
      dispatch(env, {
        type: 'background_work_changed',
        sessionId: 's1',
        pending: [{ shellId: 'sh-1', command: 'npm test', startedAt: 1000 }],
      })
      expect(env.sessions.s1.pendingBackgroundShells).toEqual([
        { shellId: 'sh-1', command: 'npm test', startedAt: 1000 },
      ])
    })
  })

  describe('message_queued / message_dequeued (#5937)', () => {
    it('reconciles a server message_queued by appending a confirmed entry', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [], queuedMessages: [] } },
      })
      dispatch(env, {
        type: 'message_queued',
        sessionId: 's1',
        clientMessageId: 'uin-1',
        text: 'follow-up',
        queueLength: 1,
      })
      expect(env.sessions.s1.queuedMessages).toMatchObject([
        { clientMessageId: 'uin-1', text: 'follow-up', status: 'confirmed' },
      ])
    })

    it('flips an optimistic pending entry to confirmed (dedup by clientMessageId)', () => {
      const env = makeAdapter({
        sessions: {
          s1: {
            sessionId: 's1',
            messages: [],
            queuedMessages: [
              { clientMessageId: 'uin-1', text: 'follow-up', queuedAt: 10, status: 'pending' },
            ],
          },
        },
      })
      dispatch(env, { type: 'message_queued', sessionId: 's1', clientMessageId: 'uin-1', text: 'follow-up', queueLength: 1 })
      expect(env.sessions.s1.queuedMessages).toEqual([
        { clientMessageId: 'uin-1', text: 'follow-up', queuedAt: 10, status: 'confirmed' },
      ])
    })

    it('removes the dequeued entry by clientMessageId on flush', () => {
      const env = makeAdapter({
        sessions: {
          s1: {
            sessionId: 's1',
            messages: [],
            queuedMessages: [
              { clientMessageId: 'uin-1', text: 'a', queuedAt: 10, status: 'confirmed' },
              { clientMessageId: 'uin-2', text: 'b', queuedAt: 11, status: 'confirmed' },
            ],
          },
        },
      })
      dispatch(env, { type: 'message_dequeued', sessionId: 's1', clientMessageId: 'uin-1', queueLength: 1, reason: 'flush' })
      expect(env.sessions.s1.queuedMessages).toEqual([
        { clientMessageId: 'uin-2', text: 'b', queuedAt: 11, status: 'confirmed' },
      ])
    })

    it('removes the FIFO head when message_dequeued echoes no clientMessageId', () => {
      const env = makeAdapter({
        sessions: {
          s1: {
            sessionId: 's1',
            messages: [],
            queuedMessages: [
              { text: 'a', queuedAt: 10, status: 'confirmed' },
              { text: 'b', queuedAt: 11, status: 'confirmed' },
            ],
          },
        },
      })
      dispatch(env, { type: 'message_dequeued', sessionId: 's1', queueLength: 1, reason: 'flush' })
      expect(env.sessions.s1.queuedMessages).toEqual([{ text: 'b', queuedAt: 11, status: 'confirmed' }])
    })

    it('does not bleed across sessions — only the targeted session is mutated', () => {
      const env = makeAdapter({
        sessions: {
          s1: { sessionId: 's1', messages: [], queuedMessages: [] },
          s2: { sessionId: 's2', messages: [], queuedMessages: [] },
        },
      })
      dispatch(env, { type: 'message_queued', sessionId: 's1', clientMessageId: 'uin-1', text: 'hi', queueLength: 1 })
      expect(env.sessions.s1.queuedMessages).toHaveLength(1)
      expect(env.sessions.s2.queuedMessages).toEqual([])
    })

    it('self-heals a leftover orphan on the next dequeue via the authoritative queueLength (#5950)', () => {
      // uin-0's message_dequeued was lost, leaving a stuck "Queued" badge. The
      // server now flushes uin-1 with queueLength: 0 → both entries clear.
      const env = makeAdapter({
        sessions: {
          s1: {
            sessionId: 's1',
            messages: [],
            queuedMessages: [
              { clientMessageId: 'uin-0', text: 'orphan', queuedAt: 9, status: 'confirmed' },
              { clientMessageId: 'uin-1', text: 'a', queuedAt: 10, status: 'confirmed' },
            ],
          },
        },
      })
      dispatch(env, { type: 'message_dequeued', sessionId: 's1', clientMessageId: 'uin-1', queueLength: 0, reason: 'flush' })
      expect(env.sessions.s1.queuedMessages).toEqual([])
    })
  })

  describe('plan_started', () => {
    it('clears pending-plan state on the target session', () => {
      const env = makeAdapter({
        sessions: {
          s1: { sessionId: 's1', messages: [], isPlanPending: true, planAllowedPrompts: ['x'] },
        },
      })
      dispatch(env, { type: 'plan_started', sessionId: 's1' })
      expect(env.sessions.s1.isPlanPending).toBe(false)
      expect(env.sessions.s1.planAllowedPrompts).toEqual([])
    })
  })

  describe('inactivity_warning', () => {
    it('stamps the soft check-in prompt onto its session', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      dispatch(env, {
        type: 'inactivity_warning',
        sessionId: 's1',
        idleMs: 60_000,
        prefab: 'Still there?',
      })
      expect(env.sessions.s1.inactivityWarning).toMatchObject({
        idleMs: 60_000,
        prefab: 'Still there?',
      })
    })

    it('no-ops when the payload is invalid (handler returns null)', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      dispatch(env, { type: 'inactivity_warning', sessionId: 's1', idleMs: 0, prefab: 'x' })
      expect(env.sessions.s1.inactivityWarning).toBeUndefined()
    })
  })

  describe('mcp_servers', () => {
    it('replaces the target session MCP-server list', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [], mcpServers: [] } },
      })
      dispatch(env, {
        type: 'mcp_servers',
        sessionId: 's1',
        servers: [{ name: 'fs', status: 'connected' }],
      })
      expect(env.sessions.s1.mcpServers).toEqual([{ name: 'fs', status: 'connected' }])
    })

    it('falls back to the active session when sessionId is absent', () => {
      const env = makeAdapter({
        activeSessionId: 'active',
        sessions: { active: { sessionId: 'active', messages: [], mcpServers: [] } },
      })
      dispatch(env, { type: 'mcp_servers', servers: [] })
      expect(env.sessions.active.mcpServers).toEqual([])
    })
  })

  describe('session_usage', () => {
    it('stores the session cumulative usage', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      dispatch(env, {
        type: 'session_usage',
        sessionId: 's1',
        cumulativeUsage: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 },
      })
      expect(env.sessions.s1.cumulativeUsage).toMatchObject({
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.5,
      })
    })
  })

  describe('session_cost_threshold_crossed', () => {
    it('stores the one-shot cost-warning banner (explicit sessionId only)', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [] } },
      })
      dispatch(env, {
        type: 'session_cost_threshold_crossed',
        sessionId: 's1',
        costUsd: 5,
        thresholdUsd: 4,
      })
      expect(env.sessions.s1.costThresholdWarning).toEqual({
        costUsd: 5,
        thresholdUsd: 4,
        dismissedAt: null,
      })
    })

    it('does NOT fall back to the active session when sessionId is missing', () => {
      const env = makeAdapter({
        activeSessionId: 'active',
        sessions: { active: { sessionId: 'active', messages: [] } },
      })
      dispatch(env, { type: 'session_cost_threshold_crossed', costUsd: 5, thresholdUsd: 4 })
      expect(env.sessions.active.costThresholdWarning).toBeUndefined()
    })
  })

  describe('dev_preview / dev_preview_stopped', () => {
    it('adds a dev-preview entry deduped by port', () => {
      const env = makeAdapter({
        sessions: { s1: { sessionId: 's1', messages: [], devPreviews: [] } },
      })
      dispatch(env, { type: 'dev_preview', sessionId: 's1', port: 3000, url: 'http://localhost:3000' })
      expect(env.sessions.s1.devPreviews).toEqual([
        { port: 3000, url: 'http://localhost:3000' },
      ])
    })

    it('removes the dev-preview entry matching the stopped port', () => {
      const env = makeAdapter({
        sessions: {
          s1: {
            sessionId: 's1',
            messages: [],
            devPreviews: [{ port: 3000, url: 'http://localhost:3000' }],
          },
        },
      })
      dispatch(env, { type: 'dev_preview_stopped', sessionId: 's1', port: 3000 })
      expect(env.sessions.s1.devPreviews).toEqual([])
    })
  })

  describe('web_feature_status', () => {
    it('replaces the flat webFeatures availability flags (booleans coerced)', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'web_feature_status', available: 1, remote: true, teleport: 0 })
      expect(env.flat.webFeatures).toEqual({ available: true, remote: true, teleport: false })
    })
  })

  describe('web_task_list', () => {
    it('replaces the flat web-task list', () => {
      const env = makeAdapter()
      const tasks = [{ taskId: 't1', status: 'running' }]
      dispatch(env, { type: 'web_task_list', tasks })
      expect(env.flat.webTasks).toEqual(tasks)
    })

    it('defaults to an empty list when tasks is not an array', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'web_task_list' })
      expect(env.flat.webTasks).toEqual([])
    })
  })

  // notification_prefs — slice-2 RECONCILE. The app previously hand-maintained
  // a byte-identical inline Zod parse; both clients now share
  // handleNotificationPrefs. These tests pin that UNIFIED behaviour.
  describe('notification_prefs (reconciled — app dropped its inline copy)', () => {
    it('stores the validated prefs snapshot, including optional bypassCategories', () => {
      const env = makeAdapter()
      dispatch(env, {
        type: 'notification_prefs',
        prefs: {
          categories: { permission: true, activity_error: false },
          devices: {},
          quietHours: null,
          bypassCategories: ['permission'],
        },
      })
      expect(env.flat.notificationPrefs).toMatchObject({
        categories: { permission: true, activity_error: false },
        devices: {},
        bypassCategories: ['permission'],
      })
    })

    it('omits bypassCategories from stored state when the server does not send it', () => {
      const env = makeAdapter()
      dispatch(env, {
        type: 'notification_prefs',
        prefs: { categories: { permission: true }, devices: {}, quietHours: null },
      })
      const stored = env.flat.notificationPrefs as Record<string, unknown>
      expect(stored).toBeDefined()
      expect('bypassCategories' in stored).toBe(false)
    })

    it('leaves state untouched on an invalid payload', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'notification_prefs', prefs: 'not-an-object' })
      expect(env.flat.notificationPrefs).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Slice 3 — file-ops / git wrapper cases (#5653)
  //
  // These route through `adapter.getCallback`: parse the wire message, then
  // invoke the registered imperative callback. A client whose adapter has no
  // `getCallback` (the dashboard) DECLINES — `runDispatch` returns false so the
  // caller falls through to its own switch.
  // -------------------------------------------------------------------------
  describe('file-ops / git wrapper cases', () => {
    it('declines (runDispatch false) when the adapter has no getCallback', () => {
      const env = makeAdapter() // no callbacks → no getCallback method
      expect(dispatch(env, { type: 'directory_listing', path: '/a' })).toBe(false)
      expect(dispatch(env, { type: 'git_status_result' })).toBe(false)
      expect(dispatch(env, { type: 'git_commit_result' })).toBe(false)
    })

    it('owns the message (runDispatch true) when getCallback is present, even with no registered callback', () => {
      // App opted in but nothing registered for this channel → no-op, still owned.
      const env = makeAdapter({ callbacks: {} })
      expect(dispatch(env, { type: 'directory_listing', path: '/a' })).toBe(true)
      expect(dispatch(env, { type: 'git_status_result' })).toBe(true)
    })

    it('invokes directoryListing with the parsed payload', () => {
      const seen: unknown[] = []
      const env = makeAdapter({ callbacks: { directoryListing: (p) => seen.push(p) } })
      expect(
        dispatch(env, {
          type: 'directory_listing',
          path: '/root',
          parentPath: '/',
          entries: [{ name: 'a' }],
        }),
      ).toBe(true)
      expect(seen).toEqual([
        { path: '/root', parentPath: '/', entries: [{ name: 'a' }], error: null },
      ])
    })

    it('invokes fileBrowser for file_listing', () => {
      const seen: unknown[] = []
      const env = makeAdapter({ callbacks: { fileBrowser: (p) => seen.push(p) } })
      dispatch(env, { type: 'file_listing', path: '/p', entries: [], error: 'oops' })
      expect(seen).toEqual([{ path: '/p', parentPath: null, entries: [], error: 'oops' }])
    })

    it('invokes fileContent for file_content', () => {
      const seen: unknown[] = []
      const env = makeAdapter({ callbacks: { fileContent: (p) => seen.push(p) } })
      dispatch(env, {
        type: 'file_content',
        path: '/f.ts',
        content: 'x',
        language: 'typescript',
        size: 1,
        truncated: true,
      })
      expect(seen).toEqual([
        { path: '/f.ts', content: 'x', language: 'typescript', size: 1, truncated: true, error: null },
      ])
    })

    it('invokes fileWrite for write_file_result', () => {
      const seen: unknown[] = []
      const env = makeAdapter({ callbacks: { fileWrite: (p) => seen.push(p) } })
      dispatch(env, { type: 'write_file_result', path: '/f.ts' })
      expect(seen).toEqual([{ path: '/f.ts', error: null }])
    })

    it('invokes diff with only files + error', () => {
      const seen: unknown[] = []
      const env = makeAdapter({ callbacks: { diff: (p) => seen.push(p) } })
      dispatch(env, { type: 'diff_result', files: [], error: null })
      expect(seen).toEqual([{ files: [], error: null }])
    })

    it('invokes gitStatus with the five-field payload', () => {
      const seen: unknown[] = []
      const env = makeAdapter({ callbacks: { gitStatus: (p) => seen.push(p) } })
      dispatch(env, {
        type: 'git_status_result',
        branch: 'main',
        staged: [{ path: 'a.ts', status: 'modified' }],
        unstaged: [{ path: 'b.ts', status: 'added' }],
        untracked: ['c.ts'],
        error: null,
      })
      expect(seen).toEqual([
        {
          branch: 'main',
          staged: [{ path: 'a.ts', status: 'modified' }],
          unstaged: [{ path: 'b.ts', status: 'added' }],
          untracked: ['c.ts'],
          error: null,
        },
      ])
    })

    it('invokes gitBranches with branches + currentBranch + error', () => {
      const seen: unknown[] = []
      const env = makeAdapter({ callbacks: { gitBranches: (p) => seen.push(p) } })
      dispatch(env, {
        type: 'git_branches_result',
        branches: [{ name: 'main', isCurrent: true, isRemote: false }],
        currentBranch: 'main',
      })
      expect(seen).toEqual([
        {
          branches: [{ name: 'main', isCurrent: true, isRemote: false }],
          currentBranch: 'main',
          error: null,
        },
      ])
    })

    it('routes both git_stage_result and git_unstage_result to gitStage', () => {
      const seen: unknown[] = []
      const env = makeAdapter({ callbacks: { gitStage: (p) => seen.push(p) } })
      dispatch(env, { type: 'git_stage_result' })
      dispatch(env, { type: 'git_unstage_result', error: 'nope' })
      expect(seen).toEqual([{ error: null }, { error: 'nope' }])
    })

    it('invokes gitCommit with hash + message + error', () => {
      const seen: unknown[] = []
      const env = makeAdapter({ callbacks: { gitCommit: (p) => seen.push(p) } })
      dispatch(env, { type: 'git_commit_result', hash: 'abc', message: 'feat: x' })
      expect(seen).toEqual([{ hash: 'abc', message: 'feat: x', error: null }])
    })
  })

  // -------------------------------------------------------------------------
  // Slice 4 — web-task upsert (#5556)
  //
  // `web_task_created` / `web_task_updated` filter-and-append the validated task
  // into the flat `webTasks` list via `adapter.updateState`. Both clients are a
  // table HIT (no decline). A malformed task payload is a no-op.
  // -------------------------------------------------------------------------
  describe('web_task_created / web_task_updated', () => {
    it('owns the message (runDispatch true) for both create and update', () => {
      const env = makeAdapter()
      expect(dispatch(env, { type: 'web_task_created', task: { taskId: 't1' } })).toBe(true)
      expect(dispatch(env, { type: 'web_task_updated', task: { taskId: 't1' } })).toBe(true)
    })

    it('appends a new task to the (empty) flat webTasks list', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'web_task_created', task: { taskId: 't1', status: 'running' } })
      expect(env.flat.webTasks).toEqual([{ taskId: 't1', status: 'running' }])
    })

    it('upserts (replaces) an existing task with the same taskId, preserving order of others', () => {
      const env = makeAdapter()
      // Pre-seed the flat list the read-modify-write upsert reads from.
      env.flat.webTasks = [
        { taskId: 't1', status: 'running' },
        { taskId: 't2', status: 'running' },
      ]
      dispatch(env, { type: 'web_task_updated', task: { taskId: 't1', status: 'completed' } })
      // t1 is dropped then re-appended at the end with its new status; t2 stays.
      expect(env.flat.webTasks).toEqual([
        { taskId: 't2', status: 'running' },
        { taskId: 't1', status: 'completed' },
      ])
    })

    it('is a no-op when the task payload is missing taskId', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'web_task_created', task: { status: 'running' } })
      expect(env.flat.webTasks).toBeUndefined()
    })

    it('is a no-op when the task payload is absent', () => {
      const env = makeAdapter()
      dispatch(env, { type: 'web_task_updated' })
      expect(env.flat.webTasks).toBeUndefined()
    })
  })
})
