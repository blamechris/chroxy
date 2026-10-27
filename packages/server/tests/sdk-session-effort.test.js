import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'
import { resetModels, getRosterModelRow } from '../src/models.js'
import { buildThinkingLevelChanged } from '../src/thinking-level-wire.js'
import { resolveSessionThinkingLevels } from '../src/handlers/settings-handlers.js'
import { listProviders } from '../src/providers.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

/**
 * #8700 — the header's thinking level for a Claude SDK session is Claude Code's
 * EFFORT, not a token budget.
 *
 * Before #8700 the level set only `maxThinkingTokens`, which every adaptive
 * model ignores, and Auto set nothing, so a session ran at Claude Code's
 * default effort whatever the header said (harness trial run 3 ran at `medium`
 * by accident). These tests pin: the level reaching the Agent SDK's `effort`
 * option and from there the CLI's `--effort` flag; the per-model roster coming
 * from the SDK's own `supportedModels()` answer; the level following a model
 * change; and the effective level Claude Code reports reaching the wire and
 * the operator's log line.
 */

let tmp
function stateFile() {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'sdk-effort-test-'))
  return join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

// What CLI 2.1.296's `supportedModels()` answers, trimmed to the fields read:
// it narrows `supportedEffortLevels` per model (no `xhigh` on Sonnet, no effort
// at all on Haiku 4.5) and names the canonical id in `resolvedModel`.
const SDK_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (Opus 5.5)', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-sonnet-5-5', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'claude-haiku-4-5', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: '' },
]

function createSession(opts = {}) {
  return new SdkSession({ cwd: '/tmp', stateFilePath: stateFile(), ...opts })
}

// The suite's usual seam: `_callQuery` captured, so the options object the
// session built for `query()` is what the assertions read.
function capturing(opts = {}) {
  const s = createSession(opts)
  s._processReady = true
  const captured = []
  s._callQuery = (args) => {
    captured.push(args)
    return (async function* () {
      yield { type: 'result', session_id: 'effort-test', total_cost_usd: 0, duration_ms: 0, usage: {} }
    })()
  }
  return { s, captured }
}

// Feed a session the SDK's model list the way the init handler does.
async function hearModels(s, models = SDK_MODELS) {
  const previous = s._query
  s._query = { supportedModels: async () => models }
  await s._fetchSupportedModels()
  s._query = previous
}

