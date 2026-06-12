import { describe, it, expect } from 'vitest'
import {
  createDispatchTable,
  runDispatch,
  DISPATCH_TABLE_TYPES,
  type ClientStoreAdapter,
} from './dispatch-table'
import type { ChatMessage, SessionInfo } from './types'
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
  [k: string]: unknown
}

function makeAdapter(init?: {
  activeSessionId?: string | null
  sessions?: Record<string, FakeSession>
  sessionList?: SessionInfo[]
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
    addMessage: (m) => addedMessages.push(m),
    getSessions: () => sessionList,
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
})
