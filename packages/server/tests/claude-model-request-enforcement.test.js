import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { SessionManager, ProviderModelNotSupportedError } from '../src/session-manager.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { transcriptPathForSessionFile } from '../src/transcript-tasks.js'
import {
  classifyClaudeModelRequest,
  claudeModelMatchesRequest,
  buildModelEvidence,
  MODEL_MISMATCH_CODE,
} from '../src/claude-model-request.js'

/**
 * #7855 — selection ENFORCEMENT for a requested Claude model.
 *
 * Before: an id the static roster did not list was silently turned into `null`
 * (the account default) at session create. A session asked for
 * `claude-sonnet-5` started on whatever the account default was, and nothing
 * said so. Now: a well-formed off-roster id is forwarded verbatim; an id that
 * cannot be a Claude model is rejected; and what the native journal later shows
 * is kept apart from what was requested.
 *
 * Roster-vs-wire discovery (#7348), reporting (#7327/#8048) and roster tagging
 * (#7756) are NOT re-tested here.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

let tmpRoot
before(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'chroxy-7855-')) })
after(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

let stateCounter = 0
function stateFile() { return join(tmpRoot, `state-${stateCounter++}.json`) }

describe('classifyClaudeModelRequest (#7855)', () => {
  const roster = ['sonnet', 'claude-sonnet-4-6', 'opus']

  it('roster member -> roster', () => {
    assert.deepEqual(classifyClaudeModelRequest('opus', roster), { kind: 'roster', model: 'opus' })
  })

  it('well-formed off-roster ids -> native, verbatim', () => {
    for (const id of ['claude-sonnet-5', 'claude-opus-5[1m]', 'claude-haiku-5-20261001', 'haiku', 'opus[1m]', 'opusplan']) {
      assert.deepEqual(classifyClaudeModelRequest(id, roster), { kind: 'native', model: id }, id)
    }
  })

  it('ids that cannot be a Claude model -> invalid', () => {
    const tooLong = 'claude-' + 'a'.repeat(120)
    for (const id of ['opus-4-6', 'gpt-5', '--model', '-x', 'claude-', 'claude-opus 5', 'claude-opus;rm', '../claude-opus', '', null, undefined, 7, tooLong]) {
      assert.equal(classifyClaudeModelRequest(id, roster).kind, 'invalid', String(id))
    }
  })
})

describe('claudeModelMatchesRequest (#7855)', () => {
  it('matches exact, [1m], date-pinned and alias-to-family observations', () => {
    assert.equal(claudeModelMatchesRequest('claude-sonnet-5', 'claude-sonnet-5'), true)
    assert.equal(claudeModelMatchesRequest('claude-sonnet-5', 'claude-sonnet-5[1m]'), true)
    assert.equal(claudeModelMatchesRequest('claude-sonnet-5', 'claude-sonnet-5-20261001'), true)
    assert.equal(claudeModelMatchesRequest('sonnet', 'claude-sonnet-5'), true)
    assert.equal(claudeModelMatchesRequest('opus[1m]', 'claude-opus-5'), true)
  })

  it('resolves roster short ids through the catalog, not a hand-prefix (S1)', () => {
    assert.equal(claudeModelMatchesRequest('sonnet-5-5', 'claude-sonnet-5-5'), true)
    assert.equal(claudeModelMatchesRequest('fable-5-1', 'claude-fable-5-1'), true)
    assert.equal(claudeModelMatchesRequest('fable', 'claude-fable-5'), true)
    assert.equal(claudeModelMatchesRequest('fable[1m]', 'claude-fable-5[1m]'), true)
    assert.equal(claudeModelMatchesRequest('opus-5-5[1m]', 'claude-opus-5-5'), true)
    assert.equal(claudeModelMatchesRequest('sonnet-5-5', 'claude-sonnet-5-5-20261001'), true)
    assert.equal(claudeModelMatchesRequest('sonnet-5-5', 'claude-opus-5-5'), false)
    assert.equal(claudeModelMatchesRequest('fable-5-1', 'claude-fable-5'), false)
    assert.equal(classifyClaudeModelRequest('fable', []).kind, 'native')
  })

  it('rejects a different model, including a longer id that merely shares a prefix', () => {
    assert.equal(claudeModelMatchesRequest('claude-sonnet-5', 'claude-opus-5[1m]'), false)
    assert.equal(claudeModelMatchesRequest('sonnet', 'claude-opus-5'), false)
    assert.equal(claudeModelMatchesRequest('claude-sonnet-5', 'claude-sonnet-5-5'), false)
    assert.equal(claudeModelMatchesRequest('claude-sonnet-5', null), false)
  })
})

describe('buildModelEvidence (#7855)', () => {
  it('a configured value alone is unobserved, never a match', () => {
    const e = buildModelEvidence({ requested: 'claude-sonnet-5', observed: null, observedAt: null })
    assert.equal(e.status, 'unobserved')
    assert.equal(e.observed, null)
    assert.equal(e.observedSource, null)
    assert.equal(e.requestedSource, 'create_request')
  })

  it('carries source and freshness for an observation', () => {
    const e = buildModelEvidence({ requested: 'claude-sonnet-5', observed: 'claude-opus-5[1m]', observedAt: 1_000, now: 4_500 })
    assert.equal(e.status, 'mismatch')
    assert.equal(e.observedSource, 'native_journal')
    assert.equal(e.observedAgeMs, 3_500)
  })
})

describe('registered claude-tui create path (#7855)', () => {
  let mgr
  beforeEach(() => {
    mgr = new SessionManager({
      maxSessions: 3,
      stateFilePath: stateFile(),
      defaultCwd: tmpdir(),
      providerType: 'claude-tui',
      skipPreflight: true,
    })
  })

  it('keeps an off-roster but well-formed model verbatim instead of defaulting it', () => {
    const plan = mgr._resolveCreateSessionPlan({ model: 'claude-sonnet-5-offroster-7855' })
    assert.equal(plan.resolvedModel, 'claude-sonnet-5-offroster-7855')
  })

  it('rejects an explicit invalid model with a structured error, not a silent default', () => {
    assert.throws(
      () => mgr._resolveCreateSessionPlan({ model: 'opus-4-6' }),
      (err) => {
        assert.ok(err instanceof ProviderModelNotSupportedError, `got ${err?.name}`)
        assert.equal(err.code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
        assert.equal(err.model, 'opus-4-6')
        assert.ok(err.supported.length > 0, 'the rejection lists what is supported')
        return true
      },
    )
    assert.equal(mgr.listSessions().length, 0)
  })

  it('refuses an option-shaped model rather than letting it reach argv', () => {
    assert.throws(
      () => mgr._resolveCreateSessionPlan({ model: '--dangerously-skip-permissions' }),
      ProviderModelNotSupportedError,
    )
  })

  it('a restore of a snapshot with a malformed model still degrades to the provider default (#3403)', () => {
    const plan = mgr._resolveCreateSessionPlan({ model: 'opus-4-6', isRestore: true })
    assert.equal(plan.resolvedModel, null)
  })

  it('a malformed CONFIGURED default (nobody asked for it by name) still degrades to the provider default', () => {
    const configured = new SessionManager({
      maxSessions: 3,
      stateFilePath: stateFile(),
      defaultCwd: tmpdir(),
      defaultModel: 'opus-4-6',
      providerType: 'claude-tui',
      skipPreflight: true,
    })
    assert.equal(configured._resolveCreateSessionPlan({}).resolvedModel, null)
  })
})

describe('ClaudeTuiSession requested vs observed model (#7855)', () => {
  let fakeHome
  let origHome
  let origUserProfile
  let fakeCwd
  let skillsDir
  let session
  const fakePid = 2 ** 30

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-7855-home-'))
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    fakeCwd = join(tmpdir(), 'chroxy-7855-fake-cwd')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-7855-skills-'))
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } }
    session = null
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile
    else delete process.env.USERPROFILE
    if (__sandboxConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(skillsDir, { recursive: true, force: true })
  })

  function make(opts = {}) {
    const s = new ClaudeTuiSession({ cwd: fakeCwd, skillsDir, repoSkillsDir: null, ...opts })
    const errors = []
    s.on('error', (e) => errors.push(e))
    s._term = { pid: fakePid, write: () => {}, kill: () => {} }
    s._processReady = true
    s._sessionId = 'uuid-7855'
    session = s
    return { s, errors }
  }

  function journal(model) {
    const sessFile = join(fakeHome, '.claude', 'sessions', `${fakePid}.json`)
    writeFileSync(sessFile, JSON.stringify({ pid: fakePid, sessionId: 'uuid-7855', cwd: fakeCwd, startedAt: Date.now() }))
    const path = transcriptPathForSessionFile(sessFile)
    mkdirSync(dirname(path), { recursive: true })
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model }
    writeFileSync(path, JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T02:39:05.423Z', message }) + '\n')
  }

  it('forwards the exact off-roster model to the native client as --model, without touching claude settings', async () => {
    const { s } = make({ model: 'claude-sonnet-5', port: 15990, cwd: tmpdir() })
    s._conversationPersisted = () => true
    s._settingsPath = join(fakeHome, 'chroxy-settings.json')
    s._buildCombinedSkillsPrefix = () => ''
    let captured = null
    s._ptyModOverride = { spawn: (_c, args) => { captured = args; throw new Error('captured-and-bail') } }
    await s._spawnPty(true)
    const i = captured.indexOf('--model')
    assert.ok(i >= 0, 'argv carries --model')
    assert.equal(captured[i + 1], 'claude-sonnet-5')
    // The model is per-spawn argv only: claude's own global settings are never created or edited.
    assert.equal(existsSync(join(fakeHome, '.claude', 'settings.json')), false)
  })

  it('is unobserved (not a match) before the journal says anything', () => {
    const { s, errors } = make({ model: 'claude-sonnet-5' })
    const e = s.modelEvidence
    assert.equal(e.requested, 'claude-sonnet-5')
    assert.equal(e.status, 'unobserved')
    assert.equal(e.observed, null)
    s._clearTurnEndState()
    assert.equal(s.modelEvidence.status, 'unobserved')
    assert.equal(errors.length, 0)
  })

  it('a pre-seeded (restored) bootedModel is not treated as a fresh observation', () => {
    const { s } = make({ model: 'claude-sonnet-5' })
    s.bootedModel = 'claude-opus-5[1m]'
    assert.equal(s.modelEvidence.status, 'unobserved')
    assert.equal(s.modelEvidence.observed, null)
  })

  it('a matching native boot is reported as match and raises no notice', () => {
    const { s, errors } = make({ model: 'claude-sonnet-5' })
    journal('claude-sonnet-5')
    s._clearTurnEndState()
    const e = s.modelEvidence
    assert.equal(e.status, 'match')
    assert.equal(e.observed, 'claude-sonnet-5')
    assert.equal(e.observedSource, 'native_journal')
    assert.equal(typeof e.observedAgeMs, 'number')
    assert.equal(errors.length, 0)
  })

  it('a mismatched native boot is reported as mismatch and surfaced once as MODEL_MISMATCH', () => {
    const { s, errors } = make({ model: 'claude-sonnet-5' })
    journal('claude-opus-5[1m]')
    s._clearTurnEndState()
    s._clearTurnEndState()
    const e = s.modelEvidence
    assert.equal(e.status, 'mismatch')
    assert.equal(e.requested, 'claude-sonnet-5')
    assert.equal(e.observed, 'claude-opus-5[1m]')
    const notices = errors.filter((x) => x.code === MODEL_MISMATCH_CODE)
    assert.equal(notices.length, 1, 'a steady mismatch is reported once, not every turn')
    assert.match(notices[0].message, /claude-sonnet-5/)
    assert.match(notices[0].message, /claude-opus-5/)
  })

  it('a short roster id request does not raise a spurious mismatch (S1)', () => {
    const { s, errors } = make({ model: 'sonnet-5-5' })
    journal('claude-sonnet-5-5')
    s._clearTurnEndState()
    assert.equal(s.modelEvidence.status, 'match')
    assert.equal(errors.length, 0)
  })

  it('a restored bootedModel later confirmed by the journal becomes observed, and stays fresh (Copilot)', () => {
    const { s } = make({ model: 'claude-sonnet-5' })
    s.bootedModel = 'claude-sonnet-5'
    assert.equal(s.modelEvidence.status, 'unobserved')
    journal('claude-sonnet-5')
    s._clearTurnEndState()
    assert.equal(s.modelEvidence.status, 'match', 'same string as the restored value, now journal-confirmed')
    const first = s._observedModelAt
    s._observedModelAt = first - 5000
    s._adoptObservedModel('claude-sonnet-5')
    assert.ok(s._observedModelAt > first - 5000, 'a repeat observation refreshes the freshness stamp')
    s._adoptObservedModel(null)
    assert.equal(s.bootedModel, 'claude-sonnet-5', 'a falsy observation never clobbers bootedModel')
  })

  it('the mismatch message does not blame the request (S3)', () => {
    const { s, errors } = make({ model: 'claude-sonnet-5' })
    journal('claude-opus-5[1m]')
    s._clearTurnEndState()
    const n = errors.find((x) => x.code === MODEL_MISMATCH_CODE)
    assert.doesNotMatch(n.message, /not honoured/)
    assert.match(n.message, /running 'claude-opus-5\[1m\]'/)
  })

  it('no requested model: an observation is just an observation', () => {
    const { s, errors } = make()
    journal('claude-opus-5[1m]')
    s._clearTurnEndState()
    assert.equal(s.modelEvidence.requested, null)
    assert.equal(s.modelEvidence.status, 'observed')
    assert.equal(errors.length, 0)
  })
})