describe('SdkSession effort (#8700) — the level reaches the query() options', () => {
  afterEach(() => resetModels())

  it('sends a known effort model its level as `effort`, without the dead budget', async () => {
    const { s, captured } = capturing({ model: 'claude-opus-5-5' })
    await hearModels(s)
    await s.setThinkingLevel('high')
    await s.sendMessage('go')
    s.destroy()
    assert.equal(captured[0].options.effort, 'high')
    assert.equal(captured[0].options.maxThinkingTokens, undefined, 'an adaptive model ignores a budget; sending one is the #8700 defect')
  })

  it('sends a level only effort has (medium) as `effort`', async () => {
    const { s, captured } = capturing({ model: 'claude-opus-5-5' })
    await hearModels(s)
    await s.setThinkingLevel('medium')
    await s.sendMessage('go')
    s.destroy()
    assert.equal(captured[0].options.effort, 'medium')
    assert.equal(captured[0].options.maxThinkingTokens, undefined)
  })

  it('sends neither effort nor budget at Auto, so Claude Code applies the user\'s own setting', async () => {
    const { s, captured } = capturing({ model: 'claude-opus-5-5' })
    await hearModels(s)
    await s.setThinkingLevel('high')
    await s.setThinkingLevel('default')
    await s.sendMessage('go')
    s.destroy()
    assert.equal(Object.hasOwn(captured[0].options, 'effort'), false)
    assert.equal(captured[0].options.maxThinkingTokens, undefined)
  })

  it('sends a model that predates effort its budget, not an effort it would drop', async () => {
    const { s, captured } = capturing({ model: 'claude-haiku-4-5' })
    await hearModels(s)
    await s.setThinkingLevel('high')
    await s.sendMessage('go')
    s.destroy()
    assert.equal(captured[0].options.maxThinkingTokens, 32_000)
    assert.equal(Object.hasOwn(captured[0].options, 'effort'), false)
  })

  it('sends both when nothing has said which the model reads (first turn on a cold daemon)', async () => {
    const { s, captured } = capturing({ model: 'claude-opus-5-5' })
    await s.setThinkingLevel('high')
    await s.sendMessage('go')
    s.destroy()
    assert.equal(captured[0].options.effort, 'high', 'the effort must ride even before the model list is heard')
    assert.equal(captured[0].options.maxThinkingTokens, 32_000, 'and the pre-#8700 budget alongside, for a model that reads only that')
  })

  it('a roster row another session stamped is enough to send effort alone', async () => {
    const other = createSession()
    await hearModels(other)
    other.destroy()
    const { s, captured } = capturing({ model: 'claude-sonnet-5-5' })
    await s.setThinkingLevel('high')
    await s.sendMessage('go')
    s.destroy()
    assert.equal(captured[0].options.effort, 'high')
    assert.equal(captured[0].options.maxThinkingTokens, undefined)
  })

  it('a CLI that reports effort for no model leaves effort support unknown rather than "none"', async () => {
    const { s, captured } = capturing({ model: 'claude-opus-5-5' })
    const silent = SDK_MODELS.map((m) => {
      const row = { ...m }
      delete row.supportsEffort
      delete row.supportedEffortLevels
      return row
    })
    await hearModels(s, silent)
    await s.setThinkingLevel('high')
    await s.sendMessage('go')
    s.destroy()
    assert.equal(captured[0].options.effort, 'high', 'an older CLI\'s silence about effort must not stop the effort being sent')
  })
})

describe('SdkSession effort (#8700) — through the real Agent SDK to the CLI argv', () => {
  // `query()` is the real Agent SDK here; only the process it spawns is fake.
  // The SDK hands `spawnClaudeCodeProcess` the CLI argv it built from the
  // options, so this proves the level leaves Chroxy as `--effort <level>`.
  class ArgvCapturingSession extends SdkSession {
    _augmentQueryOptions(options) {
      options.spawnClaudeCodeProcess = ({ args }) => {
        this.capturedArgs.push(args)
        return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'pipe'] })
      }
    }
  }

  async function argvFor(level, model = 'claude-opus-5-5') {
    const s = new ArgvCapturingSession({ cwd: '/tmp', stateFilePath: stateFile(), model, spawnPreflight: () => process.execPath })
    s.capturedArgs = []
    s.on('error', () => {})
    s._processReady = true
    await hearModels(s)
    if (level) await s.setThinkingLevel(level)
    await s.sendMessage('go')
    s.destroy()
    assert.equal(s.capturedArgs.length, 1, 'the SDK must have spawned the CLI once')
    return s.capturedArgs[0]
  }

  afterEach(() => resetModels())

  it('passes the chosen level as --effort', async () => {
    const args = await argvFor('xhigh')
    const at = args.indexOf('--effort')
    assert.ok(at >= 0, `--effort missing from the CLI argv: ${args.join(' ')}`)
    assert.equal(args[at + 1], 'xhigh')
    assert.equal(args.includes('--max-thinking-tokens'), false)
  })

  it('passes no --effort at Auto', async () => {
    const args = await argvFor(null)
    assert.equal(args.includes('--effort'), false, `Auto must leave the effort to Claude Code: ${args.join(' ')}`)
  })
})

