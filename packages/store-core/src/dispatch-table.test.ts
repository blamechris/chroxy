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
}) {
  const sessions: Record<string, FakeSession> = init?.sessions ?? {}
  let activeSessionId = init?.activeSessionId ?? null
  let sessionList: SessionInfo[] = init?.sessionList ?? []
  const flat: Record<string, unknown> = {}
  const addedMessages: ChatMessage[] = []

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
    ...(init?.callbacks
      ? {
          getCallback: ((name: string) =>
            (init.callbacks?.[name] ?? null)) as ClientStoreAdapter<FakeSession>['getCallback'],
        }
      : {}),
  }

  return {
    adapter,
    sessions,
    flat,
    addedMessages,
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
      expect(dispatch(env, { type: 'model_changed', model: 'opus' })).toBe(false)
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
