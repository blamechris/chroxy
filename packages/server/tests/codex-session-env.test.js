import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CodexSession } from '../src/codex-session.js'
import { withEnv } from './test-helpers.js'

describe('CodexSession._buildChildEnv', () => {
  it('strips ANTHROPIC_API_KEY from child env', () => {
    withEnv({ ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-openai' }, () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.ANTHROPIC_API_KEY, undefined,
        'ANTHROPIC_API_KEY must not be passed to codex child')
    })
  })

  it('strips CHROXY_HOOK_SECRET from child env', () => {
    withEnv({ CHROXY_HOOK_SECRET: 'hook-secret', OPENAI_API_KEY: 'sk' }, () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.CHROXY_HOOK_SECRET, undefined,
        'CHROXY_HOOK_SECRET must not leak to codex child')
    })
  })

  it('strips CHROXY_TOKEN from child env', () => {
    withEnv({ CHROXY_TOKEN: 'primary-token', OPENAI_API_KEY: 'sk' }, () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.CHROXY_TOKEN, undefined)
    })
  })

  it('passes OPENAI_API_KEY to child env', () => {
    withEnv({ OPENAI_API_KEY: 'sk-openai-abc' }, () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.OPENAI_API_KEY, 'sk-openai-abc')
    })
  })

  it('excludes arbitrary operator secrets', () => {
    withEnv({
      OPENAI_API_KEY: 'sk',
      MY_DB_PASSWORD: 'operator-secret',
      ARBITRARY_TOKEN: 'random',
    }, () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.MY_DB_PASSWORD, undefined,
        'operator secrets must not leak to codex child')
      assert.equal(env.ARBITRARY_TOKEN, undefined)
    })
  })

  it('preserves PATH and HOME', () => {
    withEnv({ PATH: '/usr/bin', HOME: '/home/test', OPENAI_API_KEY: 'sk' }, () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.PATH, '/usr/bin')
      assert.equal(env.HOME, '/home/test')
    })
  })
})