describe('SdkSession effort (#8700) — the per-model roster comes from the SDK', () => {
  afterEach(() => resetModels())

  it('stamps each effort model\'s levels, model default first, on its roster row', async () => {
    const s = createSession()
    await hearModels(s)
    s.destroy()
    const opus = getRosterModelRow('claude-sdk', 'claude-opus-5-5')
    assert.deepEqual(opus?.reasoningLevels, ['default', 'low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(opus?.defaultReasoningLevel, 'default')
    assert.deepEqual(getRosterModelRow('claude-sdk', 'claude-sonnet-5-5')?.reasoningLevels, ['default', 'low', 'medium', 'high'])
    assert.equal(getRosterModelRow('claude-sdk', 'claude-haiku-4-5')?.reasoningLevels, undefined, 'a model without effort keeps the legacy roster')
  })

  it('the set_thinking_level gate offers what the model offers: no Max on Sonnet 5.5', async () => {
    const s = createSession({ model: 'claude-sonnet-5-5' })
    await hearModels(s)
    const offered = resolveSessionThinkingLevels({ session: s, provider: 'claude-sdk' })
    s.destroy()
    assert.equal(offered.source, 'model')
    assert.deepEqual(offered.levels, ['default', 'low', 'medium', 'high'])
  })

  it('effortRoster ignores malformed levels and a model that does not support effort', () => {
    assert.equal(SdkSession.effortRoster({ value: 'x' }), null)
    assert.equal(SdkSession.effortRoster({ value: 'x', supportsEffort: true, supportedEffortLevels: [] }), null)
    assert.deepEqual(
      SdkSession.effortRoster({ value: 'x', supportsEffort: true, supportedEffortLevels: ['high', '../etc', 'high', 'default', 7] })?.reasoningLevels,
      ['default', 'high'],
    )
  })
})

describe('SdkSession effort (#8700) — the level follows a model change', () => {
  afterEach(() => resetModels())

  it('drops a level the new model does not offer back to the model default, and says so', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    await hearModels(s)
    await s.setThinkingLevel('xhigh')
    const events = []
    s.on('thinking_level_changed', (d) => events.push(d))
    assert.equal(s.setModel('claude-sonnet-5-5'), true)
    s.destroy()
    assert.equal(s.thinkingLevel, null, 'Sonnet 5.5 offers no xhigh, so the session must not keep sending it')
    assert.equal(events.length, 1)
    assert.ok(/does not offer xhigh/.test(events[0].reason), events[0].reason)
  })

  it('keeps a level the new model offers, and forgets the old model\'s report', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    await hearModels(s)
    await s.setThinkingLevel('high')
    s._query = { getSettings: async () => ({ applied: { model: 'claude-opus-5-5', effort: 'high' } }) }
    await s._readEffectiveEffort()
    s._query = null
    assert.equal(s.effectiveThinkingLevel, 'high')
    s.setModel('claude-sonnet-5-5')
    s.destroy()
    assert.equal(s.thinkingLevel, 'high')
    assert.equal(s.effectiveThinkingLevel, null, 'the report described Opus; Sonnet\'s is unknown until its turn reports')
  })
})

