import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BaseSession } from '../src/base-session.js'

describe('BaseSession', () => {
  let session
  let emptySkillsDir

  beforeEach(() => {
    // Pin skillsDir + repoSkillsDir to empty temp dirs so the tests don't
    // pick up whatever lives in the developer's real ~/.chroxy/skills/ (#3067).
    // cwd: '/tmp' is also passed repoSkillsDir: null to bypass walk-up.
    emptySkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-base-skills-'))
    session = new BaseSession({
      cwd: '/tmp',
      model: 'test-model',
      permissionMode: 'approve',
      skillsDir: emptySkillsDir,
      repoSkillsDir: null,
    })
  })

  afterEach(() => {
    if (emptySkillsDir) rmSync(emptySkillsDir, { recursive: true, force: true })
    emptySkillsDir = null
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

  describe('_buildSystemPrompt', () => {
    it('returns empty string when no skills are loaded', () => {
      session._skillsText = ''
      assert.equal(session._buildSystemPrompt(), '')
    })

    it('returns formatted skills text when skills are loaded', () => {
      session._skillsText = '# Skill: foo\n\nbody text'
      const out = session._buildSystemPrompt()
      assert.ok(out.includes('body text'))
    })
  })

  describe('_getSkills', () => {
    it('returns empty array by default (no skills loaded)', () => {
      assert.deepEqual(session._getSkills(), [])
    })

    it('returns cached skills when set', () => {
      session._skills = [{ name: 'a', body: 'x', description: 'x' }]
      const out = session._getSkills()
      assert.equal(out.length, 1)
      assert.equal(out[0].name, 'a')
    })
  })
})
