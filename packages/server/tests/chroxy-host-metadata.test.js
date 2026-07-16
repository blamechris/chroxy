import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildChroxyHostEnv, readGitIdentity, getChroxyHostEnv, _resetChroxyHostEnvCacheForTest } from '../src/chroxy-host-metadata.js'

describe('chroxy-host-metadata (#6633)', () => {
  it('builds a fully-populated identity map from injected sources', () => {
    const env = buildChroxyHostEnv({
      version: '9.9.9',
      git: { sha: 'abc1234', branch: 'feat/x' },
      platform: 'win32',
      node: '22.1.0',
      pid: 4242,
    })
    assert.deepEqual(env, {
      CHROXY_HOST_APP: 'Chroxy',
      CHROXY_HOST_VERSION: '9.9.9',
      CHROXY_HOST_CHANNEL: 'dev',
      CHROXY_HOST_PLATFORM: 'win32',
      CHROXY_HOST_NODE: '22.1.0',
      CHROXY_HOST_PID: '4242',
      CHROXY_HOST_GIT_SHA: 'abc1234',
      CHROXY_HOST_GIT_BRANCH: 'feat/x',
    })
  })

  it('every value is a string (env vars can only be strings)', () => {
    const env = buildChroxyHostEnv({ version: '1.0.0', git: { sha: 'd' }, pid: 7 })
    for (const [k, v] of Object.entries(env)) {
      assert.equal(typeof v, 'string', `${k} must be a string, got ${typeof v}`)
    }
  })

  it('no git → release channel and no git keys', () => {
    const env = buildChroxyHostEnv({ version: '1.2.3', git: {}, platform: 'linux', node: '22.0.0', pid: 1 })
    assert.equal(env.CHROXY_HOST_CHANNEL, 'release')
    assert.ok(!('CHROXY_HOST_GIT_SHA' in env), 'no SHA key when git is unavailable')
    assert.ok(!('CHROXY_HOST_GIT_BRANCH' in env), 'no branch key when git is unavailable')
  })

  it('git SHA without a branch → dev channel, SHA present, branch omitted', () => {
    const env = buildChroxyHostEnv({ version: '1.0.0', git: { sha: 'deadbee' }, pid: 1 })
    assert.equal(env.CHROXY_HOST_CHANNEL, 'dev')
    assert.equal(env.CHROXY_HOST_GIT_SHA, 'deadbee')
    assert.ok(!('CHROXY_HOST_GIT_BRANCH' in env), 'branch omitted when git reports none')
  })

  it('reads a real, non-empty version from package.json via the un-injected path', () => {
    // Exercise the real (un-injected) read: version comes from the server
    // package.json, so it is always a non-empty string, never undefined.
    const env = buildChroxyHostEnv({ git: {}, platform: 'linux', node: '22.0.0', pid: 1 })
    assert.equal(typeof env.CHROXY_HOST_VERSION, 'string')
    assert.ok(env.CHROXY_HOST_VERSION.length > 0, 'version is populated from package.json')
  })

  describe('readGitIdentity', () => {
    it('returns sha + branch from a working git', () => {
      const exec = (_cmd, args) => {
        if (args.includes('--abbrev-ref')) return 'main\n'
        return 'abcdef1\n'
      }
      assert.deepEqual(readGitIdentity(exec), { sha: 'abcdef1', branch: 'main' })
    })

    it('detached HEAD → sha only, no branch', () => {
      const exec = (_cmd, args) => (args.includes('--abbrev-ref') ? 'HEAD\n' : 'abcdef1\n')
      assert.deepEqual(readGitIdentity(exec), { sha: 'abcdef1' })
    })

    it('git failure (no repo) → {}', () => {
      const exec = () => { throw new Error('not a git repository') }
      assert.deepEqual(readGitIdentity(exec), {})
    })

    it('empty sha → {} (never a half-populated identity)', () => {
      const exec = () => '  \n'
      assert.deepEqual(readGitIdentity(exec), {})
    })

    it('installed as a dependency (path under node_modules) → {} without touching git', () => {
      // Guards the privacy fix: an npm-installed chroxy must NOT walk up to the
      // user's project .git and leak their branch/SHA into third-party subprocesses.
      let called = false
      const exec = () => { called = true; return 'abcdef1\n' }
      const out = readGitIdentity(exec, '/home/u/proj/node_modules/chroxy/packages/server/src')
      assert.deepEqual(out, {}, 'no git identity for an installed package')
      assert.equal(called, false, 'git is never invoked when under node_modules')
    })

    it('a source checkout (no node_modules ancestor) still queries git', () => {
      const exec = (_c, args) => (args.includes('--abbrev-ref') ? 'main\n' : 'abcdef1\n')
      const out = readGitIdentity(exec, '/home/u/src/chroxy/packages/server/src')
      assert.deepEqual(out, { sha: 'abcdef1', branch: 'main' })
    })
  })

  describe('getChroxyHostEnv memoization', () => {
    it('returns a stable memoized object across calls', () => {
      _resetChroxyHostEnvCacheForTest()
      const a = getChroxyHostEnv()
      const b = getChroxyHostEnv()
      assert.equal(a, b, 'same reference — computed once per process')
      assert.equal(a.CHROXY_HOST_APP, 'Chroxy')
      assert.equal(typeof a.CHROXY_HOST_VERSION, 'string')
      _resetChroxyHostEnvCacheForTest()
    })
  })
})