describe('SdkSession effort (#8700) — the effective level Claude Code reports', () => {
  afterEach(() => resetModels())

  it('reads applied.effort, announces it once, and puts it on the wire beside the request', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    const events = []
    s.on('thinking_level_changed', (d) => events.push(d))
    s._query = { getSettings: async () => ({ applied: { model: 'claude-opus-5-5', effort: 'medium' } }) }
    await s._readEffectiveEffort()
    await s._readEffectiveEffort()
    s._query = null
    s.destroy()
    assert.equal(s.effectiveThinkingLevel, 'medium')
    assert.equal(events.length, 1, 'an unchanged report must not repeat every turn')
    assert.deepEqual(buildThinkingLevelChanged(s), { type: 'thinking_level_changed', level: 'default', effective: 'medium' })
  })

  it('is read when a turn\'s init arrives', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    s._processReady = true
    s._callQuery = () => {
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-opus-5-5', tools: [] }
        await new Promise((r) => setTimeout(r, 20))
        yield { type: 'result', session_id: 'sdk-1', total_cost_usd: 0, duration_ms: 0, usage: {} }
      })()
      gen.getSettings = async () => ({ applied: { model: 'claude-opus-5-5', effort: 'medium' } })
      return gen
    }
    await s.sendMessage('go')
    s.destroy()
    assert.equal(s.effectiveThinkingLevel, 'medium')
  })

  it('says unknown, not a level, when Claude Code cannot answer', async () => {
    for (const q of [{}, { getSettings: async () => { throw new Error('unsupported') } }, { getSettings: async () => ({}) }]) {
      const s = createSession()
      const events = []
      s.on('thinking_level_changed', (d) => events.push(d))
      s._query = q
      await s._readEffectiveEffort()
      s._query = null
      s.destroy()
      assert.equal(s.effectiveThinkingLevel, null)
      assert.equal(events.length, 1, 'the operator is told once that the level is not reported')
      assert.deepEqual(buildThinkingLevelChanged(s), { type: 'thinking_level_changed', level: 'default', effective: null })
    }
  })

  it('a report of no effort is shown as unknown and does not turn the effort off', async () => {
    const { s, captured } = capturing({ model: 'claude-opus-5-5' })
    await hearModels(s)
    s._query = { getSettings: async () => ({ applied: { model: 'claude-opus-5-5', effort: null } }) }
    await s._readEffectiveEffort()
    s._query = null
    assert.equal(s.effectiveThinkingLevel, null)
    await s.sendMessage('go')
    await s.setThinkingLevel('high')
    await s.sendMessage('go again')
    s.destroy()
    assert.equal(captured[1].options.effort, 'high', 'the SDK said Opus takes effort; a null report must not override that')
    assert.equal(captured[1].options.maxThinkingTokens, undefined)
  })

  it('drops a report that lands after a model change', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    let answer
    s._query = { getSettings: () => new Promise((r) => { answer = r }) }
    const pending = s._readEffectiveEffort()
    s._query = null
    s.setModel('claude-sonnet-5-5')
    answer({ applied: { model: 'claude-opus-5-5', effort: 'high' } })
    await pending
    s.destroy()
    assert.equal(s.effectiveThinkingLevel, null, 'Opus\'s answer must not be shown as Sonnet\'s')
  })

  it('a mid-turn change asks the running CLI to switch, then reports what it answers', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    await hearModels(s)
    const applied = []
    s._query = {
      applyFlagSettings: async (settings) => { applied.push(settings) },
      getSettings: async () => ({ applied: { model: 'claude-opus-5-5', effort: 'low' } }),
    }
    await s.setThinkingLevel('low')
    s._query = null
    s.destroy()
    assert.deepEqual(applied, [{ effortLevel: 'low' }])
    assert.equal(s.effectiveThinkingLevel, 'low')
  })

  it('a level change between turns forgets the last report', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    s._query = { getSettings: async () => ({ applied: { model: 'claude-opus-5-5', effort: 'medium' } }) }
    await s._readEffectiveEffort()
    s._query = null
    await s.setThinkingLevel('high')
    s.destroy()
    assert.equal(s.effectiveThinkingLevel, null, 'medium described the last turn, not the next one at high')
  })
})

