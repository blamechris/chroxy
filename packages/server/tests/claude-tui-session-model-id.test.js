import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { resolveClaudeCliModelId, CLAUDE_FALLBACK_MODELS } from '../src/claude-model-catalog.js'
import { classifyModelError, MODEL_UNAVAILABLE_CODE } from '../src/claude-tui/model-error.js'

/**
 * #8934 — a claude-tui session created with a roster short id (`haiku-5-5`)
 * never replied: the id went to `claude --model` unchanged, the CLI printed
 * "There's an issue with the selected model (haiku-5-5)" and went idle with no
 * Stop hook, and the daemon waited its full 90s first-output watchdog.
 *
 *  1. the argv carries the id the CLI accepts (catalog short -> full), and
 *     aliases, full ids and unknown ids are left alone;
 *  2. that screen ends the turn at once with a structured error naming the id.
 */

const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

describe('resolveClaudeCliModelId (#8934)', () => {
  it('resolves every roster short id through the catalog, never by prefixing', () => {
    for (const m of CLAUDE_FALLBACK_MODELS) {
      if (['sonnet', 'opus', 'fable', 'haiku'].includes(m.id)) continue
      assert.equal(resolveClaudeCliModelId(m.id), m.fullId, m.id)
    }
    assert.equal(resolveClaudeCliModelId('haiku-5-5'), 'claude-haiku-5-5')
    assert.equal(resolveClaudeCliModelId('sonnet-5-5[1m]'), 'claude-sonnet-5-5[1m]')
  })

  it('passes aliases, [1m] aliases and claude-* full ids through unchanged', () => {
    for (const id of ['haiku', 'sonnet', 'opus', 'fable', 'opusplan', 'default', 'best', 'opus[1m]', 'sonnet[1m]',
      'claude-haiku-5-5', 'claude-opus-4-8[1m]', 'claude-sonnet-5-20261001', 'claude-not-in-catalog']) {
      assert.equal(resolveClaudeCliModelId(id), id, id)
    }
  })

  it('does not invent an id for a short id the catalog does not know', () => {
    assert.equal(resolveClaudeCliModelId('haiku-9-9'), 'haiku-9-9')
    assert.notEqual(resolveClaudeCliModelId('haiku-9-9'), 'claude-haiku-9-9')
  })
})

