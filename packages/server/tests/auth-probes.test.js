import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #7052 — the sandbox config dir this process started with. Tests below
// relocate it alongside HOME and restore it here on teardown.
const __sandboxConfigDir = process.env.CHROXY_CONFIG_DIR
import {
  hasClaudeOAuthCreds,
  hasCodexOAuthCreds,
  hasGeminiOAuthCreds,
  cachedResolveCredentialFile,
  resetCachesForTest,
  claudeKeychainProbeArgv,
  keychainItemExists,
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
  'CHROXY_CLAUDE_KEYCHAIN',
  'CHROXY_CODEX_HOME',
  'CHROXY_GEMINI_HOME',
]

/**
 * Run `body` with every override cleared — and with the macOS Keychain probe
 * (#7331) forced ABSENT unless the test says otherwise.
 *
 * That default is not a convenience, it is what makes these tests mean
 * anything. The probe consults the real Keychain on darwin, so without it the
 * "returns false when no creds exist" cases pass or fail depending on whether
 * the developer running them happens to be logged into Claude Code — four of
 * them flipped to failing the moment the Keychain check landed. A credential
 * probe whose tests read ambient machine state is not testing the probe.
 */
function withSavedEnv(body) {
  const saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.CHROXY_CLAUDE_KEYCHAIN = '0'
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

  describe('hasClaudeOAuthCreds — macOS Keychain + oauthAccount (#7331)', () => {
    // The bug: on a fully authenticated CURRENT macOS install the probe
    // returned false — `~/.claude/auth.json` and `.credentials.json` both
    // absent, `~/.claude.json` carrying `oauthAccount` rather than
    // `claudeAiOauth`, and the real credential in the Keychain the probe never
    // consulted. `CreateSessionModal` disables Create on `ready === false`, so
    // a logged-in user could not start an SDK session at all.

    it('accepts `oauthAccount` in ~/.claude.json, not just `claudeAiOauth`', () => {
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = join(tmp, '.claude')
          const cfg = join(tmp, '.claude.json')
          process.env.CHROXY_CLAUDE_CONFIG = cfg
          writeFileSync(cfg, JSON.stringify({ oauthAccount: { emailAddress: 'x@example.com' } }))
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), true)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('finds creds in the Keychain when NO file on disk has them', () => {
      // The exact shape of the reported machine: every file check misses and
      // the Keychain is the only thing that knows.
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = join(tmp, '.claude')
          process.env.CHROXY_CLAUDE_CONFIG = join(tmp, '.claude.json')
          process.env.CHROXY_CLAUDE_KEYCHAIN = '1'
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), true)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('returns FALSE when the Keychain is empty and no file has creds', () => {
      // The direction that matters. A probe returning true unconditionally
      // would satisfy the bug report and be just as broken as the original;
      // this is the assertion that separates the two.
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = join(tmp, '.claude')
          process.env.CHROXY_CLAUDE_CONFIG = join(tmp, '.claude.json')
          process.env.CHROXY_CLAUDE_KEYCHAIN = '0'
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), false)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('a config with neither oauth key is still not creds', () => {
      // Guards the `oauthAccount` widening from becoming "any object passes".
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = join(tmp, '.claude')
          const cfg = join(tmp, '.claude.json')
          process.env.CHROXY_CLAUDE_CONFIG = cfg
          writeFileSync(cfg, JSON.stringify({ numStartups: 12, theme: 'dark' }))
          resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), false)
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('the Keychain verdict is part of the cache key, not smeared across the TTL', () => {
      // The probe is cached for 5s. If the override were absent from the key,
      // flipping it inside that window would return the stale verdict and the
      // logged-out assertion above would pass for the wrong reason.
      withSavedEnv(() => {
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-claude-'))
        try {
          process.env.CHROXY_CLAUDE_HOME = join(tmp, '.claude')
          process.env.CHROXY_CLAUDE_CONFIG = join(tmp, '.claude.json')
          resetCachesForTest()
          process.env.CHROXY_CLAUDE_KEYCHAIN = '1'
          assert.equal(hasClaudeOAuthCreds(), true)
          process.env.CHROXY_CLAUDE_KEYCHAIN = '0'   // no resetCachesForTest()
          assert.equal(hasClaudeOAuthCreds(), false, 'the flip must not read a cached verdict')
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })
  })

  describe('the Keychain probe itself (#7331)', () => {
    // The CHROXY_CLAUDE_KEYCHAIN override that keeps the tests above hermetic
    // also short-circuits before the real code — so without this block the
    // spawn, the exit-code handling and the argv had NO coverage at all, and
    // mutations to all three passed green. These exercise the real thing.

    it('never asks `security` to print the secret', () => {
      // `-w` makes `security` write the password to stdout. A readiness probe
      // must never be able to; this is the guard, and it is deliberately a
      // source-shape assertion because the spawn is rarely reached under test.
      const argv = claudeKeychainProbeArgv()
      assert.equal(argv.includes('-w'), false, '-w would print the credential')
      assert.equal(argv.includes('-g'), false, '-g would print the credential')
      assert.ok(argv.includes('-s'), 'must query by service name')
      assert.ok(argv.includes('Claude Code-credentials'))
    })

    it('reports absent for a service that does not exist (real spawn)', () => {
      // Runs the actual `security` binary on darwin — the only test that
      // exercises spawn + non-zero exit. Uses a service name nothing owns, so
      // it does not depend on whether the developer is logged in.
      assert.equal(keychainItemExists('chroxy-nonexistent-service-7331'), false)
    })

    it('reports absent without spawning on non-darwin', function () {
      if (process.platform === 'darwin') return   // covered by the CI Linux job
      assert.equal(keychainItemExists('Claude Code-credentials'), false)
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
        process.env.CHROXY_CONFIG_DIR = join(tmp, '.chroxy')
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
          process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('lazily creates dynamic slots and caches by env value (#5461)', () => {
      withSavedEnv(() => {
        resetCachesForTest()
        let called = 0
        const r1 = cachedResolveCredentialFile('compat:ZAI_API_KEY:zaiApiKey', 'sk-dyn', () => {
          called++
          return { key: 'sk-dyn', source: 'env' }
        })
        assert.equal(called, 1)
        assert.equal(r1.key, 'sk-dyn')

        const r2 = cachedResolveCredentialFile('compat:ZAI_API_KEY:zaiApiKey', 'sk-dyn', () => {
          called++
          return { key: 'should-not-be-returned' }
        })
        assert.equal(called, 1, 'cached dynamic-slot entry must not re-invoke resolver')
        assert.equal(r2.key, 'sk-dyn')

        // A different dynamic slot is independent.
        const r3 = cachedResolveCredentialFile('compat:OTHER_KEY:otherApiKey', 'sk-other', () => {
          called++
          return { key: 'sk-other', source: 'env' }
        })
        assert.equal(called, 2, 'distinct dynamic slots must not share cache entries')
        assert.equal(r3.key, 'sk-other')
      })
    })

    it('dynamic-slot ENOENT reason uses the provided env var name (#5461)', () => {
      withSavedEnv(() => {
        resetCachesForTest()
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-dyn-noent-'))
        const savedHome = process.env.HOME
        process.env.HOME = tmp
        process.env.CHROXY_CONFIG_DIR = join(tmp, '.chroxy')
        try {
          let called = 0
          const r = cachedResolveCredentialFile('compat:ZAI_API_KEY:zaiApiKey', undefined, () => {
            called++
            return { key: 'should-not-be-called' }
          }, 'ZAI_API_KEY')
          assert.equal(called, 0, 'ENOENT short-circuit must skip resolver')
          assert.equal(r.key, null)
          assert.equal(r.source, 'none')
          assert.match(r.reason, /ZAI_API_KEY not set and .*does not exist/)
        } finally {
          if (savedHome === undefined) delete process.env.HOME
          else process.env.HOME = savedHome
          process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
          rmSync(tmp, { recursive: true, force: true })
        }
      })
    })

    it('dynamic-slot ENOENT reason omits the env clause when no env var is configured (#5461)', () => {
      withSavedEnv(() => {
        resetCachesForTest()
        const tmp = mkdtempSync(join(tmpdir(), 'auth-probes-dyn-noent-'))
        const savedHome = process.env.HOME
        process.env.HOME = tmp
        process.env.CHROXY_CONFIG_DIR = join(tmp, '.chroxy')
        try {
          const r = cachedResolveCredentialFile('compat::zaiApiKey', undefined, () => ({ key: null }), null)
          assert.equal(r.key, null)
          assert.equal(r.source, 'none')
          assert.doesNotMatch(r.reason, /not set/)
          assert.match(r.reason, /does not exist/)
        } finally {
          if (savedHome === undefined) delete process.env.HOME
          else process.env.HOME = savedHome
          process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
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
        process.env.CHROXY_CONFIG_DIR = join(tmp, '.chroxy')
        try {
          const r = cachedResolveCredentialFile('deepseek', undefined, () => ({ key: null }))
          assert.equal(r.source, 'none')
          assert.match(r.reason, /DEEPSEEK_API_KEY not set/)
        } finally {
          if (savedHome === undefined) delete process.env.HOME
          else process.env.HOME = savedHome
          process.env.CHROXY_CONFIG_DIR = __sandboxConfigDir
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

    it('drops dynamic credential-file slots (#5461)', () => {
      withSavedEnv(() => {
        resetCachesForTest()
        let called = 0
        cachedResolveCredentialFile('compat:X:y', 'v', () => { called++; return { key: 'v1' } })
        cachedResolveCredentialFile('compat:X:y', 'v', () => { called++; return { key: 'v2' } })
        assert.equal(called, 1, 'precondition: the dynamic slot is cached')
        resetCachesForTest()
        const r = cachedResolveCredentialFile('compat:X:y', 'v', () => { called++; return { key: 'v3' } })
        assert.equal(called, 2, 'reset must drop dynamic slots')
        assert.equal(r.key, 'v3')
      })
    })
  })
})