describe('SdkSession effort (#8700) — mid-turn changes and stale reports', () => {
  afterEach(() => resetModels())

  // A running turn's query handle that records which live setter was used.
  function liveQuery(applied = { model: 'claude-opus-5-5', effort: 'high' }) {
    const calls = []
    return {
      calls,
      applyFlagSettings: async (settings) => { calls.push(['applyFlagSettings', settings]) },
      setMaxThinkingTokens: async (n) => { calls.push(['setMaxThinkingTokens', n]) },
      getSettings: async () => ({ applied }),
    }
  }

  async function midTurn(model, level, { heard = true } = {}) {
    const s = createSession({ model })
    if (heard) await hearModels(s)
    const q = liveQuery()
    s._query = q
    await s.setThinkingLevel(level)
    s._query = null
    s.destroy()
    return q.calls.map(([name, arg]) => `${name}(${JSON.stringify(arg)})`)
  }

  it('Max on an effort model is left for the next turn: Claude Code\'s settings do not take it', async () => {
    assert.deepEqual(await midTurn('claude-opus-5-5', 'max'), [])
  })

  it('Max on a model nothing has described still sets the budget live, as before #8700', async () => {
    assert.deepEqual(await midTurn('claude-opus-5-5', 'max', { heard: false }), ['setMaxThinkingTokens(128000)'])
  })

  it('High on a model nothing has described sets both live, as its next turn will', async () => {
    assert.deepEqual(await midTurn('claude-opus-5-5', 'high', { heard: false }), ['applyFlagSettings({"effortLevel":"high"})', 'setMaxThinkingTokens(32000)'])
  })

  it('a refused effort does not stop the budget, and a failed report does not stop either', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    const calls = []
    s._query = {
      applyFlagSettings: async () => { calls.push('applyFlagSettings'); throw new Error('refused') },
      setMaxThinkingTokens: async (n) => { calls.push(`setMaxThinkingTokens(${n})`) },
      getSettings: async () => { throw new Error('no answer') },
    }
    await s.setThinkingLevel('high')
    s._query = null
    s.destroy()
    assert.deepEqual(calls, ['applyFlagSettings', 'setMaxThinkingTokens(32000)'])
  })

  it('a budget model gets its budget live, and no effort', async () => {
    assert.deepEqual(await midTurn('claude-haiku-4-5', 'high'), ['setMaxThinkingTokens(32000)'])
  })

  it('Auto clears both the flag-layer effort and the budget', async () => {
    assert.deepEqual(await midTurn('claude-opus-5-5', 'default'), ['applyFlagSettings({"effortLevel":null})', 'setMaxThinkingTokens(null)'])
  })

  it('an effort model gets its effort live, and no budget', async () => {
    assert.deepEqual(await midTurn('claude-opus-5-5', 'xhigh'), ['applyFlagSettings({"effortLevel":"xhigh"})'])
  })

  it('a row that claims effort without naming its levels still gets effort, not the dead budget', async () => {
    const { s, captured } = capturing({ model: 'claude-opus-5-5' })
    await hearModels(s, SDK_MODELS.map((m) => (m.value === 'claude-opus-5-5' ? { ...m, supportedEffortLevels: undefined } : m)))
    await s.setThinkingLevel('high')
    await s.sendMessage('go')
    s.destroy()
    assert.equal(captured[0].options.effort, 'high')
    assert.equal(captured[0].options.maxThinkingTokens, undefined)
  })

  it('drops a report that lands after a newer turn started', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    let answer
    s._query = { getSettings: () => new Promise((r) => { answer = r }) }
    const pending = s._readEffectiveEffort()
    s._turnSeq = (s._turnSeq || 0) + 1
    answer({ applied: { model: 'claude-opus-5-5', effort: 'medium' } })
    await pending
    s._query = null
    s.destroy()
    assert.equal(s.effectiveThinkingLevel, null, 'the newer turn makes its own report')
  })

  it('drops a report that lands after the session was destroyed', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    const events = []
    s.on('thinking_level_changed', (d) => events.push(d))
    let answer
    s._query = { getSettings: () => new Promise((r) => { answer = r }), interrupt: async () => {} }
    const pending = s._readEffectiveEffort()
    s.destroy()
    answer({ applied: { model: 'claude-opus-5-5', effort: 'medium' } })
    await pending
    assert.equal(s.effectiveThinkingLevel, null)
    assert.equal(events.length, 0)
  })

  it('a listener that throws on the turn-start report does not become an unhandled rejection', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    s._processReady = true
    s.on('error', () => {})
    s.on('thinking_level_changed', () => { throw new Error('listener blew up') })
    s._callQuery = () => {
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-2', model: 'claude-opus-5-5', tools: [] }
        await new Promise((r) => setTimeout(r, 20))
        yield { type: 'result', session_id: 'sdk-2', total_cost_usd: 0, duration_ms: 0, usage: {} }
      })()
      gen.getSettings = async () => ({ applied: { model: 'claude-opus-5-5', effort: 'medium' } })
      return gen
    }
    const unhandled = []
    const onUnhandled = (reason) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      await s.sendMessage('go')
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      process.off('unhandledRejection', onUnhandled)
      s.destroy()
    }
    assert.deepEqual(unhandled.map((e) => e?.message), [], 'the readback is not awaited, so it must catch its own failures')
  })
})

