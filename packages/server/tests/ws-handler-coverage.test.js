import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { createSpy, createMockSession, createMockSessionManager } from './test-helpers.js'

/**
 * Integration tests for untested WebSocket message handlers (#994).
 *
 * Pattern: create a mock ctx (matching the shape expected by handleSessionMessage),
 * call handleSessionMessage directly, and assert on the spies.
 */

function createMockCtx(sessionManager, opts = {}) {
  const broadcastSpy = createSpy()
  const sendSpy = createSpy()
  const updatePrimarySpy = createSpy()
  const sendSessionInfoSpy = createSpy()
  const replayHistorySpy = createSpy()
  const broadcastToSessionSpy = createSpy()
  const broadcastSessionListSpy = createSpy()

  const checkpointManager = {
    createCheckpoint: createSpy(async () => ({
      id: 'cp-1',
      name: 'test',
      description: 'test checkpoint',
      messageCount: 5,
      createdAt: Date.now(),
      gitRef: null,
    })),
    listCheckpoints: createSpy(() => []),
    deleteCheckpoint: createSpy(),
    restoreCheckpoint: createSpy(async () => ({})),
  }

  const devPreview = {
    closePreview: createSpy(),
  }

  const webTaskManager = {
    launchTask: createSpy(() => ({ taskId: 'task-1' })),
    listTasks: createSpy(() => []),
    teleportTask: createSpy(async () => {}),
  }

  return {
    sessionManager,
    broadcast: broadcastSpy,
    send: sendSpy,
    updatePrimary: updatePrimarySpy,
    sendSessionInfo: sendSessionInfoSpy,
    replayHistory: replayHistorySpy,
    broadcastToSession: broadcastToSessionSpy,
    broadcastSessionList: broadcastSessionListSpy,
    checkpointManager,
    devPreview,
    webTaskManager,
    primaryClients: new Map(),
    clients: new Map(),
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    pendingPermissions: new Map(),
    permissions: { resolvePermission: createSpy() },
    pushManager: null,
    fileOps: {},
    ...opts,
    _spies: {
      broadcast: broadcastSpy,
      send: sendSpy,
      updatePrimary: updatePrimarySpy,
      sendSessionInfo: sendSessionInfoSpy,
      replayHistory: replayHistorySpy,
      broadcastToSession: broadcastToSessionSpy,
      broadcastSessionList: broadcastSessionListSpy,
    },
  }
}

// ---------------------------------------------------------------------------
// resume_budget
// ---------------------------------------------------------------------------
describe('resume_budget handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    manager.isBudgetPaused = () => true
    manager.resumeBudget = createSpy()
    ctx = createMockCtx(manager)
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('broadcasts budget_resumed when session budget is paused', async () => {
    const msg = { type: 'resume_budget', sessionId: 'sess-1' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.resumeBudget.callCount, 1)
    assert.equal(ctx._spies.broadcastToSession.callCount, 1)
    const [sessionId, payload] = ctx._spies.broadcastToSession.lastCall
    assert.equal(sessionId, 'sess-1')
    assert.equal(payload.type, 'budget_resumed')
    assert.equal(payload.sessionId, 'sess-1')
  })

  it('does nothing when budget is not paused', async () => {
    ctx.sessionManager.isBudgetPaused = () => false
    const msg = { type: 'resume_budget', sessionId: 'sess-1' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.resumeBudget.callCount, 0)
    assert.equal(ctx._spies.broadcastToSession.callCount, 0)
  })

  it('sends error for invalid session', async () => {
    const msg = { type: 'resume_budget', sessionId: 'nonexistent' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx._spies.send.callCount, 1)
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /No valid session/)
  })
})

