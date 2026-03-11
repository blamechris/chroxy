import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { BaseSession } from '../src/base-session.js'

describe('BaseSession', () => {
  let session

  beforeEach(() => {
    session = new BaseSession({ cwd: '/tmp', model: 'test-model', permissionMode: 'approve' })
  })

  describe('constructor defaults', () => {
    it('sets cwd, model, permissionMode from options', () => {
      assert.equal(session.cwd, '/tmp')
      assert.equal(session.model, 'test-model')
      assert.equal(session.permissionMode, 'approve')
    })

    it('defaults cwd to process.cwd()', () => {
      const s = new BaseSession()
      assert.equal(s.cwd, process.cwd())
    })

    it('initializes state flags', () => {
      assert.equal(session._isBusy, false)
      assert.equal(session._processReady, false)
      assert.equal(session._messageCounter, 0)
      assert.equal(session._currentMessageId, null)
      assert.equal(session._destroying, false)
      assert.equal(session._activeAgents.size, 0)
      assert.equal(session._resultTimeout, null)
    })
  })

  describe('isRunning', () => {
    it('returns _isBusy', () => {
      assert.equal(session.isRunning, false)
      session._isBusy = true
      assert.equal(session.isRunning, true)
    })
  })

  describe('isReady', () => {
    it('returns true only when process is ready and not busy', () => {
      assert.equal(session.isReady, false)
      session._processReady = true
      assert.equal(session.isReady, true)
      session._isBusy = true
      assert.equal(session.isReady, false)
    })
  })

  describe('setModel', () => {
    it('returns false when busy', () => {
      session._isBusy = true
      assert.equal(session.setModel('new-model'), false)
    })

    it('returns false when model unchanged', () => {
      session.model = null
      assert.equal(session.setModel(null), false)
    })

    it('returns true and updates model when changed', () => {
      session.model = null
      const result = session.setModel('claude-sonnet-4-5-20250514')
      assert.equal(result, true)
      assert.equal(session.model, 'claude-sonnet-4-5-20250514')
    })
  })

  describe('setPermissionMode', () => {
    it('returns false for invalid modes', () => {
      assert.equal(session.setPermissionMode('invalid'), false)
    })

    it('returns false when busy', () => {
      session._isBusy = true
      assert.equal(session.setPermissionMode('auto'), false)
    })

    it('returns false when unchanged', () => {
      session.permissionMode = 'approve'
      assert.equal(session.setPermissionMode('approve'), false)
    })

    it('returns true and updates when changed', () => {
      assert.equal(session.setPermissionMode('auto'), true)
      assert.equal(session.permissionMode, 'auto')
    })

    it('accepts all valid modes', () => {
      for (const mode of ['approve', 'auto', 'plan', 'acceptEdits']) {
        session.permissionMode = 'other'
        assert.equal(session.setPermissionMode(mode), true)
      }
    })
  })

  describe('_clearMessageState', () => {
    it('resets busy and message state', () => {
      session._isBusy = true
      session._currentMessageId = 'msg-1'
      session._clearMessageState()
      assert.equal(session._isBusy, false)
      assert.equal(session._currentMessageId, null)
    })

    it('emits agent_completed for active agents', () => {
      const completed = []
      session.on('agent_completed', (e) => completed.push(e))
      session._activeAgents.set('a1', { toolUseId: 'a1' })
      session._activeAgents.set('a2', { toolUseId: 'a2' })
      session._clearMessageState()
      assert.equal(completed.length, 2)
      assert.deepEqual(completed.map(c => c.toolUseId), ['a1', 'a2'])
      assert.equal(session._activeAgents.size, 0)
    })

    it('clears result timeout', () => {
      session._resultTimeout = setTimeout(() => {}, 10000)
      session._clearMessageState()
      assert.equal(session._resultTimeout, null)
    })
  })

  describe('EventEmitter', () => {
    it('is an EventEmitter', () => {
      assert.equal(typeof session.on, 'function')
      assert.equal(typeof session.emit, 'function')
    })
  })
})