describe('SdkSession effort (#8847) — newest live setting owns the report', () => {
  afterEach(() => resetModels())

  function deferred() {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const answer = (effort, model = 'claude-opus-5-5') => ({ applied: { model, effort } })

  async function running(t, { model = 'claude-opus-5-5', heard = true } = {}) {
    const s = createSession({ model })
    t.after(() => { s._query = null; s.destroy() })
    if (heard) await hearModels(s)
    const reads = []
    const applied = []
    const q = {
      applyFlagSettings: async ({ effortLevel }) => { applied.push(effortLevel) },
      setMaxThinkingTokens: async () => {},
      getSettings: () => {
        const read = deferred()
        reads.push(read)
        return read.promise
      },
    }
    s._query = q
    const events = []
    s.on('thinking_level_changed', () => events.push({
      ...buildThinkingLevelChanged(s), model: s._effectiveModel,
    }))
    return { s, q, reads, applied, events }
  }

  for (const [name, level, model, setterAvailable] of [
    ['effort', 'high', 'claude-opus-5-5', true],
    ['Auto', 'default', 'claude-opus-5-5', true],
    ['Max deferred to the next turn', 'max', 'claude-opus-5-5', true],
    ['budget only', 'high', 'claude-haiku-4-5', true],
    ['no live effort setter', 'high', 'claude-opus-5-5', false],
  ]) {
    it(`forgets the previous report immediately for ${name}`, async (t) => {
      const { s, q, reads } = await running(t, { model })
      const initial = s._readEffectiveEffort()
      reads[0].resolve(answer('medium'))
      await initial
      assert.equal(s.effectiveThinkingLevel, 'medium')
      const setter = deferred()
      t.after(() => setter.resolve())
      if (setterAvailable) q.applyFlagSettings = () => setter.promise
      else delete q.applyFlagSettings
      q.setMaxThinkingTokens = () => setter.promise
      const change = s.setThinkingLevel(level)
      assert.equal(s.effectiveThinkingLevel, null, 'the previous setting is no longer a current answer')
      assert.equal(s._effectiveModel, null)
      setter.resolve()
      await flush()
      reads[1]?.resolve(answer('low'))
      await change
    })
  }

  it('keeps the newest of two reversed readbacks and emits no stale event', async (t) => {
    const { s, reads, applied, events } = await running(t)
    const older = s.setThinkingLevel('high')
    await flush()
    const newer = s.setThinkingLevel('low')
    await flush()
    assert.equal(reads.length, 2)
    reads[1].resolve(answer('low', 'new-model'))
    await newer
    const newestEvents = [...events]
    reads[0].resolve(answer('high', 'old-model'))
    await older
    assert.deepEqual(applied, ['high', 'low'], 'native setter invocation order is unchanged')
    assert.equal(s.thinkingLevel, 'low')
    assert.equal(s.effectiveThinkingLevel, 'low')
    assert.deepEqual(buildThinkingLevelChanged(s), { type: 'thinking_level_changed', level: 'low', effective: 'low' })
    assert.equal(s._effectiveModel, 'new-model')
    assert.deepEqual(events, newestEvents)
    assert.equal(events.length, 1, 'the newest successful report must still be announced')
  })

  it('uses a generation rather than level equality across High → Low → High', async (t) => {
    const { s, reads, events } = await running(t)
    const changes = []
    for (const level of ['high', 'low', 'high']) {
      changes.push(s.setThinkingLevel(level))
      await flush()
    }
    reads[2].resolve(answer('high', 'new-model'))
    await changes[2]
    reads[0].resolve(answer('medium', 'old-model'))
    reads[1].resolve(answer('low', 'old-model'))
    await Promise.all(changes)
    assert.equal(s.effectiveThinkingLevel, 'high')
    assert.equal(s._effectiveModel, 'new-model')
    assert.equal(events.length, 1)
  })

  for (const failure of ['rejected', 'unsupported']) {
    it(`ignores a late ${failure} answer after a newer success`, async (t) => {
      const { s, reads, events } = await running(t)
      const older = s.setThinkingLevel('high')
      await flush()
      const newer = s.setThinkingLevel('low')
      await flush()
      reads[1].resolve(answer('low'))
      await newer
      if (failure === 'rejected') reads[0].reject(new Error('old read failed'))
      else reads[0].resolve({})
      await older
      assert.equal(s.effectiveThinkingLevel, 'low')
      assert.equal(events.length, 1)
    })
  }

  it('still asks for the newest report after both native setters reject', async (t) => {
    const { s, q, reads, events } = await running(t, { heard: false })
    const calls = []
    q.applyFlagSettings = async () => { calls.push('effort'); throw new Error('effort refused') }
    q.setMaxThinkingTokens = async () => { calls.push('budget'); throw new Error('budget refused') }
    const change = s.setThinkingLevel('high')
    await flush()
    assert.deepEqual(calls, ['effort', 'budget'])
    assert.equal(reads.length, 1, 'each refusal is handled independently before the readback')
    reads[0].resolve(answer('medium'))
    await change
    assert.deepEqual(buildThinkingLevelChanged(s), { type: 'thinking_level_changed', level: 'high', effective: 'medium' })
    assert.equal(events.length, 1)
  })

  it('ignores a turn-init readback after a live change', async (t) => {
    const { s, q, reads, events } = await running(t)
    const finishTurn = deferred()
    const initialRead = deferred()
    t.after(() => finishTurn.resolve())
    s._processReady = true
    q.getSettings = () => {
      const read = deferred()
      reads.push(read)
      initialRead.resolve()
      return read.promise
    }
    s._callQuery = () => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'race-test', model: 'claude-opus-5-5', tools: [] }
      await finishTurn.promise
      yield { type: 'result', session_id: 'race-test', total_cost_usd: 0, duration_ms: 0, usage: {} }
    })(), q)
    const turn = s.sendMessage('go')
    await initialRead.promise
    const change = s.setThinkingLevel('low')
    await flush()
    assert.equal(reads.length, 2)
    reads[1].resolve(answer('low'))
    await change
    reads[0].resolve(answer('high'))
    await flush()
    finishTurn.resolve()
    await turn
    assert.equal(s.effectiveThinkingLevel, 'low')
    assert.equal(events.length, 1)
  })

  for (const delayedSetter of ['applyFlagSettings', 'setMaxThinkingTokens']) {
    it(`does not let an older ${delayedSetter} continuation read under a newer identity`, async (t) => {
      const { s, q, reads, events } = await running(t, { heard: delayedSetter !== 'setMaxThinkingTokens' })
      const oldSetter = deferred()
      t.after(() => oldSetter.resolve())
      let first = true
      q[delayedSetter] = async () => {
        if (first) { first = false; await oldSetter.promise }
      }
      const older = s.setThinkingLevel('high')
      await flush()
      const newer = s.setThinkingLevel('low')
      await flush()
      assert.equal(reads.length, 1)
      reads[0].resolve(answer('low'))
      await newer
      oldSetter.resolve()
      await flush()
      // Resolve an erroneous extra read as well, so a regression fails rather
      // than hanging while the old setter awaits its stolen current identity.
      reads[1]?.resolve(answer('high'))
      await older
      assert.equal(reads.length, 1, 'an older setter must not start another readback')
      assert.equal(s.effectiveThinkingLevel, 'low')
      assert.equal(events.length, 1)
    })
  }

  for (const invalidation of ['turn', 'model', 'query', 'destroy']) {
    it(`does not start an old setter readback after ${invalidation} invalidation`, async (t) => {
      const { s, q, reads, events } = await running(t)
      const setter = deferred()
      t.after(() => setter.resolve())
      q.applyFlagSettings = () => setter.promise
      const change = s.setThinkingLevel('high')
      if (invalidation === 'turn') s._turnSeq = (s._turnSeq || 0) + 1
      if (invalidation === 'model') s.setModel('claude-sonnet-5-5')
      if (invalidation === 'query') s._query = { getSettings: q.getSettings }
      if (invalidation === 'destroy') { q.interrupt = async () => {}; s.destroy() }
      const priorEvents = [...events]
      setter.resolve()
      await flush()
      reads[0]?.resolve(answer('high'))
      await change
      assert.equal(reads.length, 0, 'the setter belongs to the captured turn, model, query and session')
      assert.equal(s.effectiveThinkingLevel, null)
      assert.deepEqual(events, priorEvents)
    })
  }
})