// ---------------------------------------------------------------------------
// create_session
// ---------------------------------------------------------------------------
describe('create_session handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    // createSession returns a new session id
    manager.createSession = createSpy(() => 'sess-new')
    // After creation, getSession should return the new entry
    const origGet = manager.getSession.bind(manager)
    const mockNewSession = createMockSession()
    mockNewSession.resumeSessionId = null
    manager.getSession = (id) => {
      if (id === 'sess-new') {
        return { session: mockNewSession, name: 'New Session', cwd: '/tmp/new' }
      }
      return origGet(id)
    }
    ctx = createMockCtx(manager)
    client = { id: 'client-A', activeSessionId: 'sess-1', subscribedSessionIds: new Set(['sess-1']) }
    ws = {}
  })

  it('creates a session and sends session_switched', async () => {
    const msg = { type: 'create_session', name: 'My Session' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.createSession.callCount, 1)
    assert.equal(client.activeSessionId, 'sess-new')
    assert.ok(client.subscribedSessionIds.has('sess-new'))

    // Should send session_switched
    const sendCalls = ctx._spies.send.calls
    const switchedMsg = sendCalls.find(c => c[1].type === 'session_switched')
    assert.ok(switchedMsg, 'should send session_switched')
    assert.equal(switchedMsg[1].sessionId, 'sess-new')
  })

  it('rejects CWD outside home directory', async () => {
    const msg = { type: 'create_session', cwd: '/etc/passwd' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.createSession.callCount, 0)
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
  })

  it('rejects nonexistent CWD', async () => {
    const msg = { type: 'create_session', cwd: '/tmp/definitely-does-not-exist-xyz123' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.createSession.callCount, 0)
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /does not exist/)
  })

  it('sends error when createSession throws', async () => {
    ctx.sessionManager.createSession = createSpy(() => { throw new Error('limit reached') })
    const msg = { type: 'create_session' }
    await handleSessionMessage(ws, client, msg, ctx)

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /limit reached/)
  })

  it('rejects worktree without explicit cwd', async () => {
    const msg = { type: 'create_session', name: 'Isolated', worktree: true }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.createSession.callCount, 0, 'should not create session')
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /worktree requires an explicit cwd/)
  })

  it('rejects worktree with empty string cwd', async () => {
    const msg = { type: 'create_session', name: 'Isolated', cwd: '  ', worktree: true }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.createSession.callCount, 0, 'should not create session')
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /worktree requires an explicit cwd/)
  })

  it('allows worktree with explicit cwd', async () => {
    const msg = { type: 'create_session', name: 'Isolated', cwd: homedir(), worktree: true }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.createSession.callCount, 1, 'should create session')
    const args = ctx.sessionManager.createSession.lastCall[0]
    assert.equal(args.worktree, true)
    assert.equal(args.cwd, homedir())
  })
})

// ---------------------------------------------------------------------------
// destroy_session
// ---------------------------------------------------------------------------
describe('destroy_session handler', () => {
  let ctx, client, ws, manager

  beforeEach(() => {
    const result = createMockSessionManager([
      { id: 'sess-1', name: 'First', cwd: '/tmp' },
      { id: 'sess-2', name: 'Second', cwd: '/tmp' },
    ])
    manager = result.manager
    manager.destroySession = createSpy()
    ctx = createMockCtx(manager)
    // Simulate a connected client
    const clientWs = {}
    const clientData = { id: 'client-A', activeSessionId: 'sess-2', authenticated: true, subscribedSessionIds: new Set(['sess-1', 'sess-2']) }
    ctx.clients.set(clientWs, clientData)
    client = clientData
    ws = clientWs
  })

  it('destroys session and broadcasts session_destroyed + session_list', async () => {
    const msg = { type: 'destroy_session', sessionId: 'sess-2' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(manager.destroySession.callCount, 1)
    assert.deepEqual(manager.destroySession.lastCall, ['sess-2'])

    // Should broadcast session_destroyed and session_list
    const broadcastCalls = ctx._spies.broadcast.calls
    const destroyedMsg = broadcastCalls.find(c => c[0].type === 'session_destroyed')
    assert.ok(destroyedMsg, 'should broadcast session_destroyed')
    assert.equal(destroyedMsg[0].sessionId, 'sess-2')

    const listMsg = broadcastCalls.find(c => c[0].type === 'session_list')
    assert.ok(listMsg, 'should broadcast session_list')
  })

  it('refuses to destroy last session', async () => {
    // Remove one session so only one remains
    const { manager: singleManager } = createMockSessionManager([
      { id: 'sess-1', name: 'Only', cwd: '/tmp' },
    ])
    singleManager.destroySession = createSpy()
    ctx = createMockCtx(singleManager)

    const msg = { type: 'destroy_session', sessionId: 'sess-1' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(singleManager.destroySession.callCount, 0)
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /last session/)
  })

  it('sends error for nonexistent session', async () => {
    const msg = { type: 'destroy_session', sessionId: 'nonexistent' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(manager.destroySession.callCount, 0)
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /not found/)
  })
})

// ---------------------------------------------------------------------------
// rename_session
// ---------------------------------------------------------------------------
describe('rename_session handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Old Name', cwd: '/tmp' },
    ])
    manager.renameSession = createSpy(() => true)
    ctx = createMockCtx(manager)
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('renames session and broadcasts session_list', async () => {
    const msg = { type: 'rename_session', sessionId: 'sess-1', name: 'New Name' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.renameSession.callCount, 1)
    assert.deepEqual(ctx.sessionManager.renameSession.lastCall, ['sess-1', 'New Name'])

    const broadcastCalls = ctx._spies.broadcast.calls
    const listMsg = broadcastCalls.find(c => c[0].type === 'session_list')
    assert.ok(listMsg, 'should broadcast session_list')
  })

  it('sends error when name is empty', async () => {
    const msg = { type: 'rename_session', sessionId: 'sess-1', name: '   ' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.sessionManager.renameSession.callCount, 0)
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /Name is required/)
  })

  it('sends error when session not found', async () => {
    ctx.sessionManager.renameSession = createSpy(() => false)
    const msg = { type: 'rename_session', sessionId: 'nonexistent', name: 'Test' }
    await handleSessionMessage(ws, client, msg, ctx)

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /not found/)
  })
})