describe('ClaudeTuiSession --model argv (#8934)', () => {
  let fakeHome
  let session

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-8934-home-'))
    writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ projects: {} }))
    process.env._ORIG_HOME = process.env.HOME
    process.env.HOME = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    if (process.env._ORIG_HOME) { process.env.HOME = process.env._ORIG_HOME; delete process.env._ORIG_HOME }
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    rmSync(fakeHome, { recursive: true, force: true })
  })

  async function spawnedModelArg(model) {
    session = new ClaudeTuiSession({
      cwd: '/tmp', port: 15990, skillsDir: join(fakeHome, 'skills'), repoSkillsDir: null, model,
    })
    mkdirSync(join(fakeHome, 'skills'), { recursive: true })
    session._sessionId = 'argv-8934-uuid'
    session._conversationPersisted = () => true
    session._settingsPath = join(fakeHome, 'settings.json')
    session._buildCombinedSkillsPrefix = () => ''
    session.on('error', () => {})
    let args = null
    session._ptyModOverride = { spawn: (_cmd, a) => { args = a; throw new Error('captured-and-bail') } }
    await session._spawnPty(true)
    assert.ok(args, 'the real _spawnPty reached node-pty spawn')
    const i = args.indexOf('--model')
    return { value: i === -1 ? null : args[i + 1], requested: session.model }
  }

  it('spawns a roster short id as its catalog full id, keeping the requested id on the session', async () => {
    const { value, requested } = await spawnedModelArg('haiku-5-5')
    assert.equal(value, 'claude-haiku-5-5')
    assert.equal(requested, 'haiku-5-5', 'this.model stays what the user asked for')
  })

  it('spawns an alias unchanged', async () => {
    assert.equal((await spawnedModelArg('haiku')).value, 'haiku')
  })

  it('spawns a full id unchanged', async () => {
    assert.equal((await spawnedModelArg('claude-haiku-5-5')).value, 'claude-haiku-5-5')
  })

  async function refusedSpawn(model) {
    session = new ClaudeTuiSession({
      cwd: '/tmp', port: 15991, skillsDir: join(fakeHome, 'skills'), repoSkillsDir: null, model,
    })
    mkdirSync(join(fakeHome, 'skills'), { recursive: true })
    session._sessionId = 'argv-8934-uuid'
    session._conversationPersisted = () => true
    session._settingsPath = join(fakeHome, 'settings.json')
    session._buildCombinedSkillsPrefix = () => ''
    const errors = []
    session.on('error', (e) => errors.push(e))
    let spawned = null
    session._ptyModOverride = { spawn: (_cmd, a) => { spawned = a; throw new Error('captured-and-bail') } }
    await session._spawnPty(true)
    return { spawned, errors }
  }

  it('refuses a leading-dash model at spawn: structured error, never reaches argv', async () => {
    const { spawned, errors } = await refusedSpawn('--dangerously-skip-permissions')
    assert.equal(spawned, null, 'spawn was not reached')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'invalid_model')
    assert.ok(errors[0].message.startsWith('Refusing to spawn claude TUI'), errors[0].message)
  })

  it('refuses a model containing CR/LF at spawn', async () => {
    const { spawned, errors } = await refusedSpawn('claude-x\nfoo')
    assert.equal(spawned, null)
    assert.equal(errors[0]?.code, 'invalid_model')
  })

  it('a normal id still spawns', async () => {
    const { spawned, errors } = await refusedSpawn('claude-haiku-5-5')
    assert.ok(spawned && spawned.includes('claude-haiku-5-5'))
    assert.equal(errors.some((e) => e.code === 'invalid_model'), false)
  })

  it('does not hand-prefix an unknown short id', async () => {
    assert.equal((await spawnedModelArg('haiku-9-9')).value, 'haiku-9-9')
  })
})

describe('classifyModelError (#8934)', () => {
  const SCREEN = "⏺ There's an issue with the selected model (haiku-5-5). It may not exist or you may not have access to it. Run /model to pick a different model."

  it('classifies the TUI screen and names the model', () => {
    const r = classifyModelError(SCREEN)
    assert.equal(r.code, MODEL_UNAVAILABLE_CODE)
    assert.equal(r.model, 'haiku-5-5')
    assert.ok(r.message.includes("'haiku-5-5'"), r.message)
  })

  it('tolerates a narrow terminal that squeezes out the spaces and a curly apostrophe', () => {
    assert.equal(classifyModelError("There'sanissuewiththeselectedmodel(haiku-5-5).Itmaynotexist").model, 'haiku-5-5')
    assert.equal(classifyModelError('There’s an issue with the selected model (claude-x[1m]).').model, 'claude-x[1m]')
  })

  it('does not match ordinary text', () => {
    for (const t of ['', 'hello', 'there is an issue with the model', "There's an issue with the selected model", null, undefined]) {
      assert.equal(classifyModelError(t), null, String(t))
    }
  })
})