describe('SdkSession effort (#8700) — the operator\'s log line', () => {
  afterEach(() => resetModels())

  it('session-manager logs a session-originated change under the Chroxy session id', async () => {
    const { SessionManager } = await import('../src/session-manager.js')
    const dir = mkdtempSync(join(tmpdir(), 'sdk-effort-sm-'))
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 2, stateFilePath: join(dir, 'session-state.json') })
    const lines = []
    const listener = (entry) => lines.push(entry.message)
    addLogListener(listener)
    try {
      const s = createSession({ model: 'claude-opus-5-5' })
      mgr._sessions.set('chroxy-1', { session: s, name: 'S', cwd: '/tmp', provider: 'claude-sdk', createdAt: Date.now() })
      mgr._wireSessionEvents('chroxy-1', s)
      s._query = { getSettings: async () => ({ applied: { model: 'claude-opus-5-5', effort: 'medium' } }) }
      await s._readEffectiveEffort()
      s._query = null
      const line = lines.find((l) => l.startsWith('Thinking level on session chroxy-1:'))
      assert.ok(line, `no effort line among: ${lines.join(' | ')}`)
      assert.ok(line.includes('model=claude-opus-5-5 requested=default effective=medium'), line)
    } finally {
      removeLogListener(listener)
      try { mgr.destroyAll() } catch { /* best effort */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('describeThinkingLevel names the model, the request and the report', async () => {
    const s = createSession({ model: 'claude-opus-5-5' })
    await s.setThinkingLevel('high')
    s.destroy()
    assert.equal(s.describeThinkingLevel(), 'model=claude-opus-5-5 requested=high effective=unknown')
  })
})

describe('thinkingLevelEffective capability (#8700)', () => {
  it('every provider declares it, and only the Claude SDK family reports', async () => {
    const declared = new Map(listProviders().map((p) => [p.name, p.capabilities.thinkingLevelEffective]))
    assert.ok(declared.size >= 5, `listProviders() returned ${declared.size} providers; a short list would pass this vacuously`)
    for (const [name, value] of declared) {
      assert.equal(typeof value, 'boolean', `provider "${name}" must declare capabilities.thinkingLevelEffective`)
    }
    assert.deepEqual([...declared].filter(([, v]) => v).map(([n]) => n), ['claude-sdk'])
    // docker-sdk registers only when containers are configured; its class
    // inherits SdkSession's capabilities and its readback.
    const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
    assert.equal(DockerSdkSession.capabilities.thinkingLevelEffective, true)
  })

  it('buildThinkingLevelChanged sends effective only for a provider that declares it', () => {
    class Plain { get thinkingLevel() { return 'high' } }
    class Reporting {
      static get capabilities() { return { thinkingLevelEffective: true } }
      get thinkingLevel() { return null }
      get effectiveThinkingLevel() { return undefined }
    }
    assert.equal(buildThinkingLevelChanged({}), null, 'no thinking-level concept, no frame')
    assert.deepEqual(buildThinkingLevelChanged(new Plain()), { type: 'thinking_level_changed', level: 'high' })
    assert.deepEqual(buildThinkingLevelChanged(new Reporting()), { type: 'thinking_level_changed', level: 'default', effective: null })
  })
})