// ---------------------------------------------------------------------------
// request_full_history
// ---------------------------------------------------------------------------
describe('request_full_history handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    manager.getFullHistoryAsync = async () => [
      { type: 'user_input', content: 'hello', timestamp: 1000 },
      { type: 'response', content: 'world', timestamp: 2000 },
      { type: 'tool_use', content: 'bash', tool: 'bash', timestamp: 3000 },
      { type: 'status', status: 'idle', timestamp: 4000 },
    ]
    ctx = createMockCtx(manager)
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('replays full history with start/end markers', async () => {
    const msg = { type: 'request_full_history', sessionId: 'sess-1' }
    await handleSessionMessage(ws, client, msg, ctx)

    const sendCalls = ctx._spies.send.calls
    // Should have: history_replay_start + 4 messages + history_replay_end = 6
    assert.equal(sendCalls.length, 6)

    assert.equal(sendCalls[0][1].type, 'history_replay_start')
    assert.equal(sendCalls[0][1].fullHistory, true)
    assert.equal(sendCalls[0][1].sessionId, 'sess-1')

    // user_input, response, tool_use get wrapped as 'message'
    assert.equal(sendCalls[1][1].type, 'message')
    assert.equal(sendCalls[1][1].messageType, 'user_input')
    assert.equal(sendCalls[1][1].content, 'hello')

    assert.equal(sendCalls[2][1].type, 'message')
    assert.equal(sendCalls[2][1].messageType, 'response')

    assert.equal(sendCalls[3][1].type, 'message')
    assert.equal(sendCalls[3][1].messageType, 'tool_use')
    assert.equal(sendCalls[3][1].tool, 'bash')

    // Non-standard types are passed through as-is with sessionId added
    assert.equal(sendCalls[4][1].type, 'status')
    assert.equal(sendCalls[4][1].sessionId, 'sess-1')

    assert.equal(sendCalls[5][1].type, 'history_replay_end')
    assert.equal(sendCalls[5][1].sessionId, 'sess-1')
  })

  it('sends error for nonexistent session', async () => {
    const msg = { type: 'request_full_history', sessionId: 'nonexistent' }
    await handleSessionMessage(ws, client, msg, ctx)

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /not found/)
  })

  it('uses active session when sessionId is not provided', async () => {
    const msg = { type: 'request_full_history' }
    await handleSessionMessage(ws, client, msg, ctx)

    const sendCalls = ctx._spies.send.calls
    assert.equal(sendCalls[0][1].type, 'history_replay_start')
    assert.equal(sendCalls[0][1].sessionId, 'sess-1')
  })
})

