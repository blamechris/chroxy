import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasClaudeOAuthCreds,
  hasCodexOAuthCreds,
  hasGeminiOAuthCreds,
  cachedResolveCredentialFile,
  resetCachesForTest,
} from '../src/auth-probes.js'

// Boundary tests for the auth-probes module extracted from providers.js as
// part of #4769. The pre-refactor behaviour lived in private (`_`-prefixed)
// helpers inside providers.js, so coverage came only through the
// listProviders() integration path. Pinning a direct boundary test lets a
// future maintainer change the probe internals (e.g. add a new claude login
// file path) without having to navigate the dispatcher tests in providers.test.js.

const ENV_KEYS = [
  'CHROXY_CLAUDE_HOME',
  'CHROXY_CLAUDE_CONFIG',
  'CHROXY_CODEX_HOME',
  'CHROXY_GEMINI_HOME',
]

function withSavedEnv(body) {
  const saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  try {
    return body()
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    resetCachesForTest()
  }
}

describe('auth-probes module (#4769)', () => {
  describe('hasClaudeOAuthCreds', () => {
    it('returns false when neither override file exists', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = tmp
          process.env.CHROXY_CLAUDE_CONFIG = join(tmp, '.claude.json')
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), false)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns true when ~/.claude/auth.json exists', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = tmp
          process.env.CHROXY_CLAUDE_CONFIG = join(tmp, '.claude.json')
          writeFileSync(join(tmp, 'auth.json'), '{}')
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), true)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns true when ~/.claude.json has claudeAiOauth block', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = tmp
          const cfg = join(tmp, '.claude.json')
          process.env.CHROXY_CLAUDE_CONFIG = cfg
          writeFileSync(cfg, JSON.stringify({ claudeAiOauth: { refreshToken: 'fake' } }))
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), true)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns false when ~/.claude.json exists but has no claudeAiOauth block', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = tmp
          process.env.CHROXY_CLAUDE_CONFIG = join(tmp, '.claude.json')
          writeFileSync(process.env.CHROXY_CLAUDE_CONFIG, JSON.stringify({ other: 'config' }))
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), false)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns false when ~/.claude.json is malformed JSON', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = tmp
          process.env.CHROXY_CLAUDE_CONFIG = join(tmp, '.claude.json')
          writeFileSync(process.env.CHROXY_CLAUDE_CONFIG, 'this is not { json')
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), false)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })
  })

  describe('hasCodexOAuthCreds', () => {
    it('returns false when auth.json is absent', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-codex-'))
        try {
          process.env.CHROXY_CODEX_HOME = tmp
          resetCachesForTest()
          assert.equal(hasCodexOAuthCreds(), false)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns true when tokens.access_token is a populated string', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-codex-'))
        try {
          process.env.CHROXY_CODEX_HOME = tmp
          writeFileSync(join(tmp, 'auth.json'), JSON.stringify({
            tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' },
          }))
          resetCachesForTest()
          assert.equal(hasCodexOAuthCreds(), true)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns true when OPENAI_API_KEY field is a populated string', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-codex-'))
        try {
          process.env.CHROXY_CODEX_HOME = tmp
          writeFileSync(join(tmp, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-foo' }))
          resetCachesForTest()
          assert.equal(hasCodexOAuthCreds(), true)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns false when tokens is null and OPENAI_API_KEY is null', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-codex-'))
        try {
          process.env.CHROXY_CODEX_HOME = tmp
          writeFileSync(join(tmp, 'auth.json'), JSON.stringify({ tokens: null, OPENAI_API_KEY: null }))
          resetCachesForTest()
          assert.equal(hasCodexOAuthCreds(), false)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns false when auth.json is malformed', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-codex-'))
        try {
          process.env.CHROXY_CODEX_HOME = tmp
          writeFileSync(join(tmp, 'auth.json'), 'not json')
          resetCachesForTest()
          assert.equal(hasCodexOAuthCreds(), false)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })
  })

  describe('hasGeminiOAuthCreds', () => {
    it('returns false when neither oauth file exists', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-gemini-'))
        try {
          process.env.CHROXY_GEMINI_HOME = tmp
          resetCachesForTest()
          assert.equal(hasGeminiOAuthCreds(), false)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns true when oauth_creds.json exists', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-gemini-'))
        try {
          process.env.CHROXY_GEMINI_HOME = tmp
          writeFileSync(join(tmp, 'oauth_creds.json'), '{}')
          resetCachesForTest()
          assert.equal(hasGeminiOAuthCreds(), true)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns true when google_accounts.json exists', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-gemini-'))
        try {
          process.env.CHROXY_GEMINI_HOME = tmp
          writeFileSync(join(tmp, 'google_accounts.json'), '{}')
          resetCachesForTest()
          assert.equal(hasGeminiOAuthCreds(), true)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })
  })

  describe('cachedResolveCredentialFile', () => {
    it('short-circuits to resolver result when env var is set (no fs read)', () => {
      withSavedEnv(() => {
        resetCachesForTest()
        let called = 0
        const result = { key: 'sk-test', source: 'env', reason: '' }
        const r1 = cachedResolveCredentialFile('byok', 'sk-test', () => {
          called++
          return result
        })
        assert.equal(called, 1)
        assert.equal(r1.key, 'sk-test')

        // Repeat call with same env value reuses the cached entry without
        // re-invoking the resolver.
        const r2 = cachedResolveCredentialFile('byok', 'sk-test', () => {
          called++
          return { key: 'should-not-be-returned' }
        })
        assert.equal(called, 1, 'cached env-path entry must not re-invoke resolver')
        assert.equal(r2.key, 'sk-test')
      })
    })

    it('refreshes when the env value changes', () => {
      withSavedEnv(() => {
        resetCachesForTest()
        let lastCall = null
        const probe = (val) => () => {
          lastCall = val
          return { key: val, source: 'env', reason: '' }
        }
        const a = cachedResolveCredentialFile('byok', 'A', probe('A'))
        const b = cachedResolveCredentialFile('byok', 'B', probe('B'))
        assert.equal(a.key, 'A')
        assert.equal(b.key, 'B')
        assert.equal(lastCall, 'B')
      })
    })

    it('synthesises an ENOENT reason without invoking resolver when file is missing', () => {
      withSavedEnv(() => {
        resetCachesForTest()
        // Point HOME at a tmpdir that has NO .chroxy/credentials.json so the
        // ENOENT branch triggers without dragging in the real user file.
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-byok-noent-'))
        const savedHome = process.env.HOME
        process.env.HOME = tmp
        try {
          let called = 0
          const r = cachedResolveCredentialFile('byok', undefined, () => {
            called++
            return { key: 'should-not-be-called' }
          })
          assert.equal(called, 0, 'ENOENT short-circuit must skip resolver')
          assert.equal(r.key, null)
          assert.equal(r.source, 'none')
          assert.match(r.reason, /ANTHROPIC_API_KEY not set/)
          assert.match(r.reason, /does not exist/)
        } finally {
          if (savedHome === undefined) delete process.env.HOME
          else process.env.HOME = savedHome
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('synthesises DEEPSEEK_API_KEY reason for the deepseek slot', () => {
      withSavedEnv(() => {
        resetCachesForTest()
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-ds-noent-'))
        const savedHome = process.env.HOME
        process.env.HOME = tmp
        try {
          const r = cachedResolveCredentialFile('deepseek', undefined, () => ({ key: null }))
          assert.equal(r.source, 'none')
          assert.match(r.reason, /DEEPSEEK_API_KEY not set/)
        } finally {
          if (savedHome === undefined) delete process.env.HOME
          else process.env.HOME = savedHome
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })
  })

  describe('resetCachesForTest', () => {
    it('drops both caches so a subsequent probe re-runs from scratch', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-reset-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = tmp
          process.env.CHROXY_CLAUDE_CONFIG = join(tmp, '.claude.json')
          resetCachesForTest()
          // First probe: no file → false.
          assert.equal(hasClaudeOAuthCreds(), false)
          // Add the auth file. Without resetCachesForTest the 5s TTL would
          // keep returning the cached false.
          writeFileSync(join(tmp, 'auth.json'), '{}')
          assert.equal(hasClaudeOAuthCreds(), false, 'TTL cache hides the new file')
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), true, 'after reset the fresh probe sees the new file')
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })
  })
})