describe('ClaudeTuiSession — rejected model reported at the first-output watchdog (#8934)', () => {
  let fakeHome
  let skillsDir
  let sinkBase
  let session

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-tui-8934-turn-'))
    process.env._ORIG_HOME = process.env.HOME
    process.env.HOME = fakeHome
    process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-8934-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-8934-sink-'))
  })

  afterEach(async () => {
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    if (process.env._ORIG_HOME) { process.env.HOME = process.env._ORIG_HOME; delete process.env._ORIG_HOME }
    process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
    for (const d of [fakeHome, skillsDir, sinkBase]) rmSync(d, { recursive: true, force: true })
  })

  const screenFor = (id) => `⏺ There's an issue with the selected model (${id}). It may not exist or you may not have access to it. Run /model to pick a different model.`

  // firstOutputTimeoutMs stays short for the tests ABOUT that watchdog; the rest pass a
  // generous value so a slow runner cannot trip it.
  function turnSession({ reply = '', echo = '', firstOutputTimeoutMs = 600 } = {}) {
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null, model: 'haiku-5-5',
      loginProbeRunner: async () => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      resultTimeoutMs: 5000, hardTimeoutMs: 5000, streamStallTimeoutMs: 5000, firstOutputTimeoutMs,
    })
    const s = session
    s._processReady = true
    s._sessionId = 'sess-8934'
    s._sinkDir = join(sinkBase, 's-test')
    mkdirSync(s._sinkDir, { recursive: true, mode: 0o700 })
    s._waitForPrompt = async () => true
    s._writePtyTextThrottled = async () => { if (echo) s._appendToOutputTail(echo); return true }
    // What claude prints once the prompt is written and the turn's scan boundaries are marked.
    let replied = false
    const realArm = s._armResultTimeout.bind(s)
    s._armResultTimeout = (...a) => {
      if (!replied) { replied = true; if (reply) s._appendToOutputTail(reply) }
      return realArm(...a)
    }
    s._term = { write: () => {}, kill: () => {}, pid: 2 ** 30 }
    const events = { errors: [], results: [], reasons: [] }
    s.on('error', (e) => events.errors.push(e))
    s.on('result', (e) => events.results.push(e))
    const realTeardown = s._teardownTurn.bind(s)
    s._teardownTurn = (reason, opts) => { events.reasons.push(reason); return realTeardown(reason, opts) }
    return { s, events }
  }


  const OWN = 'claude-haiku-5-5' // what the session passes to --model for 'haiku-5-5'

  it('a rejected model (screen names the session\'s own --model value, no hook) is reported as model_unavailable at the watchdog', async () => {
    const { s, events } = turnSession({ reply: screenFor(OWN) })
    await s.sendMessage('hi')
    assert.deepEqual(events.reasons, ['first_output_timeout'])
    assert.equal(events.errors.length, 1)
    assert.equal(events.errors[0].code, 'model_unavailable')
    assert.equal(events.errors[0].model, OWN)
    assert.ok(events.errors[0].message.includes(OWN))
    assert.equal(events.results.length, 1, 'result emitted so the client leaves the busy state')
    assert.equal(s._isBusy, false)
  })

  it('the prompt echo AND redraw quoting another model is never model_unavailable; at the watchdog it is a plain stream_stall', async () => {
    const { s, events } = turnSession({ echo: screenFor('foo-1'), reply: screenFor('foo-1') })
    await s.sendMessage(screenFor('foo-1'))
    assert.deepEqual(events.errors.map((e) => e.code), ['stream_stall'])
  })

  it('a screen naming a DIFFERENT model than the session\'s is a stream_stall, not model_unavailable', async () => {
    const { s, events } = turnSession({ reply: screenFor('claude-opus-5-5') })
    await s.sendMessage('hi')
    assert.deepEqual(events.errors.map((e) => e.code), ['stream_stall'])
  })

  it('an assistant reply quoting the sentence (even for the session\'s own model) with no hook, then Stop, completes normally', async () => {
    const { s, events } = turnSession({ firstOutputTimeoutMs: 4000, reply: `The CLI says "${screenFor(OWN)}" when the id is wrong.` })
    const turn = s.sendMessage('explain that error')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(s._isBusy, true, 'quoted text did not tear the turn down')
    writeFileSync(join(s._sinkDir, 'stop-done.json'), JSON.stringify({ last_assistant_message: 'ok' }))
    await turn
    assert.deepEqual(events.reasons, [])
    assert.deepEqual(events.errors, [])
  })
})