// ---------------------------------------------------------------------------
// create_checkpoint
// ---------------------------------------------------------------------------
describe('create_checkpoint handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    // Set resumeSessionId on the mock session
    const entry = sessionsMap.get('sess-1')
    entry.session.resumeSessionId = 'conv-uuid-123'
    manager.getHistoryCount = createSpy(() => 10)
    ctx = createMockCtx(manager)
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('creates checkpoint and sends checkpoint_created', async () => {
    const msg = { type: 'create_checkpoint', name: 'Before refactor', description: 'Safe point' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.checkpointManager.createCheckpoint.callCount, 1)
    const callArgs = ctx.checkpointManager.createCheckpoint.lastCall[0]
    assert.equal(callArgs.sessionId, 'sess-1')
    assert.equal(callArgs.resumeSessionId, 'conv-uuid-123')
    assert.equal(callArgs.name, 'Before refactor')
    assert.equal(callArgs.description, 'Safe point')

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'checkpoint_created')
    assert.equal(payload.sessionId, 'sess-1')
    assert.equal(payload.checkpoint.id, 'cp-1')
  })

  it('sends error when no resumeSessionId', async () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    // resumeSessionId is undefined by default
    ctx = createMockCtx(manager)
    const msg = { type: 'create_checkpoint' }
    await handleSessionMessage(ws, client, msg, ctx)

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /before first message/)
  })

  it('sends error when no active session', async () => {
    client.activeSessionId = null
    const msg = { type: 'create_checkpoint' }
    await handleSessionMessage(ws, client, msg, ctx)

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'session_error')
    assert.match(payload.message, /No active session/)
  })
})

// ---------------------------------------------------------------------------
// list_checkpoints
// ---------------------------------------------------------------------------
describe('list_checkpoints handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    ctx = createMockCtx(manager)
    ctx.checkpointManager.listCheckpoints = createSpy(() => [
      { id: 'cp-1', name: 'First', createdAt: 1000 },
      { id: 'cp-2', name: 'Second', createdAt: 2000 },
    ])
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('returns checkpoint list for active session', async () => {
    const msg = { type: 'list_checkpoints' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.checkpointManager.listCheckpoints.callCount, 1)
    assert.deepEqual(ctx.checkpointManager.listCheckpoints.lastCall, ['sess-1'])

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'checkpoint_list')
    assert.equal(payload.sessionId, 'sess-1')
    assert.equal(payload.checkpoints.length, 2)
  })

  it('returns empty list when no active session', async () => {
    client.activeSessionId = null
    const msg = { type: 'list_checkpoints' }
    await handleSessionMessage(ws, client, msg, ctx)

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'checkpoint_list')
    assert.equal(payload.sessionId, null)
    assert.equal(payload.checkpoints.length, 0)
  })
})

// ---------------------------------------------------------------------------
// delete_checkpoint
// ---------------------------------------------------------------------------
describe('delete_checkpoint handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    ctx = createMockCtx(manager)
    ctx.checkpointManager.deleteCheckpoint = createSpy()
    ctx.checkpointManager.listCheckpoints = createSpy(() => [])
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('deletes checkpoint and sends updated list', async () => {
    const msg = { type: 'delete_checkpoint', checkpointId: 'cp-1' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.checkpointManager.deleteCheckpoint.callCount, 1)
    assert.deepEqual(ctx.checkpointManager.deleteCheckpoint.lastCall, ['sess-1', 'cp-1'])

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'checkpoint_list')
    assert.equal(payload.sessionId, 'sess-1')
  })

  it('does nothing when no active session', async () => {
    client.activeSessionId = null
    const msg = { type: 'delete_checkpoint', checkpointId: 'cp-1' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.checkpointManager.deleteCheckpoint.callCount, 0)
    assert.equal(ctx._spies.send.callCount, 0)
  })

  it('does nothing when checkpointId is missing', async () => {
    const msg = { type: 'delete_checkpoint' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.checkpointManager.deleteCheckpoint.callCount, 0)
  })
})

