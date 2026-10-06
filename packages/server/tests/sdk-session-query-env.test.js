import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'
import { withEnv } from './test-helpers.js'

/**
 * SdkSession passes an explicit environment to the Agent SDK's `query()`.
 *
 * Without an `env` option the SDK spawns the `claude` child with a copy of
 * the daemon's own `process.env`. Every other provider spawn in this package
 * routes its child env through `utils/spawn-env.js`, which strips the
 * daemon-owned secrets (`CHROXY_SECRET_DENYLIST`) and any ambiently inherited
 * per-session chroxy values; this pins that the SDK child is built the same
 * way, on every turn, and that the user's own environment still reaches it.
 */

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'sdk-query-env-test-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => {
  if (_tmp) rmSync(_tmp, { recursive: true, force: true })
})

function createSession(opts = {}) {
  const session = new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile(), ...opts })
  session._fetchSupportedModels = () => {}
  return session
}

const init = { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-x', tools: [] }
const result = { type: 'result', session_id: 'sdk-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: {} }

function wireCapturingOptions(session, captured) {
  session._callQuery = (args) => {
    captured.push(args.options)
    return (async function* () {
      yield init
      yield result
    })()
  }
}

describe('SdkSession query() environment', () => {
  let session
  beforeEach(() => { session = createSession() })
  afterEach(() => { session.destroy() })

  it('passes an explicit env that omits the daemon-owned secrets and ambient session values', async () => {
    const captured = []
    wireCapturingOptions(session, captured)
    await withEnv({
      API_TOKEN: 'primary-bearer-token',
      CHROXY_INGEST_SECRET: 'ingest-secret',
      CHROXY_PORT: '9999',
      CHROXY_HOOK_SECRET: 'foreign-session-secret',
      CHROXY_TEST_PASSTHROUGH: 'still-here',
    }, () => session.sendMessage('hi'))

    assert.equal(captured.length, 1)
    const env = captured[0].env
    assert.ok(env && typeof env === 'object', 'query() receives an explicit env option')
    assert.equal(env.API_TOKEN, undefined, 'the primary bearer token is not in the SDK child env')
    assert.equal(env.CHROXY_INGEST_SECRET, undefined)
    assert.equal(env.CHROXY_PORT, undefined, 'an ambiently inherited session port is dropped')
    assert.equal(env.CHROXY_HOOK_SECRET, undefined, 'an ambiently inherited hook secret is dropped')
    assert.equal(env.CHROXY_TEST_PASSTHROUGH, 'still-here', 'the user\'s own environment still reaches the child')
    assert.equal(env.CHROXY_HOST_APP, 'Chroxy', 'the host identity is present, as for every other provider child')
    // Windows spells the key `Path`; compare whichever casing the host uses.
    const pathKey = (o) => Object.keys(o).find((k) => k.toLowerCase() === 'path')
    assert.equal(env[pathKey(env)], process.env[pathKey(process.env)], 'the search path reaches the child unchanged')
  })

  it('keeps ANTHROPIC_API_KEY, which the SDK provider accepts as an auth source', async () => {
    const captured = []
    wireCapturingOptions(session, captured)
    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () => session.sendMessage('hi'))
    assert.equal(captured[0].env.ANTHROPIC_API_KEY, 'sk-ant-test')
  })

  it('is built fresh on every turn (a secret set between turns never leaks either)', async () => {
    const captured = []
    wireCapturingOptions(session, captured)
    await session.sendMessage('one')
    await withEnv({ API_TOKEN: 'set-later' }, () => session.sendMessage('two'))
    assert.equal(captured.length, 2)
    assert.notEqual(captured[0].env, captured[1].env, 'a new object per turn')
    assert.equal(captured[1].env.API_TOKEN, undefined)
  })

  it('a subclass hook sees the env before query() and may extend it', async () => {
    const captured = []
    wireCapturingOptions(session, captured)
    session._augmentQueryOptions = (options) => {
      assert.ok(options.env, 'env is set before the subclass hook runs')
      options.env = { ...options.env, SUBCLASS_EXTRA: '1' }
    }
    await withEnv({ API_TOKEN: 'primary-bearer-token' }, () => session.sendMessage('hi'))
    assert.equal(captured[0].env.SUBCLASS_EXTRA, '1')
    assert.equal(captured[0].env.API_TOKEN, undefined)
  })
})
