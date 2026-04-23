import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GeminiSession } from '../src/gemini-session.js'
import { withEnv } from './test-helpers.js'

describe('GeminiSession._buildChildEnv', () => {
  it('strips ANTHROPIC_API_KEY from child env', () => {
    withEnv({ ANTHROPIC_API_KEY: 'sk-ant-secret', GEMINI_API_KEY: 'g' }, () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.ANTHROPIC_API_KEY, undefined,
        'ANTHROPIC_API_KEY must not be passed to gemini child')
    })
  })

  it('strips CHROXY_HOOK_SECRET from child env', () => {
    withEnv({ CHROXY_HOOK_SECRET: 'hook-secret', GEMINI_API_KEY: 'g' }, () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.CHROXY_HOOK_SECRET, undefined)
    })
  })

  it('strips CHROXY_TOKEN from child env', () => {
    withEnv({ CHROXY_TOKEN: 'primary-token', GEMINI_API_KEY: 'g' }, () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.CHROXY_TOKEN, undefined)
    })
  })

  it('passes GEMINI_API_KEY to child env', () => {
    withEnv({ GEMINI_API_KEY: 'g-123' }, () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.GEMINI_API_KEY, 'g-123')
    })
  })

  it('passes GOOGLE_API_KEY when set', () => {
    withEnv({ GOOGLE_API_KEY: 'goog-abc', GEMINI_API_KEY: 'g' }, () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.GOOGLE_API_KEY, 'goog-abc')
    })
  })

  it('strips OPENAI_API_KEY from gemini child', () => {
    withEnv({ OPENAI_API_KEY: 'sk-openai', GEMINI_API_KEY: 'g' }, () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.OPENAI_API_KEY, undefined,
        'cross-provider secrets must not leak')
    })
  })

  it('excludes arbitrary operator secrets', () => {
    withEnv({
      GEMINI_API_KEY: 'g',
      MY_DB_PASSWORD: 'operator-secret',
    }, () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.MY_DB_PASSWORD, undefined)
    })
  })

  it('preserves PATH and HOME', () => {
    withEnv({ PATH: '/usr/bin', HOME: '/home/test', GEMINI_API_KEY: 'g' }, () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const env = session._buildChildEnv()
      assert.equal(env.PATH, '/usr/bin')
      assert.equal(env.HOME, '/home/test')
    })
  })
})