// ---------------------------------------------------------------------------
// close_dev_preview
// ---------------------------------------------------------------------------
describe('close_dev_preview handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    ctx = createMockCtx(manager)
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('calls closePreview with session and port', async () => {
    const msg = { type: 'close_dev_preview', sessionId: 'sess-1', port: 3000 }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.devPreview.closePreview.callCount, 1)
    assert.deepEqual(ctx.devPreview.closePreview.lastCall, ['sess-1', 3000])
  })

  it('uses active session when sessionId not provided', async () => {
    const msg = { type: 'close_dev_preview', port: 8080 }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.devPreview.closePreview.callCount, 1)
    assert.deepEqual(ctx.devPreview.closePreview.lastCall, ['sess-1', 8080])
  })

  it('does nothing when port is not a number', async () => {
    const msg = { type: 'close_dev_preview', port: 'abc' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.devPreview.closePreview.callCount, 0)
  })
})

// ---------------------------------------------------------------------------
// launch_web_task
// ---------------------------------------------------------------------------
describe('launch_web_task handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    ctx = createMockCtx(manager)
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('launches a task with prompt', async () => {
    const msg = { type: 'launch_web_task', prompt: 'fix the bug' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.webTaskManager.launchTask.callCount, 1)
    assert.equal(ctx.webTaskManager.launchTask.lastCall[0], 'fix the bug')
  })

  it('rejects CWD outside home directory', async () => {
    const msg = { type: 'launch_web_task', prompt: 'test', cwd: '/etc' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx.webTaskManager.launchTask.callCount, 0)
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'web_task_error')
  })

  it('sends error when launchTask throws', async () => {
    ctx.webTaskManager.launchTask = createSpy(() => { throw new Error('no slots') })
    const msg = { type: 'launch_web_task', prompt: 'test' }
    await handleSessionMessage(ws, client, msg, ctx)

    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'web_task_error')
    assert.match(payload.message, /no slots/)
  })
})

// ---------------------------------------------------------------------------
// list_web_tasks
// ---------------------------------------------------------------------------
describe('list_web_tasks handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    ctx = createMockCtx(manager)
    ctx.webTaskManager.listTasks = createSpy(() => [
      { taskId: 'task-1', status: 'running' },
      { taskId: 'task-2', status: 'done' },
    ])
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('returns task list', async () => {
    const msg = { type: 'list_web_tasks' }
    await handleSessionMessage(ws, client, msg, ctx)

    assert.equal(ctx._spies.send.callCount, 1)
    const [, payload] = ctx._spies.send.lastCall
    assert.equal(payload.type, 'web_task_list')
    assert.equal(payload.tasks.length, 2)
    assert.equal(payload.tasks[0].taskId, 'task-1')
  })
})

// ---------------------------------------------------------------------------
// teleport_web_task
// ---------------------------------------------------------------------------
describe('teleport_web_task handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Test', cwd: '/tmp' },
    ])
    ctx = createMockCtx(manager)
    client = { id: 'client-A', activeSessionId: 'sess-1' }
    ws = {}
  })

  it('teleports task and sends server_status on success', async () => {
    ctx.webTaskManager.teleportTask = createSpy(async () => {})
    const msg = { type: 'teleport_web_task', taskId: 'task-1' }
    await handleSessionMessage(ws, client, msg, ctx)

    // teleportTask returns a promise; wait for it
    assert.equal(ctx.webTaskManager.teleportTask.callCount, 1)
    assert.equal(ctx.webTaskManager.teleportTask.lastCall[0], 'task-1')

    // The handler uses .then/.catch so we need to wait a tick for the promise chain
    await new Promise(r => setTimeout(r, 10))

    const sendCalls = ctx._spies.send.calls
    const statusMsg = sendCalls.find(c => c[1].type === 'server_status')
    assert.ok(statusMsg, 'should send server_status')
    assert.match(statusMsg[1].message, /teleported/)
  })

  it('sends web_task_error on failure', async () => {
    ctx.webTaskManager.teleportTask = createSpy(async () => { throw new Error('not found') })
    const msg = { type: 'teleport_web_task', taskId: 'task-99' }
    await handleSessionMessage(ws, client, msg, ctx)

    await new Promise(r => setTimeout(r, 10))

    const sendCalls = ctx._spies.send.calls
    const errorMsg = sendCalls.find(c => c[1].type === 'web_task_error')
    assert.ok(errorMsg, 'should send web_task_error')
    assert.equal(errorMsg[1].taskId, 'task-99')
    assert.match(errorMsg[1].message, /not found/)
  })
})
