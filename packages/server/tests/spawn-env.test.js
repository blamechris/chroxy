import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSpawnEnv } from '../src/utils/spawn-env.js'
import { withEnv } from './test-helpers.js'

describe('buildSpawnEnv', () => {
  describe('codex provider (allowlist)', () => {
    it('strips ANTHROPIC_API_KEY from child env', () => {
      withEnv({ ANTHROPIC_API_KEY: 'sk-ant-leak', OPENAI_API_KEY: 'sk-openai' }, () => {
        const env = buildSpawnEnv('codex')
        assert.equal(env.ANTHROPIC_API_KEY, undefined,
          'ANTHROPIC_API_KEY must not be passed to codex child')
      })
    })

    it('strips CHROXY_HOOK_SECRET from child env', () => {
      withEnv({ CHROXY_HOOK_SECRET: 'secret-hook', OPENAI_API_KEY: 'sk-openai' }, () => {
        const env = buildSpawnEnv('codex')
        assert.equal(env.CHROXY_HOOK_SECRET, undefined,
          'CHROXY_HOOK_SECRET must not leak to codex child')
      })
    })

    it('strips CHROXY_TOKEN from child env', () => {
      withEnv({ CHROXY_TOKEN: 'tok-primary', OPENAI_API_KEY: 'sk-openai' }, () => {
        const env = buildSpawnEnv('codex')
        assert.equal(env.CHROXY_TOKEN, undefined,
          'CHROXY_TOKEN (primary API token) must not leak to codex child')
      })
    })

    it('passes OPENAI_API_KEY to child env', () => {
      withEnv({ OPENAI_API_KEY: 'sk-openai-123' }, () => {
        const env = buildSpawnEnv('codex')
        assert.equal(env.OPENAI_API_KEY, 'sk-openai-123')
      })
    })

    it('passes OPENAI_BASE_URL and OPENAI_ORG_ID when set', () => {
      withEnv({
        OPENAI_API_KEY: 'sk',
        OPENAI_BASE_URL: 'https://example.com',
        OPENAI_ORG_ID: 'org-1',
      }, () => {
        const env = buildSpawnEnv('codex')
        assert.equal(env.OPENAI_BASE_URL, 'https://example.com')
        assert.equal(env.OPENAI_ORG_ID, 'org-1')
      })
    })

    it('passes standard env vars (PATH, HOME, USER)', () => {
      withEnv({
        PATH: '/usr/bin:/bin',
        HOME: '/home/test',
        USER: 'tester',
      }, () => {
        const env = buildSpawnEnv('codex')
        assert.equal(env.PATH, '/usr/bin:/bin')
        assert.equal(env.HOME, '/home/test')
        assert.equal(env.USER, 'tester')
      })
    })

    it('excludes arbitrary non-allowlisted env vars', () => {
      withEnv({
        OPENAI_API_KEY: 'sk',
        MY_SECRET_DB_PASSWORD: 'supersecret',
        RANDOM_CRED: 'leaky',
      }, () => {
        const env = buildSpawnEnv('codex')
        assert.equal(env.MY_SECRET_DB_PASSWORD, undefined,
          'arbitrary operator env vars must not leak to codex child')
        assert.equal(env.RANDOM_CRED, undefined)
      })
    })

    it('strips GEMINI_API_KEY from codex child env', () => {
      withEnv({ GEMINI_API_KEY: 'gemini-key', OPENAI_API_KEY: 'sk' }, () => {
        const env = buildSpawnEnv('codex')
        assert.equal(env.GEMINI_API_KEY, undefined,
          'cross-provider secrets must not leak between providers')
      })
    })
  })

  describe('gemini provider (allowlist)', () => {
    it('strips ANTHROPIC_API_KEY from child env', () => {
      withEnv({ ANTHROPIC_API_KEY: 'sk-ant-leak', GEMINI_API_KEY: 'gemini-key' }, () => {
        const env = buildSpawnEnv('gemini')
        assert.equal(env.ANTHROPIC_API_KEY, undefined,
          'ANTHROPIC_API_KEY must not be passed to gemini child')
      })
    })

    it('strips CHROXY_HOOK_SECRET from child env', () => {
      withEnv({ CHROXY_HOOK_SECRET: 'secret', GEMINI_API_KEY: 'g' }, () => {
        const env = buildSpawnEnv('gemini')
        assert.equal(env.CHROXY_HOOK_SECRET, undefined)
      })
    })

    it('strips CHROXY_TOKEN from child env', () => {
      withEnv({ CHROXY_TOKEN: 'tok', GEMINI_API_KEY: 'g' }, () => {
        const env = buildSpawnEnv('gemini')
        assert.equal(env.CHROXY_TOKEN, undefined)
      })
    })

    it('passes GEMINI_API_KEY to child env', () => {
      withEnv({ GEMINI_API_KEY: 'gemini-123' }, () => {
        const env = buildSpawnEnv('gemini')
        assert.equal(env.GEMINI_API_KEY, 'gemini-123')
      })
    })

    it('passes GOOGLE_API_KEY to child env', () => {
      withEnv({ GOOGLE_API_KEY: 'google-abc' }, () => {
        const env = buildSpawnEnv('gemini')
        assert.equal(env.GOOGLE_API_KEY, 'google-abc')
      })
    })

    it('passes GOOGLE_APPLICATION_CREDENTIALS to child env', () => {
      withEnv({ GOOGLE_APPLICATION_CREDENTIALS: '/tmp/creds.json' }, () => {
        const env = buildSpawnEnv('gemini')
        assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, '/tmp/creds.json')
      })
    })

    it('strips OPENAI_API_KEY from gemini child env', () => {
      withEnv({ OPENAI_API_KEY: 'openai-key', GEMINI_API_KEY: 'g' }, () => {
        const env = buildSpawnEnv('gemini')
        assert.equal(env.OPENAI_API_KEY, undefined,
          'cross-provider secrets must not leak between providers')
      })
    })

    it('excludes arbitrary non-allowlisted env vars', () => {
      withEnv({
        GEMINI_API_KEY: 'g',
        MY_SECRET_DB_PASSWORD: 'supersecret',
      }, () => {
        const env = buildSpawnEnv('gemini')
        assert.equal(env.MY_SECRET_DB_PASSWORD, undefined)
      })
    })
  })

  describe('claude provider (denylist preserves existing behavior)', () => {
    it('strips ANTHROPIC_API_KEY from child env', () => {
      withEnv({ ANTHROPIC_API_KEY: 'sk-ant' }, () => {
        const env = buildSpawnEnv('claude')
        assert.equal(env.ANTHROPIC_API_KEY, undefined,
          'ANTHROPIC_API_KEY must be stripped so claude CLI uses OAuth')
      })
    })

    it('forwards arbitrary process.env keys (denylist mode)', () => {
      withEnv({ CHROXY_TEST_PASSTHROUGH: 'passthrough-value' }, () => {
        const env = buildSpawnEnv('claude')
        assert.equal(env.CHROXY_TEST_PASSTHROUGH, 'passthrough-value',
          'claude provider uses denylist — arbitrary env vars pass through')
      })
    })

    it('preserves PATH and HOME', () => {
      withEnv({ PATH: '/usr/bin', HOME: '/home/x' }, () => {
        const env = buildSpawnEnv('claude')
        assert.equal(env.PATH, '/usr/bin')
        assert.equal(env.HOME, '/home/x')
      })
    })
  })

  describe('extras parameter', () => {
    it('merges extras on top of allowlisted env', () => {
      withEnv({ OPENAI_API_KEY: 'sk' }, () => {
        const env = buildSpawnEnv('codex', { CUSTOM_VAR: 'value1' })
        assert.equal(env.CUSTOM_VAR, 'value1')
        assert.equal(env.OPENAI_API_KEY, 'sk')
      })
    })

    it('extras override env values', () => {
      withEnv({ OPENAI_API_KEY: 'parent-key' }, () => {
        const env = buildSpawnEnv('codex', { OPENAI_API_KEY: 'override-key' })
        assert.equal(env.OPENAI_API_KEY, 'override-key')
      })
    })

    it('merges extras into claude env', () => {
      const env = buildSpawnEnv('claude', { CHROXY_HOOK_SECRET: 'sec', CI: '1' })
      assert.equal(env.CHROXY_HOOK_SECRET, 'sec')
      assert.equal(env.CI, '1')
    })
  })

  describe('unknown provider', () => {
    it('throws for unknown provider', () => {
      assert.throws(
        () => buildSpawnEnv('unknown-provider'),
        /unknown provider/i,
      )
    })
  })

  describe('proxy environment variables (corporate/enterprise forwarding)', () => {
    const proxyVars = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'ALL_PROXY',
      'all_proxy',
    ]

    for (const proxyVar of proxyVars) {
      it(`forwards ${proxyVar} to codex child env`, () => {
        withEnv({ [proxyVar]: 'http://proxy.corp:8080', OPENAI_API_KEY: 'sk' }, () => {
          const env = buildSpawnEnv('codex')
          assert.equal(env[proxyVar], 'http://proxy.corp:8080',
            `${proxyVar} must be forwarded so codex can reach provider APIs through a corporate proxy`)
        })
      })

      it(`forwards ${proxyVar} to gemini child env`, () => {
        withEnv({ [proxyVar]: 'http://proxy.corp:8080', GEMINI_API_KEY: 'g' }, () => {
          const env = buildSpawnEnv('gemini')
          assert.equal(env[proxyVar], 'http://proxy.corp:8080',
            `${proxyVar} must be forwarded so gemini can reach provider APIs through a corporate proxy`)
        })
      })
    }

    it('does NOT forward arbitrary *_PROXY vars outside the allowlist', () => {
      withEnv({
        OPENAI_API_KEY: 'sk',
        MY_PROXY: 'http://attacker:8080',
        INTERNAL_PROXY: 'http://internal',
        CUSTOM_HTTPS_PROXY: 'http://notallowed',
      }, () => {
        const env = buildSpawnEnv('codex')
        assert.equal(env.MY_PROXY, undefined,
          'arbitrary *_PROXY vars must not leak through the allowlist')
        assert.equal(env.INTERNAL_PROXY, undefined)
        assert.equal(env.CUSTOM_HTTPS_PROXY, undefined)
      })
    })
  })
})
