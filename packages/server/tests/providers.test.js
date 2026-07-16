import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, utimesSync, unlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerProvider, getProvider, listProviders, registerDockerProvider, _resetCredsCacheForTest, validateProviderClass, getRegisteredProviderNames } from '../src/providers.js'
import { CliSession } from '../src/cli-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { CodexSession } from '../src/codex-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { GeminiSession } from '../src/gemini-session.js'

describe('Provider Registry', () => {
  it('has claude-cli and claude-sdk pre-registered', () => {
    const cli = getProvider('claude-cli')
    const sdk = getProvider('claude-sdk')
    assert.equal(cli, CliSession)
    assert.equal(sdk, SdkSession)
  })

  it('getProvider throws on unknown provider', () => {
    assert.throws(
      () => getProvider('unknown-provider'),
      /Unknown provider "unknown-provider"/
    )
  })

  it('getProvider error message lists available providers', () => {
    try {
      getProvider('nope')
      assert.fail('should have thrown')
    } catch (err) {
      assert.ok(err.message.includes('claude-cli'))
      assert.ok(err.message.includes('claude-sdk'))
    }
  })

  it('registerProvider validates name', () => {
    assert.throws(() => registerProvider('', class {}), /non-empty string/)
    assert.throws(() => registerProvider(null, class {}), /non-empty string/)
  })

  it('registerProvider validates class', () => {
    assert.throws(() => registerProvider('test', 'not-a-class'), /must be a class/)
  })

  it('registerProvider + getProvider round-trip', () => {
    class TestProvider {
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
      start() {}
      destroy() {}
    }
    registerProvider('test-roundtrip', TestProvider)
    assert.equal(getProvider('test-roundtrip'), TestProvider)
  })

  // #5555: validateProviderClass was only invoked on the registerProvider()
  // path (Docker / external). The built-ins in the PROVIDERS literal, seeded via
  // the registry construction loop, got NO interface check — the contract
  // didn't cover its main case. The loop now validates every built-in at module
  // load, so a regressed built-in fails loudly instead of deep in a live session.
  describe('built-in provider contract validation (#5555)', () => {
    it('every registered built-in passes validateProviderClass', () => {
      // The module already loaded (and the seeding loop already validated), so
      // reaching this test at all proves no built-in throws. Re-assert per
      // built-in for a precise failure message if one ever regresses.
      const builtins = getRegisteredProviderNames().filter(n => !n.startsWith('test-') && !n.startsWith('docker-'))
      assert.ok(builtins.length >= 9, 'expected the 9 first-class built-ins to be registered')
      for (const name of builtins) {
        const ProviderClass = getProvider(name)
        assert.doesNotThrow(() => validateProviderClass(ProviderClass, name),
          `built-in '${name}' must satisfy the ProviderSession contract`)
      }
    })

    it('a bogus built-in (missing a required method) fails loudly — mirrors the seeding loop', () => {
      // Simulate what the registry construction loop does to each entry of the
      // PROVIDERS literal: a class dropping a required method must throw, naming
      // the method, rather than register silently and explode at call time.
      class BogusProvider {
        sendMessage() {}
        interrupt() {}
        setModel() {}
        setPermissionMode() {}
        start() {}
        // destroy() intentionally omitted
      }
      assert.throws(
        () => validateProviderClass(BogusProvider, 'bogus-builtin'),
        /missing required method: destroy/,
      )
    })

    it('a built-in claiming inProcessPermissions without the methods fails loudly', () => {
      class HalfBakedInProcess {
        sendMessage() {}
        interrupt() {}
        setModel() {}
        setPermissionMode() {}
        start() {}
        destroy() {}
        static get capabilities() { return { inProcessPermissions: true } }
        // respondToPermission / respondToQuestion intentionally omitted
      }
      assert.throws(
        () => validateProviderClass(HalfBakedInProcess, 'half-baked'),
        /inProcessPermissions=true but is missing required method/,
      )
    })
  })

  it('listProviders returns registered providers with capabilities', () => {
    const list = listProviders()
    assert.ok(Array.isArray(list))
    assert.ok(list.length >= 2)

    const cliEntry = list.find(p => p.name === 'claude-cli')
    assert.ok(cliEntry)
    assert.equal(cliEntry.capabilities.permissions, true)
    assert.equal(cliEntry.capabilities.inProcessPermissions, false)
    // #4887 — claude CLI supports `--resume <id>`; CliSession now wires
    // `_sessionId` into the spawn argv on respawn / restore so the model
    // retains conversation context. Persistence layer round-trips the id.
    assert.equal(cliEntry.capabilities.resume, true)

    const sdkEntry = list.find(p => p.name === 'claude-sdk')
    assert.ok(sdkEntry)
    assert.equal(sdkEntry.capabilities.permissions, true)
    assert.equal(sdkEntry.capabilities.inProcessPermissions, true)
    assert.equal(sdkEntry.capabilities.resume, true)
  })

  // #5609: clients word the auto-mode confirm dialog off this flag. Only CLI
  // interrupts the in-flight turn when switching to auto (subprocess respawn —
  // the #3729 panic-button); SDK/TUI apply the switch in-place.
  it('listProviders surfaces interruptsTurnOnAutoSwitch only for claude-cli', () => {
    const list = listProviders()
    const cliEntry = list.find(p => p.name === 'claude-cli')
    assert.ok(cliEntry, 'claude-cli provider should be registered')
    assert.equal(cliEntry.capabilities.interruptsTurnOnAutoSwitch, true,
      'claude-cli respawns its subprocess on auto-switch so should report interruptsTurnOnAutoSwitch: true')

    const sdkEntry = list.find(p => p.name === 'claude-sdk')
    assert.ok(sdkEntry, 'claude-sdk provider should be registered')
    assert.equal(sdkEntry.capabilities.interruptsTurnOnAutoSwitch, false,
      'claude-sdk applies the auto-switch in-process so should report interruptsTurnOnAutoSwitch: false')

    const tuiEntry = list.find(p => p.name === 'claude-tui')
    if (tuiEntry) {
      assert.equal(tuiEntry.capabilities.interruptsTurnOnAutoSwitch, false,
        'claude-tui rewrites a sidecar (no PTY restart) so should report interruptsTurnOnAutoSwitch: false')
    }
  })

  // #3072: clients gate the "Allow for Session" affordance on this capability
  // so they don't surface a button that the server would reject as
  // "not supported by this provider".
  it('listProviders surfaces sessionRules capability derived from setPermissionRules', () => {
    const list = listProviders()
    const sdkEntry = list.find(p => p.name === 'claude-sdk')
    assert.ok(sdkEntry, 'claude-sdk provider should be registered')
    assert.equal(sdkEntry.capabilities.sessionRules, true,
      'claude-sdk implements setPermissionRules so should report sessionRules: true')

    const cliEntry = list.find(p => p.name === 'claude-cli')
    assert.ok(cliEntry, 'claude-cli provider should be registered')
    assert.equal(cliEntry.capabilities.sessionRules, false,
      'claude-cli does not implement setPermissionRules so should report sessionRules: false')

    const codexEntry = list.find(p => p.name === 'codex')
    if (codexEntry) {
      assert.equal(codexEntry.capabilities.sessionRules, false,
        'codex does not implement setPermissionRules so should report sessionRules: false')
    }

    const geminiEntry = list.find(p => p.name === 'gemini')
    if (geminiEntry) {
      assert.equal(geminiEntry.capabilities.sessionRules, false,
        'gemini does not implement setPermissionRules so should report sessionRules: false')
    }
  })

  // #6618: the picker (listProviders) advertised codex's EXEC capability shape
  // (from the static PROVIDERS literal) while a live codex session is the
  // app-server driver (getProvider default), so the two disagreed on
  // permissions/inProcessPermissions/permissionModeSwitch. listProviders now
  // resolves through getProvider so the picker tracks the runtime driver,
  // honoring CHROXY_CODEX_APPSERVER.
  it('listProviders codex caps match the runtime driver, honoring CHROXY_CODEX_APPSERVER (#6618)', () => {
    const orig = process.env.CHROXY_CODEX_APPSERVER
    const CAP_KEYS = ['permissions', 'inProcessPermissions', 'permissionModeSwitch']
    try {
      for (const [label, val] of [['default (app-server)', undefined], ['opt-out (=0)', '0']]) {
        if (val === undefined) delete process.env.CHROXY_CODEX_APPSERVER
        else process.env.CHROXY_CODEX_APPSERVER = val
        const codexEntry = listProviders().find(p => p.name === 'codex')
        assert.ok(codexEntry, `codex provider registered (${label})`)
        const runtimeCaps = getProvider('codex').capabilities
        for (const k of CAP_KEYS) {
          assert.equal(codexEntry.capabilities[k], runtimeCaps[k],
            `picker codex.${k} must match the runtime driver in ${label}`)
        }
      }
      // Concretely: default = app-server (approval-capable), =0 = exec (no approvals).
      delete process.env.CHROXY_CODEX_APPSERVER
      const defaultList = listProviders()
      assert.equal(defaultList.find(p => p.name === 'codex').capabilities.permissions, true,
        'codex default (app-server) advertises approvals in the picker')
      process.env.CHROXY_CODEX_APPSERVER = '0'
      const optOutList = listProviders()
      assert.equal(optOutList.find(p => p.name === 'codex').capabilities.permissions, false,
        'codex exec opt-out advertises no approvals in the picker')

      // No-op for every OTHER provider: resolving through getProvider only swaps
      // codex, so a non-codex entry's caps must be identical across the env flip.
      for (const name of ['claude-sdk', 'claude-cli']) {
        const a = defaultList.find(p => p.name === name)
        const b = optOutList.find(p => p.name === name)
        if (a && b) assert.deepEqual(a.capabilities, b.capabilities,
          `${name} caps must not change with CHROXY_CODEX_APPSERVER (only codex is resolved)`)
      }
    } finally {
      if (orig === undefined) delete process.env.CHROXY_CODEX_APPSERVER
      else process.env.CHROXY_CODEX_APPSERVER = orig
    }
  })

  // #3404 audit (F1+F5): listProviders must surface auth/credentials state
  // so the dashboard can grey-out unusable providers and show a billing-
  // identity confidence panel without making the user run `chroxy doctor`.
  describe('auth status (#3404 audit)', () => {
    const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'CHROXY_CLAUDE_HOME', 'CHROXY_CLAUDE_CONFIG', 'CHROXY_CODEX_HOME', 'CHROXY_GEMINI_HOME']
    const saved = {}
    let _tmpClaudeHome = null
    let _tmpCodexHome = null
    let _tmpGeminiHome = null

    function clearKeys() {
      for (const k of ENV_KEYS) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      // #3674: point the OAuth probe at an empty tmpdir so neither the
      // developer's actual ~/.claude state nor a previous test's leftover
      // can satisfy `_hasClaudeOAuthCreds()` and silently keep optional-
      // creds providers reporting ready=true.
      _tmpClaudeHome = mkdtempSync(join(tmpdir(), 'chroxy-claude-home-'))
      process.env.CHROXY_CLAUDE_HOME = _tmpClaudeHome
      process.env.CHROXY_CLAUDE_CONFIG = join(_tmpClaudeHome, '.claude.json')
      // #4301: same isolation pattern for the new codex/gemini OAuth probes —
      // point them at empty tmpdirs so neither the developer's real ~/.codex
      // or ~/.gemini state nor any prior test leftover leaks in.
      _tmpCodexHome = mkdtempSync(join(tmpdir(), 'chroxy-codex-home-'))
      process.env.CHROXY_CODEX_HOME = _tmpCodexHome
      _tmpGeminiHome = mkdtempSync(join(tmpdir(), 'chroxy-gemini-home-'))
      process.env.CHROXY_GEMINI_HOME = _tmpGeminiHome
      // #3678: drop the cached creds-probe result. The env-var-keyed cache
      // already invalidates on key change, but tests sometimes write/delete
      // files under CHROXY_CLAUDE_HOME after clearKeys() runs — explicitly
      // resetting prevents a stale-cache flake under any future reordering.
      _resetCredsCacheForTest()
    }
    function restoreKeys() {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      if (_tmpClaudeHome) {
        try { rmSync(_tmpClaudeHome, { recursive: true, force: true }) } catch {}
        _tmpClaudeHome = null
      }
      if (_tmpCodexHome) {
        try { rmSync(_tmpCodexHome, { recursive: true, force: true }) } catch {}
        _tmpCodexHome = null
      }
      if (_tmpGeminiHome) {
        try { rmSync(_tmpGeminiHome, { recursive: true, force: true }) } catch {}
        _tmpGeminiHome = null
      }
      // #3678: drop the cache so the next test (or a parallel describe block)
      // doesn't see a value bound to an env-var combo we just unset.
      _resetCredsCacheForTest()
    }

    it('claude-sdk reports source=env and ready when ANTHROPIC_API_KEY is set', () => {
      try {
        clearKeys()
        process.env.ANTHROPIC_API_KEY = 'sk-test'
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.ok(sdk?.auth, 'claude-sdk should expose auth')
        assert.equal(sdk.auth.ready, true)
        assert.equal(sdk.auth.source, 'env')
        assert.equal(sdk.auth.envVar, 'ANTHROPIC_API_KEY')
        assert.match(sdk.auth.detail, /ANTHROPIC_API_KEY/)
        // #5630: an explicit ANTHROPIC_API_KEY is a raw API account →
        // api-key class in BOTH eras (the refinement, not the credit pool).
        assert.equal(sdk.auth.billingClass, 'api-key')
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk reports ready=false when no env var AND no claude login state on disk (#3674)', () => {
      try {
        clearKeys()
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        // No env var, empty CHROXY_CLAUDE_HOME → no OAuth probe hit → ready=false
        assert.equal(sdk.auth.ready, false)
        assert.equal(sdk.auth.source, 'none')
        assert.equal(sdk.auth.envVar, null)
        assert.match(sdk.auth.hint, /claude login|ANTHROPIC_API_KEY/)
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk reports ready=true source=oauth when ~/.claude/auth.json exists (#3674)', () => {
      try {
        clearKeys()
        writeFileSync(join(_tmpClaudeHome, 'auth.json'), '{}')
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.equal(sdk.auth.ready, true)
        assert.equal(sdk.auth.source, 'oauth')
        assert.match(sdk.auth.detail, /OAuth from `claude login`/)
        // #5630/#5629: OAuth = the host pool, era-gated. Before 2026-06-15 it's
        // subscription; on/after it's programmatic-credit. Either is valid here
        // depending on the wall-clock era (deterministic per-era coverage lives
        // in billing-class.test.js). Never api-key on the OAuth branch.
        assert.ok(
          sdk.auth.billingClass === 'subscription' || sdk.auth.billingClass === 'programmatic-credit',
          `OAuth branch must be host-pool class; got ${sdk.auth.billingClass}`,
        )
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk reports ready=true source=oauth when ~/.claude/.credentials.json exists (#3674)', () => {
      try {
        clearKeys()
        writeFileSync(join(_tmpClaudeHome, '.credentials.json'), '{}')
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.equal(sdk.auth.ready, true)
        assert.equal(sdk.auth.source, 'oauth')
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk reports ready=true source=oauth when ~/.claude.json has claudeAiOauth block (#3674)', () => {
      try {
        clearKeys()
        writeFileSync(
          process.env.CHROXY_CLAUDE_CONFIG,
          JSON.stringify({ claudeAiOauth: { refreshToken: 'fake' }, otherStuff: true }),
        )
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.equal(sdk.auth.ready, true)
        assert.equal(sdk.auth.source, 'oauth')
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk stays ready=false when ~/.claude.json has no claudeAiOauth block (#3674)', () => {
      try {
        clearKeys()
        writeFileSync(process.env.CHROXY_CLAUDE_CONFIG, JSON.stringify({ unrelated: 'config' }))
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.equal(sdk.auth.ready, false)
        assert.equal(sdk.auth.source, 'none')
      } finally {
        restoreKeys()
      }
    })

    // Copilot review of #3677: _hasClaudeOAuthCreds catches JSON parse errors
    // and treats them as "no creds". Lock that in so a future refactor can't
    // accidentally make a malformed config crash the server-wide listProviders
    // call.
    it('claude-sdk stays ready=false when ~/.claude.json is malformed JSON (#3677 review)', () => {
      try {
        clearKeys()
        writeFileSync(process.env.CHROXY_CLAUDE_CONFIG, 'this is not { valid json')
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.equal(sdk.auth.ready, false)
        assert.equal(sdk.auth.source, 'none')
      } finally {
        restoreKeys()
      }
    })

    it('claude-cli reports source=oauth regardless of env (CLI strips the key)', () => {
      try {
        clearKeys()
        process.env.ANTHROPIC_API_KEY = 'sk-test'
        const list = listProviders()
        const cli = list.find(p => p.name === 'claude-cli')
        // CLI strips ANTHROPIC_API_KEY before spawn, so it always auths via the
        // host OAuth/subscription pool — never the raw-API account, even with a
        // key set. That's the invariant under test here.
        assert.equal(cli.auth.source, 'oauth')
        assert.equal(cli.auth.ready, true)
        // The billing DETAIL is era-dependent (flat subscription before the
        // 2026-06-15 cutover, metered programmatic-credit on/after) and listProviders
        // reads the real clock — so accept either rather than coupling this test to
        // the wall date. The exact era flip is pinned with injected time in
        // billing-class.test.js.
        assert.match(cli.auth.detail, /subscription|programmatic|credit/i)
      } finally {
        restoreKeys()
      }
    })

    it('codex reports ready=false and source=none when OPENAI_API_KEY is missing AND no codex login', () => {
      try {
        clearKeys()
        const list = listProviders()
        const codex = list.find(p => p.name === 'codex')
        if (!codex) return // codex registration may be conditional in test env
        assert.equal(codex.auth.ready, false)
        assert.equal(codex.auth.source, 'none')
        assert.match(codex.auth.detail, /OPENAI_API_KEY/)
        // #4301: hint must now mention the `codex login` OAuth path too so the
        // user knows env var isn't the only way to authenticate.
        assert.match(codex.auth.hint, /codex login/)
      } finally {
        restoreKeys()
      }
    })

    // #4301: Codex CLI's `codex login` writes a JSON auth file under ~/.codex/
    // with a populated `tokens` block. The CLI works fine even when the file's
    // OPENAI_API_KEY field is null because the OAuth tokens carry the round-
    // trip. The preflight must recognise this state as ready, not "credentials
    // missing".
    it('codex reports ready=true source=oauth when ~/.codex/auth.json has tokens (#4301)', () => {
      try {
        clearKeys()
        writeFileSync(
          join(_tmpCodexHome, 'auth.json'),
          JSON.stringify({
            OPENAI_API_KEY: null,
            tokens: {
              id_token: 'fake.id.token',
              access_token: 'fake-access-token',
              refresh_token: 'fake-refresh-token',
              account_id: 'fake-account',
            },
            last_refresh: '2026-05-26T00:00:00.000Z',
          }),
        )
        const list = listProviders()
        const codex = list.find(p => p.name === 'codex')
        if (!codex) return
        assert.equal(codex.auth.ready, true)
        assert.equal(codex.auth.source, 'oauth')
        assert.equal(codex.auth.envVar, null)
        assert.match(codex.auth.detail, /OAuth from `codex login`/)
      } finally {
        restoreKeys()
      }
    })

    it('codex reports ready=true source=oauth when auth.json embeds OPENAI_API_KEY string (#4301)', () => {
      try {
        clearKeys()
        writeFileSync(
          join(_tmpCodexHome, 'auth.json'),
          JSON.stringify({ OPENAI_API_KEY: 'sk-from-file', tokens: null }),
        )
        const list = listProviders()
        const codex = list.find(p => p.name === 'codex')
        if (!codex) return
        assert.equal(codex.auth.ready, true)
        assert.equal(codex.auth.source, 'oauth')
      } finally {
        restoreKeys()
      }
    })

    it('codex stays ready=false when auth.json exists but tokens block is null/empty (#4301)', () => {
      try {
        clearKeys()
        writeFileSync(
          join(_tmpCodexHome, 'auth.json'),
          JSON.stringify({ OPENAI_API_KEY: null, tokens: null }),
        )
        const list = listProviders()
        const codex = list.find(p => p.name === 'codex')
        if (!codex) return
        assert.equal(codex.auth.ready, false)
        assert.equal(codex.auth.source, 'none')
      } finally {
        restoreKeys()
      }
    })

    it('codex stays ready=false when ~/.codex/auth.json is malformed JSON (#4301)', () => {
      try {
        clearKeys()
        writeFileSync(join(_tmpCodexHome, 'auth.json'), 'this is not { valid json')
        const list = listProviders()
        const codex = list.find(p => p.name === 'codex')
        if (!codex) return
        assert.equal(codex.auth.ready, false)
        assert.equal(codex.auth.source, 'none')
      } finally {
        restoreKeys()
      }
    })

    it('codex env var still wins over OAuth file (env reported as source=env) (#4301)', () => {
      try {
        clearKeys()
        process.env.OPENAI_API_KEY = 'sk-from-env'
        writeFileSync(
          join(_tmpCodexHome, 'auth.json'),
          JSON.stringify({ tokens: { access_token: 'fake' } }),
        )
        const list = listProviders()
        const codex = list.find(p => p.name === 'codex')
        if (!codex) return
        assert.equal(codex.auth.ready, true)
        assert.equal(codex.auth.source, 'env')
        assert.equal(codex.auth.envVar, 'OPENAI_API_KEY')
      } finally {
        restoreKeys()
      }
    })

    it('gemini reports ready when GEMINI_API_KEY is set', () => {
      try {
        clearKeys()
        process.env.GEMINI_API_KEY = 'test-key'
        const list = listProviders()
        const gemini = list.find(p => p.name === 'gemini')
        if (!gemini) return
        assert.equal(gemini.auth.ready, true)
        assert.equal(gemini.auth.source, 'env')
        assert.equal(gemini.auth.envVar, 'GEMINI_API_KEY')
      } finally {
        restoreKeys()
      }
    })

    it('gemini reports ready when GOOGLE_API_KEY is set (without GEMINI_API_KEY)', () => {
      try {
        clearKeys()
        process.env.GOOGLE_API_KEY = 'test-key'
        const list = listProviders()
        const gemini = list.find(p => p.name === 'gemini')
        if (!gemini) return
        assert.equal(gemini.auth.ready, true)
        assert.equal(gemini.auth.source, 'env')
        assert.equal(gemini.auth.envVar, 'GOOGLE_API_KEY')
      } finally {
        restoreKeys()
      }
    })

    // #4301: Gemini CLI's `gemini login` caches OAuth state under ~/.gemini/
    // (filename varies between CLI versions — oauth_creds.json or
    // google_accounts.json). Preflight must recognise either as authed.
    it('gemini reports ready=true source=oauth when ~/.gemini/oauth_creds.json exists (#4301)', () => {
      try {
        clearKeys()
        writeFileSync(join(_tmpGeminiHome, 'oauth_creds.json'), '{}')
        const list = listProviders()
        const gemini = list.find(p => p.name === 'gemini')
        if (!gemini) return
        assert.equal(gemini.auth.ready, true)
        assert.equal(gemini.auth.source, 'oauth')
        assert.equal(gemini.auth.envVar, null)
        assert.match(gemini.auth.detail, /OAuth from `gemini login`/)
      } finally {
        restoreKeys()
      }
    })

    it('gemini reports ready=true source=oauth when ~/.gemini/google_accounts.json exists (#4301)', () => {
      try {
        clearKeys()
        writeFileSync(join(_tmpGeminiHome, 'google_accounts.json'), '{}')
        const list = listProviders()
        const gemini = list.find(p => p.name === 'gemini')
        if (!gemini) return
        assert.equal(gemini.auth.ready, true)
        assert.equal(gemini.auth.source, 'oauth')
      } finally {
        restoreKeys()
      }
    })

    it('gemini reports ready=false with combined hint when no env var AND no login state (#4301)', () => {
      try {
        clearKeys()
        const list = listProviders()
        const gemini = list.find(p => p.name === 'gemini')
        if (!gemini) return
        assert.equal(gemini.auth.ready, false)
        assert.equal(gemini.auth.source, 'none')
        // Hint must now mention both env vars AND `gemini login`.
        assert.match(gemini.auth.hint, /GEMINI_API_KEY|GOOGLE_API_KEY/)
        assert.match(gemini.auth.hint, /gemini login/)
      } finally {
        restoreKeys()
      }
    })

    it('gemini env var still wins over OAuth file (source=env) (#4301)', () => {
      try {
        clearKeys()
        process.env.GEMINI_API_KEY = 'gem-from-env'
        writeFileSync(join(_tmpGeminiHome, 'oauth_creds.json'), '{}')
        const list = listProviders()
        const gemini = list.find(p => p.name === 'gemini')
        if (!gemini) return
        assert.equal(gemini.auth.ready, true)
        assert.equal(gemini.auth.source, 'env')
        assert.equal(gemini.auth.envVar, 'GEMINI_API_KEY')
      } finally {
        restoreKeys()
      }
    })

    // #4656: DeepSeek mirrors the BYOK auth flow — DEEPSEEK_API_KEY env
    // OR a `deepseekApiKey` field in ~/.chroxy/credentials.json (mode 0600).
    // Both must resolve through the dedicated branch in getProviderAuthInfo;
    // without it the file path would silently report ready=false.
    it('deepseek validates and is registered', () => {
      const list = listProviders()
      const ds = list.find(p => p.name === 'deepseek')
      assert.ok(ds, 'deepseek provider should be registered')
      assert.equal(typeof ds.capabilities, 'object')
    })

    it('deepseek reports ready=true source=env when DEEPSEEK_API_KEY is set (#4656)', () => {
      try {
        clearKeys()
        process.env.DEEPSEEK_API_KEY = 'sk-deepseek-test'
        const list = listProviders()
        const ds = list.find(p => p.name === 'deepseek')
        assert.ok(ds?.auth)
        assert.equal(ds.auth.ready, true)
        assert.equal(ds.auth.source, 'env')
        assert.equal(ds.auth.envVar, 'DEEPSEEK_API_KEY')
        assert.match(ds.auth.detail, /DeepSeek API/)
        assert.match(ds.auth.detail, /DEEPSEEK_API_KEY set/)
      } finally {
        restoreKeys()
      }
    })

    it('deepseek reports ready=false source=none when no credentials are present (#4656)', () => {
      try {
        clearKeys()
        const list = listProviders()
        const ds = list.find(p => p.name === 'deepseek')
        assert.ok(ds?.auth)
        assert.equal(ds.auth.ready, false)
        assert.equal(ds.auth.source, 'none')
        assert.match(ds.auth.detail, /DeepSeek API/)
        // Hint must mention the env var so the user knows the fix.
        assert.match(ds.auth.hint, /DEEPSEEK_API_KEY/)
      } finally {
        restoreKeys()
      }
    })

    it('deepseek reports ready=true source=env when key is in credentials.json (#4656)', () => {
      // Mirrors the claude-byok file-path test. Without the dedicated
      // DeepSeek branch in getProviderAuthInfo, this would silently
      // report ready=false because the generic env-var match only
      // looks at process.env, not the credentials.json file.
      const tmpFsHome = mkdtempSync(join(tmpdir(), 'chroxy-deepseek-auth-test-'))
      const savedHome = process.env.HOME
      try {
        clearKeys()
        process.env.HOME = tmpFsHome
        mkdirSync(join(tmpFsHome, '.chroxy'), { recursive: true })
        const credPath = join(tmpFsHome, '.chroxy', 'credentials.json')
        writeFileSync(credPath, JSON.stringify({ deepseekApiKey: 'sk-from-file' }))
        // Set mode after write because some tmp setups don't honour the
        // mode arg on writeFileSync. chmod is the authoritative source.
        chmodSync(credPath, 0o600)
        const list = listProviders()
        const ds = list.find(p => p.name === 'deepseek')
        assert.ok(ds?.auth)
        assert.equal(ds.auth.ready, true)
        assert.equal(ds.auth.source, 'env',
          'file path must surface as source=env so SettingsPanel renders the right tone')
        assert.equal(ds.auth.envVar, null, 'file source has no env var')
        assert.match(ds.auth.detail, /credentials\.json/)
      } finally {
        if (savedHome) process.env.HOME = savedHome
        else delete process.env.HOME
        rmSync(tmpFsHome, { recursive: true, force: true })
        restoreKeys()
      }
    })

    it('providers without a preflight credentials block are reported ready (opt-out)', () => {
      class NoPreflightProvider {
        static get capabilities() { return {} }
        // Intentionally no static get preflight() — opts out of credential checks
        sendMessage() {}
        interrupt() {}
        setModel() {}
        setPermissionMode() {}
        start() {}
        destroy() {}
      }
      registerProvider('test-no-preflight', NoPreflightProvider)
      try {
        const list = listProviders()
        const entry = list.find(p => p.name === 'test-no-preflight')
        assert.ok(entry?.auth, 'no-preflight provider should still expose auth')
        assert.equal(entry.auth.ready, true, 'opt-out provider must not be marked unready')
        assert.equal(entry.auth.source, 'none')
        assert.deepEqual(entry.auth.envVars, [])
      } finally {
        // Cleanup: registerProvider mutates the module-level PROVIDERS map.
        // No public unregister, but subsequent tests don't depend on absence.
      }
    })

    // Caught by agent review of #3673: docker-cli/docker-sdk forward
    // ANTHROPIC_API_KEY to the container at `docker run` time, but the
    // container has no ~/.claude OAuth state so they can't fall back when
    // the env var is missing. Earlier code lumped docker-cli into the
    // "always subscription" branch which was the exact misreport F1 was
    // chartered to fix.
    it('docker-cli reports ready=true source=env when ANTHROPIC_API_KEY is set', async () => {
      const { DockerSession } = await import('../src/docker-session.js')
      registerProvider('docker-cli', DockerSession)
      try {
        clearKeys()
        process.env.ANTHROPIC_API_KEY = 'sk-test'
        const list = listProviders()
        const dcli = list.find(p => p.name === 'docker-cli')
        assert.ok(dcli?.auth)
        assert.equal(dcli.auth.ready, true)
        assert.equal(dcli.auth.source, 'env')
        assert.equal(dcli.auth.envVar, 'ANTHROPIC_API_KEY')
        assert.match(dcli.auth.detail, /Anthropic API.*forwarded to container/)
      } finally {
        restoreKeys()
      }
    })

    it('docker-cli reports ready=false source=none when ANTHROPIC_API_KEY is missing', async () => {
      const { DockerSession } = await import('../src/docker-session.js')
      registerProvider('docker-cli', DockerSession)
      try {
        clearKeys()
        const list = listProviders()
        const dcli = list.find(p => p.name === 'docker-cli')
        assert.ok(dcli?.auth)
        assert.equal(dcli.auth.ready, false)
        assert.equal(dcli.auth.source, 'none')
        // Detail must NOT claim subscription billing — that was the bug.
        assert.doesNotMatch(dcli.auth.detail, /subscription/i)
        assert.match(dcli.auth.detail, /no OAuth fallback inside the container/i)
      } finally {
        restoreKeys()
      }
    })

    it('docker-sdk reports ready=true source=env when ANTHROPIC_API_KEY is set', async () => {
      const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
      registerProvider('docker-sdk', DockerSdkSession)
      try {
        clearKeys()
        process.env.ANTHROPIC_API_KEY = 'sk-test'
        const list = listProviders()
        const dsdk = list.find(p => p.name === 'docker-sdk')
        assert.ok(dsdk?.auth)
        assert.equal(dsdk.auth.ready, true)
        assert.equal(dsdk.auth.source, 'env')
        assert.match(dsdk.auth.detail, /Anthropic API/)
      } finally {
        restoreKeys()
      }
    })

    it('docker-sdk reports ready=false when ANTHROPIC_API_KEY is missing (no OAuth fallback in container)', async () => {
      const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
      registerProvider('docker-sdk', DockerSdkSession)
      try {
        clearKeys()
        const list = listProviders()
        const dsdk = list.find(p => p.name === 'docker-sdk')
        assert.ok(dsdk?.auth)
        assert.equal(dsdk.auth.ready, false)
        assert.equal(dsdk.auth.source, 'none')
      } finally {
        restoreKeys()
      }
    })
  })
})

// #3953 — claude-channel provider scaffold. Registered in providers.js so
// the dashboard can list it + `chroxy doctor` runs its preflight; the
// session itself is a no-op until the bridge lands in #3954.
describe('claude-channel provider scaffold (#3953)', () => {
  it('is registered and resolvable via getProvider', async () => {
    const { ClaudeChannelSession } = await import('../src/claude-channel-session.js')
    assert.equal(getProvider('claude-channel'), ClaudeChannelSession)
  })

  it('appears in listProviders() with the expected capability matrix', () => {
    const list = listProviders()
    const entry = list.find(p => p.name === 'claude-channel')
    assert.ok(entry, 'claude-channel must appear in listProviders()')
    assert.equal(entry.capabilities.permissions, true)
    assert.equal(entry.capabilities.inProcessPermissions, false)
    assert.equal(entry.capabilities.modelSwitch, false)
    assert.equal(entry.capabilities.permissionModeSwitch, false)
    assert.equal(entry.capabilities.planMode, false)
    assert.equal(entry.capabilities.resume, false)
    assert.equal(entry.capabilities.terminal, false)
    assert.equal(entry.capabilities.thinkingLevel, false)
    assert.equal(entry.capabilities.streaming, true)
    assert.equal(entry.capabilities.tools, true)
    // Derived: scaffold does not implement setPermissionRules.
    assert.equal(entry.capabilities.sessionRules, false)
  })

  it('exposes auth detail mentioning subscription + research preview', () => {
    const list = listProviders()
    const entry = list.find(p => p.name === 'claude-channel')
    assert.ok(entry?.auth)
    assert.equal(entry.auth.ready, true)
    assert.equal(entry.auth.source, 'oauth')
    assert.match(entry.auth.detail, /research preview/i)
    assert.match(entry.auth.detail, /channel/i)
  })

  it('passes validateProviderClass (no inProcessPermissions methods required)', async () => {
    const { validateProviderClass } = await import('../src/providers.js')
    const { ClaudeChannelSession } = await import('../src/claude-channel-session.js')
    // Should not throw — start/destroy/sendMessage/interrupt/setModel/
    // setPermissionMode all inherited from BaseSession.
    validateProviderClass(ClaudeChannelSession, 'claude-channel')
  })

  it('exposes a non-empty displayLabel via resolveProviderLabel', async () => {
    const { resolveProviderLabel } = await import('../src/providers.js')
    const label = resolveProviderLabel('claude-channel')
    assert.match(label, /channel/i)
  })

  it('shares the ~/.claude dataDir without duplicating it in getProviderDataDirs', async () => {
    const { getProviderDataDirs } = await import('../src/providers.js')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const dirs = getProviderDataDirs()
    const claudeDir = join(homedir(), '.claude')
    assert.equal(dirs.filter(d => d === claudeDir).length, 1,
      '~/.claude must appear exactly once even with claude-channel registered')
  })
})

describe('Docker Provider Naming (#2475)', () => {
  it('registerDockerProvider skips when environments not enabled', async () => {
    const before = listProviders().length
    await registerDockerProvider({})
    await registerDockerProvider({ environments: { enabled: false } })
    assert.equal(listProviders().length, before)
  })

  it('docker alias maps to docker-cli (DockerSession)', async () => {
    // Register docker providers manually since Docker may not be available in CI
    const { DockerSession } = await import('../src/docker-session.js')
    registerProvider('docker-cli', DockerSession)
    registerProvider('docker', DockerSession, { alias: true })

    const dockerCli = getProvider('docker-cli')
    const docker = getProvider('docker')
    assert.equal(dockerCli, DockerSession)
    assert.equal(docker, DockerSession, '"docker" should resolve to same class as "docker-cli"')
  })

  it('docker alias is excluded from listProviders()', async () => {
    const list = listProviders()
    const dockerCli = list.find(p => p.name === 'docker-cli')
    const dockerAlias = list.find(p => p.name === 'docker')
    assert.ok(dockerCli, 'docker-cli should appear in listProviders')
    assert.equal(dockerAlias, undefined, 'docker alias should NOT appear in listProviders')
  })

  it('docker-sdk is registered separately', async () => {
    const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
    registerProvider('docker-sdk', DockerSdkSession)

    const dockerSdk = getProvider('docker-sdk')
    assert.equal(dockerSdk, DockerSdkSession)
  })

  it('docker-cli has containerized capability', async () => {
    const { DockerSession } = await import('../src/docker-session.js')
    assert.equal(DockerSession.capabilities.containerized, true)
  })

  it('docker-sdk has containerized capability', async () => {
    const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
    assert.equal(DockerSdkSession.capabilities.containerized, true)
  })

  // #4780: the docker providers used to inherit the host-CLI preflight
  // credentials block from their parent, which suggested the user "run
  // `claude login`". Inside a container that command cannot work — the
  // container has no ~/.claude state and the host Keychain is invisible.
  // The only path is forwarding `ANTHROPIC_API_KEY` from the host.
  describe('container auth hints (#4780)', () => {
    const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
    const saved = {}
    function clearKeys() {
      for (const k of ENV_KEYS) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
    }
    function restoreKeys() {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }

    it('docker-cli preflight hint does NOT mention `claude login`', async () => {
      const { DockerSession } = await import('../src/docker-session.js')
      const credSpec = DockerSession.preflight.credentials
      assert.ok(credSpec, 'docker-cli must declare a preflight credentials block')
      assert.doesNotMatch(credSpec.hint, /claude login/i,
        `claude login is futile inside a container — hint was: ${credSpec.hint}`)
      assert.match(credSpec.hint, /ANTHROPIC_API_KEY/,
        'hint must point the user at the env var path')
    })

    it('docker-sdk preflight hint does NOT mention `claude login`', async () => {
      const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
      const credSpec = DockerSdkSession.preflight.credentials
      assert.ok(credSpec, 'docker-sdk must declare a preflight credentials block')
      assert.doesNotMatch(credSpec.hint, /claude login/i,
        `claude login is futile inside a container — hint was: ${credSpec.hint}`)
      assert.match(credSpec.hint, /ANTHROPIC_API_KEY/,
        'hint must point the user at the env var path')
    })

    it('docker-cli resolveAuth(no env) returns hint without `claude login`', async () => {
      try {
        clearKeys()
        const { DockerSession } = await import('../src/docker-session.js')
        const auth = DockerSession.resolveAuth(process.env)
        assert.equal(auth.ready, false)
        assert.doesNotMatch(auth.hint, /claude login/i,
          `docker-cli hint must not tell users to claude login — got: ${auth.hint}`)
        assert.doesNotMatch(auth.detail, /claude login/i,
          `docker-cli detail must not tell users to claude login — got: ${auth.detail}`)
      } finally {
        restoreKeys()
      }
    })

    it('docker-sdk resolveAuth(no env) returns hint without `claude login`', async () => {
      try {
        clearKeys()
        const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
        const auth = DockerSdkSession.resolveAuth(process.env, {})
        assert.equal(auth.ready, false)
        assert.doesNotMatch(auth.hint, /claude login/i,
          `docker-sdk hint must not tell users to claude login — got: ${auth.hint}`)
        assert.doesNotMatch(auth.detail, /claude login/i,
          `docker-sdk detail must not tell users to claude login — got: ${auth.detail}`)
      } finally {
        restoreKeys()
      }
    })

    it('docker-cli envVars match what _startContainer actually forwards (only ANTHROPIC_API_KEY)', async () => {
      const { DockerSession } = await import('../src/docker-session.js')
      // _startContainer only pushes --env ANTHROPIC_API_KEY=... — declaring
      // CLAUDE_CODE_OAUTH_TOKEN here would lie: a user who set only the OAuth
      // token would see ready=true but the container would still be unauthed.
      assert.deepEqual(DockerSession.preflight.credentials.envVars, ['ANTHROPIC_API_KEY'])
    })

    it('docker-sdk envVars match what _startContainer actually forwards (only ANTHROPIC_API_KEY)', async () => {
      const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
      assert.deepEqual(DockerSdkSession.preflight.credentials.envVars, ['ANTHROPIC_API_KEY'])
    })

    it('docker-cli resolveAuth ignores CLAUDE_CODE_OAUTH_TOKEN (not forwarded into container)', async () => {
      try {
        clearKeys()
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-fake-oauth'
        const { DockerSession } = await import('../src/docker-session.js')
        const auth = DockerSession.resolveAuth(process.env)
        assert.equal(auth.ready, false,
          'OAuth token alone must not satisfy docker-cli — _startContainer only forwards ANTHROPIC_API_KEY')
      } finally {
        restoreKeys()
      }
    })

    it('docker-sdk resolveAuth ignores CLAUDE_CODE_OAUTH_TOKEN (not forwarded into container)', async () => {
      try {
        clearKeys()
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-fake-oauth'
        const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
        const auth = DockerSdkSession.resolveAuth(process.env, {})
        assert.equal(auth.ready, false,
          'OAuth token alone must not satisfy docker-sdk — _startContainer only forwards ANTHROPIC_API_KEY')
      } finally {
        restoreKeys()
      }
    })

    it('docker-cli resolveAuth is ready when ANTHROPIC_API_KEY is set on the host', async () => {
      try {
        clearKeys()
        process.env.ANTHROPIC_API_KEY = 'sk-test'
        const { DockerSession } = await import('../src/docker-session.js')
        const auth = DockerSession.resolveAuth(process.env)
        assert.equal(auth.ready, true)
        assert.equal(auth.source, 'env')
        assert.equal(auth.envVar, 'ANTHROPIC_API_KEY')
      } finally {
        restoreKeys()
      }
    })

    it('host CliSession still uses the original `claude login` hint (regression guard)', () => {
      // The fix is scoped to docker providers — the host CLI provider must
      // keep mentioning `claude login` because on the host that IS the path.
      const credSpec = CliSession.preflight.credentials
      assert.match(credSpec.hint, /claude login/,
        'host CLI provider must still mention claude login — it works on the host')
    })

    it('host SdkSession still uses the original `claude login` hint (regression guard)', () => {
      const credSpec = SdkSession.preflight.credentials
      assert.match(credSpec.hint, /claude login/,
        'host SDK provider must still mention claude login — it works on the host')
    })
  })
})

describe('Provider Capabilities', () => {
  it('CliSession has static capabilities', () => {
    const caps = CliSession.capabilities
    assert.equal(caps.permissions, true)
    assert.equal(caps.inProcessPermissions, false)
    assert.equal(caps.modelSwitch, true)
    assert.equal(caps.permissionModeSwitch, true)
    assert.equal(caps.planMode, true)
    // #4887 — CliSession wires `_sessionId` into the spawn argv as
    // `--resume <id>` on respawn / restore so the model retains
    // conversation context. Capability flag flipped from false → true.
    assert.equal(caps.resume, true)
    assert.equal(caps.terminal, false)
  })

  it('SdkSession has static capabilities', () => {
    const caps = SdkSession.capabilities
    assert.equal(caps.permissions, true)
    assert.equal(caps.inProcessPermissions, true)
    assert.equal(caps.modelSwitch, true)
    assert.equal(caps.permissionModeSwitch, true)
    assert.equal(caps.planMode, false)
    assert.equal(caps.resume, true)
    assert.equal(caps.terminal, false)
  })
})

describe('Provider displayLabel (#2953)', () => {
  it('CliSession exposes a human-readable displayLabel', () => {
    assert.equal(CliSession.displayLabel, 'Claude Code (CLI)')
  })

  it('SdkSession exposes a human-readable displayLabel', () => {
    assert.equal(SdkSession.displayLabel, 'Claude Code (SDK)')
  })

  it('CodexSession exposes a human-readable displayLabel', () => {
    assert.equal(CodexSession.displayLabel, 'OpenAI Codex')
  })

  it('GeminiSession exposes a human-readable displayLabel', () => {
    assert.equal(GeminiSession.displayLabel, 'Google Gemini')
  })

  it('Docker session variants inherit a displayLabel from their base', async () => {
    const { DockerSession } = await import('../src/docker-session.js')
    const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
    // Docker variants derive their label from the underlying provider so the
    // banner stays meaningful without requiring a bespoke override.
    assert.equal(typeof DockerSession.displayLabel, 'string')
    assert.ok(DockerSession.displayLabel.length > 0)
    assert.equal(typeof DockerSdkSession.displayLabel, 'string')
    assert.ok(DockerSdkSession.displayLabel.length > 0)
  })

  it('every built-in provider exposes a non-empty displayLabel', () => {
    // Only assert on the providers shipped with the server — tests earlier in
    // this file register ad-hoc providers that don't need displayLabel.
    const BUILT_IN = ['claude-cli', 'claude-sdk', 'codex', 'gemini']
    for (const name of BUILT_IN) {
      const ProviderClass = getProvider(name)
      assert.equal(
        typeof ProviderClass.displayLabel,
        'string',
        `Provider "${name}" must expose static get displayLabel()`
      )
      assert.ok(
        ProviderClass.displayLabel.length > 0,
        `Provider "${name}" displayLabel must be non-empty`
      )
    }
  })
})

describe('resolveProviderLabel helper (#2953)', () => {
  it('returns the provider class displayLabel for known providers', async () => {
    const { resolveProviderLabel } = await import('../src/providers.js')
    assert.equal(resolveProviderLabel('claude-cli'), 'Claude Code (CLI)')
    assert.equal(resolveProviderLabel('claude-sdk'), 'Claude Code (SDK)')
    assert.equal(resolveProviderLabel('codex'), 'OpenAI Codex')
    assert.equal(resolveProviderLabel('gemini'), 'Google Gemini')
  })

  it('falls back to the raw provider name for unknown providers', async () => {
    const { resolveProviderLabel } = await import('../src/providers.js')
    // Unknown providers should not throw — server-cli should still boot.
    assert.equal(resolveProviderLabel('not-registered-xyz'), 'not-registered-xyz')
  })

  it('handles empty/undefined input without throwing', async () => {
    const { resolveProviderLabel } = await import('../src/providers.js')
    assert.equal(resolveProviderLabel(undefined), 'unknown')
    assert.equal(resolveProviderLabel(null), 'unknown')
    assert.equal(resolveProviderLabel(''), 'unknown')
  })
})

// #4658: BYOK + DeepSeek credential file reads in listProviders() previously
// re-hit the filesystem (statSync + readFileSync + JSON.parse) on every call.
// The dashboard polls list_providers per session open, so this was hot. The
// fix caches the resolver result keyed on mtime+size of credentials.json (and
// on the env-var value when env wins). The tests below verify:
//   (a) cache hit on repeated reads with unchanged file (same reference)
//   (b) cache miss + refresh when the file's mtime changes
//   (c) cache invalidation when the file is deleted
// Plus the same three behaviours for DeepSeek.
describe('listProviders credential-file caching (#4658)', () => {
  // Env vars the cache key is sensitive to. Saved/restored per test so a
  // stray ANTHROPIC_API_KEY in the developer env doesn't suppress the file
  // path under test.
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'DEEPSEEK_API_KEY', 'HOME', 'CHROXY_CLAUDE_HOME', 'CHROXY_CLAUDE_CONFIG', 'CHROXY_CODEX_HOME', 'CHROXY_GEMINI_HOME']
  let saved
  let tmpHome
  let _tmpClaudeHome
  let _tmpCodexHome
  let _tmpGeminiHome

  function setup() {
    saved = {}
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-cache-test-'))
    process.env.HOME = tmpHome
    mkdirSync(join(tmpHome, '.chroxy'), { recursive: true, mode: 0o700 })

    // #3674-style isolation for the OAuth probes so they don't accidentally
    // satisfy a different code path while we're exercising the BYOK/DeepSeek
    // branches. listProviders() iterates every registered provider, so the
    // claude-sdk OAuth path runs alongside the BYOK path on each call.
    _tmpClaudeHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-cache-claude-'))
    process.env.CHROXY_CLAUDE_HOME = _tmpClaudeHome
    process.env.CHROXY_CLAUDE_CONFIG = join(_tmpClaudeHome, '.claude.json')
    _tmpCodexHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-cache-codex-'))
    process.env.CHROXY_CODEX_HOME = _tmpCodexHome
    _tmpGeminiHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-cache-gemini-'))
    process.env.CHROXY_GEMINI_HOME = _tmpGeminiHome

    _resetCredsCacheForTest()
  }

  function teardown() {
    // Guard each step so a partial setup() (e.g. mkdtempSync threw before
    // tmpHome was assigned) doesn't make teardown throw and mask the
    // original failure. Each cleanup is independent and best-effort.
    if (saved) {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
    if (_tmpClaudeHome) rmSync(_tmpClaudeHome, { recursive: true, force: true })
    if (_tmpCodexHome) rmSync(_tmpCodexHome, { recursive: true, force: true })
    if (_tmpGeminiHome) rmSync(_tmpGeminiHome, { recursive: true, force: true })
    _resetCredsCacheForTest()
  }

  function writeCredFile(content) {
    const path = join(tmpHome, '.chroxy', 'credentials.json')
    writeFileSync(path, content, { mode: 0o600 })
    chmodSync(path, 0o600)
    return path
  }

  describe('claude-byok', () => {
    // Smoking-gun cache hit: mutate the file content to a state that would
    // FLIP the ready bit (valid key → empty/blank field), but preserve mtime
    // and size so the cache key stays identical. A working cache returns the
    // stale ready=true result; a non-cached call would read the new content
    // and report ready=false. The byte-length parity assertion below is what
    // makes this test deterministic — if the two payloads don't match, the
    // size half of the key changes and the test devolves into something the
    // existing "refreshes on mtime" case already covers.
    it('returns the cached resolver result when mtime+size are unchanged', () => {
      try {
        setup()
        // Two same-length JSON payloads so a content-only mutation preserves
        // the (mtime,size) cache key. Renaming the field name keeps total
        // bytes constant while making the resolver reject the file on a
        // fresh re-read; if the cache is in effect, the stale ready=true
        // result is returned instead.
        const original = JSON.stringify({ anthropicApiKey: 'sk-ant-cached' })
        const renamed = JSON.stringify({ anthroXicApiKey: 'sk-ant-cached' })
        assert.equal(original.length, renamed.length,
          'rename fixture must be byte-equal to original for the cache key to hit')

        const path = writeCredFile(original)
        // Pin mtime to a round value so utimesSync's lower precision doesn't
        // drift when we restore it below. statSync on macOS reports
        // nanosecond-precision mtimeMs but utimesSync only accepts second-
        // granularity Dates, so reading then writing the same mtime can
        // diverge by sub-millisecond. Pinning to an integer-second Date
        // sidesteps that.
        const pinned = new Date(Math.floor(Date.now() / 1000) * 1000)
        utimesSync(path, pinned, pinned)
        const first = listProviders().find(p => p.name === 'claude-byok').auth
        assert.equal(first.ready, true, 'baseline: file with valid key must report ready=true')

        // Mutate in place, then restore mtime+size so the cache key is
        // byte-identical. With caching, the cached ready=true result is
        // reused; without caching, the next call would re-read the file,
        // see the missing field, and report ready=false.
        const beforeStat = statSync(path)
        writeFileSync(path, renamed, { mode: 0o600 })
        chmodSync(path, 0o600)
        utimesSync(path, pinned, pinned)
        const afterStat = statSync(path)
        assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs,
          'mtime restore must succeed for this test to actually exercise the cache')
        assert.equal(afterStat.size, beforeStat.size,
          'size must match for the cache key to hit')

        const second = listProviders().find(p => p.name === 'claude-byok').auth
        assert.equal(second.ready, true,
          'cache hit: stale-but-cached ready=true returned because (mtime,size) unchanged')
      } finally {
        teardown()
      }
    })

    it('refreshes the cache when credentials.json mtime changes', () => {
      try {
        setup()
        const path = writeCredFile(JSON.stringify({ anthropicApiKey: 'sk-ant-original' }))
        const firstDetail = listProviders().find(p => p.name === 'claude-byok').auth.detail
        assert.match(firstDetail, /credentials\.json/)

        // Bump mtime forward so the (mtime,size) key differs. Same file size
        // would also work — just touch the mtime. We rewrite the contents to
        // a key the resolver will read on the refresh.
        writeFileSync(path, JSON.stringify({ anthropicApiKey: 'sk-ant-rotated' }), { mode: 0o600 })
        chmodSync(path, 0o600)
        // Defensive: bump mtime explicitly in case the rewrite happened
        // inside the same sub-millisecond tick as the original write.
        const future = new Date(Date.now() + 2000)
        utimesSync(path, future, future)

        const afterRefresh = listProviders().find(p => p.name === 'claude-byok').auth
        // Still reports ready (file is still valid). The cache refresh is
        // observable via the underlying resolver re-running — we verify
        // refresh happened by mutating to a state that produces a different
        // detail (clearing the field → "missing" reason).
        assert.equal(afterRefresh.ready, true)

        // Now blank the field to force the resolver into the "missing field"
        // branch. If the cache had stuck, this would still report ready=true.
        writeFileSync(path, JSON.stringify({}), { mode: 0o600 })
        chmodSync(path, 0o600)
        const future2 = new Date(Date.now() + 5000)
        utimesSync(path, future2, future2)

        const afterBlank = listProviders().find(p => p.name === 'claude-byok').auth
        assert.equal(afterBlank.ready, false,
          'cache must refresh on mtime change — otherwise we would still report ready=true after blanking')
        // #5867: reason wording updated when the BYOK read moved to the
        // canonical store ("no Anthropic credential is stored").
        assert.match(afterBlank.detail, /no Anthropic credential is stored/)
      } finally {
        teardown()
      }
    })

    it('invalidates the cache when credentials.json is deleted', () => {
      try {
        setup()
        const path = writeCredFile(JSON.stringify({ anthropicApiKey: 'sk-ant-temporary' }))
        const before = listProviders().find(p => p.name === 'claude-byok').auth
        assert.equal(before.ready, true)

        unlinkSync(path)

        const after = listProviders().find(p => p.name === 'claude-byok').auth
        assert.equal(after.ready, false,
          'cache must drop the cached ready=true result when the file disappears')
        assert.match(after.detail, /does not exist|ENOENT/)
      } finally {
        teardown()
      }
    })

    it('does not return a stale file result after the env var is set (env precedence)', () => {
      try {
        setup()
        writeCredFile(JSON.stringify({ anthropicApiKey: 'sk-ant-from-file' }))
        const fileResult = listProviders().find(p => p.name === 'claude-byok').auth
        assert.match(fileResult.detail, /credentials\.json/)

        process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env'
        const envResult = listProviders().find(p => p.name === 'claude-byok').auth
        assert.equal(envResult.ready, true)
        assert.equal(envResult.envVar, 'ANTHROPIC_API_KEY')
        assert.match(envResult.detail, /ANTHROPIC_API_KEY set/)
      } finally {
        teardown()
      }
    })

    // #4728 review: mtime+size+envValue is not sufficient — the resolver also
    // refuses any file with mode more permissive than 0o600 as a security
    // boundary. `chmod 0644` does NOT bump mtime or change size, so without
    // mode in the cache key the dashboard would keep reporting ready=true
    // until the next file write. Pinning the chmod path here.
    it('refreshes when the file mode is loosened (chmod does not touch mtime/size)', () => {
      try {
        setup()
        const path = writeCredFile(JSON.stringify({ anthropicApiKey: 'sk-ant-mode-test' }))
        const before = listProviders().find(p => p.name === 'claude-byok').auth
        assert.equal(before.ready, true, 'baseline: 0o600 file must be readable')

        // Loosen the mode without rewriting contents. mtime and size are
        // unchanged; only `stat.mode & 0o777` flips. The resolver should
        // refuse on the next call and the cache must reflect that.
        chmodSync(path, 0o644)

        const after = listProviders().find(p => p.name === 'claude-byok').auth
        assert.equal(after.ready, false,
          'cache must refresh on mode change — otherwise dashboard lags resolver after chmod')
        assert.match(after.detail, /mode 644|refusing to read|must be 0600/)
      } finally {
        teardown()
      }
    })
  })

  describe('deepseek', () => {
    it('returns the cached auth object on repeated reads with unchanged file', () => {
      try {
        setup()
        writeCredFile(JSON.stringify({ deepseekApiKey: 'sk-ds-cached' }))

        const first = listProviders().find(p => p.name === 'deepseek').auth
        const second = listProviders().find(p => p.name === 'deepseek').auth

        assert.equal(first.ready, true)
        assert.equal(second.ready, true)
        assert.match(first.detail, /credentials\.json/)
        assert.equal(first.detail, second.detail)
      } finally {
        teardown()
      }
    })

    it('refreshes the cache when credentials.json mtime changes', () => {
      try {
        setup()
        const path = writeCredFile(JSON.stringify({ deepseekApiKey: 'sk-ds-original' }))
        const firstResult = listProviders().find(p => p.name === 'deepseek').auth
        assert.equal(firstResult.ready, true)

        // Blank the field so a successful refresh produces an observable
        // change in ready state.
        writeFileSync(path, JSON.stringify({}), { mode: 0o600 })
        chmodSync(path, 0o600)
        const future = new Date(Date.now() + 5000)
        utimesSync(path, future, future)

        const afterBlank = listProviders().find(p => p.name === 'deepseek').auth
        assert.equal(afterBlank.ready, false,
          'cache must refresh on mtime change — otherwise we would still report ready=true after blanking')
        assert.match(afterBlank.detail, /missing or empty "deepseekApiKey" field/)
      } finally {
        teardown()
      }
    })

    it('invalidates the cache when credentials.json is deleted', () => {
      try {
        setup()
        const path = writeCredFile(JSON.stringify({ deepseekApiKey: 'sk-ds-temporary' }))
        const before = listProviders().find(p => p.name === 'deepseek').auth
        assert.equal(before.ready, true)

        unlinkSync(path)

        const after = listProviders().find(p => p.name === 'deepseek').auth
        assert.equal(after.ready, false,
          'cache must drop the cached ready=true result when the file disappears')
        assert.match(after.detail, /does not exist|ENOENT/)
      } finally {
        teardown()
      }
    })

    it('does not return a stale file result after the env var is set (env precedence)', () => {
      try {
        setup()
        writeCredFile(JSON.stringify({ deepseekApiKey: 'sk-ds-from-file' }))
        const fileResult = listProviders().find(p => p.name === 'deepseek').auth
        assert.match(fileResult.detail, /credentials\.json/)

        process.env.DEEPSEEK_API_KEY = 'sk-ds-from-env'
        const envResult = listProviders().find(p => p.name === 'deepseek').auth
        assert.equal(envResult.ready, true)
        assert.equal(envResult.envVar, 'DEEPSEEK_API_KEY')
        assert.match(envResult.detail, /DEEPSEEK_API_KEY set/)
      } finally {
        teardown()
      }
    })
  })

  // BYOK and DeepSeek share `~/.chroxy/credentials.json`. Make sure their
  // cache slots don't trample each other — a mutation that only changes one
  // field must still refresh the other slot too (because mtime moves).
  it('byok and deepseek slots both refresh when credentials.json changes', () => {
    try {
      setup()
      const path = writeCredFile(JSON.stringify({
        anthropicApiKey: 'sk-ant-a',
        deepseekApiKey: 'sk-ds-a',
      }))
      const byok1 = listProviders().find(p => p.name === 'claude-byok').auth
      const ds1 = listProviders().find(p => p.name === 'deepseek').auth
      assert.equal(byok1.ready, true)
      assert.equal(ds1.ready, true)

      // Mutate the file — drop both keys.
      writeFileSync(path, JSON.stringify({}), { mode: 0o600 })
      chmodSync(path, 0o600)
      const future = new Date(Date.now() + 5000)
      utimesSync(path, future, future)

      const byok2 = listProviders().find(p => p.name === 'claude-byok').auth
      const ds2 = listProviders().find(p => p.name === 'deepseek').auth
      assert.equal(byok2.ready, false, 'BYOK cache must refresh on file change')
      assert.equal(ds2.ready, false, 'DeepSeek cache must refresh on file change')
    } finally {
      teardown()
    }
  })

  // The cache is opt-in for the listProviders() poll path. Session-start
  // paths (byok-session.js / deepseek-session.js) still call the resolvers
  // directly. We can't directly observe those here, but we can pin the
  // observable behaviour at the listProviders boundary: a freshly-written
  // credentials.json reports ready=true immediately, not after a cache TTL
  // expiry. This is the "no observable behaviour change" guarantee.
  it('a freshly-written credentials.json reports ready=true on the very next listProviders call', () => {
    try {
      setup()
      // No file yet — both BYOK and DeepSeek must report missing.
      const beforeByok = listProviders().find(p => p.name === 'claude-byok').auth
      const beforeDs = listProviders().find(p => p.name === 'deepseek').auth
      assert.equal(beforeByok.ready, false)
      assert.equal(beforeDs.ready, false)

      writeCredFile(JSON.stringify({
        anthropicApiKey: 'sk-ant-fresh',
        deepseekApiKey: 'sk-ds-fresh',
      }))

      const afterByok = listProviders().find(p => p.name === 'claude-byok').auth
      const afterDs = listProviders().find(p => p.name === 'deepseek').auth
      assert.equal(afterByok.ready, true, 'new credentials.json must be picked up immediately, not after a TTL')
      assert.equal(afterDs.ready, true, 'new credentials.json must be picked up immediately, not after a TTL')
    } finally {
      teardown()
    }
  })
})

// #5379 — validateProviderClass's inProcessPermissions guard (registration-time
// safety gate). The happy paths are covered elsewhere; these lock in the two
// throw branches so a regression that drops the guard fails CI.
describe('validateProviderClass — inProcessPermissions guard (#5379)', () => {
  // Minimal class exposing every REQUIRED_METHODS entry on its prototype, so a
  // test isolates the inProcessPermissions check from the base-method check.
  function makeProviderClass({ inProcessPermissions, respondToPermission, respondToQuestion }) {
    class Stub {
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
      start() {}
      destroy() {}
    }
    if (respondToPermission) Stub.prototype.respondToPermission = function () {}
    if (respondToQuestion) Stub.prototype.respondToQuestion = function () {}
    Object.defineProperty(Stub, 'capabilities', { get: () => ({ inProcessPermissions }) })
    return Stub
  }

  it('passes when inProcessPermissions=true and both methods are present', async () => {
    const { validateProviderClass } = await import('../src/providers.js')
    const Stub = makeProviderClass({ inProcessPermissions: true, respondToPermission: true, respondToQuestion: true })
    assert.doesNotThrow(() => validateProviderClass(Stub, 'stub-ok'))
  })

  it('throws when inProcessPermissions=true but respondToPermission is missing', async () => {
    const { validateProviderClass } = await import('../src/providers.js')
    const Stub = makeProviderClass({ inProcessPermissions: true, respondToPermission: false, respondToQuestion: true })
    // Order-independent: assert each key fragment is present without coupling
    // to the message's word order (#5384 review).
    assert.throws(
      () => validateProviderClass(Stub, 'stub-no-perm'),
      /(?=[\s\S]*stub-no-perm)(?=[\s\S]*inProcessPermissions=true)(?=[\s\S]*respondToPermission)/,
    )
  })

  it('throws when inProcessPermissions=true but respondToQuestion is missing', async () => {
    const { validateProviderClass } = await import('../src/providers.js')
    const Stub = makeProviderClass({ inProcessPermissions: true, respondToPermission: true, respondToQuestion: false })
    assert.throws(
      () => validateProviderClass(Stub, 'stub-no-question'),
      /(?=[\s\S]*stub-no-question)(?=[\s\S]*inProcessPermissions=true)(?=[\s\S]*respondToQuestion)/,
    )
  })

  it('does NOT require the permission methods when inProcessPermissions is false', async () => {
    const { validateProviderClass } = await import('../src/providers.js')
    const Stub = makeProviderClass({ inProcessPermissions: false, respondToPermission: false, respondToQuestion: false })
    assert.doesNotThrow(() => validateProviderClass(Stub, 'stub-no-inproc'))
  })

  // #5448: store-core's context-window resolver assumes every docker-* provider
  // is Claude-backed (200k default) via the CLAUDE_BACKED_DOCKER_IDS allowlist.
  // That coupling lives in a different package than this registry, and the server
  // can't import store-core's TS main entry under node --test (only the built
  // /crypto subpath), so the two lists are kept in sync by a literal assertion on
  // EACH side: this pins DOCKER_PROVIDER_IDS, and store-core's context-window.test
  // pins CLAUDE_BACKED_DOCKER_IDS to the same set + asserts the resolver fails
  // closed for an unknown docker-*. Adding a docker provider trips this test,
  // forcing a conscious "is it Claude-backed?" decision in BOTH places.
  describe('docker provider id set is pinned (#5448)', () => {
    it('DOCKER_PROVIDER_IDS matches the known Claude-backed docker wrappers', async () => {
      const { DOCKER_PROVIDER_IDS } = await import('../src/providers.js')
      assert.deepEqual([...DOCKER_PROVIDER_IDS].sort(), ['docker', 'docker-byok', 'docker-cli', 'docker-sdk'],
        'a docker provider changed — keep DOCKER_PROVIDER_IDS in sync with store-core CLAUDE_BACKED_DOCKER_IDS; a NON-Claude docker-* must NOT be added to the store-core allowlist (it would get a fabricated 200k context-window meter)')
    })
  })
})

describe('codex provider default — app-server (#6616)', () => {
  const KEY = 'CHROXY_CODEX_APPSERVER'
  const orig = process.env[KEY]
  // try/finally so a failed assertion can't leave CHROXY_CODEX_APPSERVER mutated
  // and leak into later tests (Copilot #6617 review).
  const withEnv = (val, fn) => {
    if (val === undefined) delete process.env[KEY]; else process.env[KEY] = val
    try { fn() } finally { if (orig === undefined) delete process.env[KEY]; else process.env[KEY] = orig }
  }

  it('defaults to the app-server driver when the env is unset', () => {
    withEnv(undefined, () => assert.equal(getProvider('codex'), CodexAppServerSession))
  })

  it('any non-opt-out value keeps the app-server driver (e.g. "1")', () => {
    withEnv('1', () => assert.equal(getProvider('codex'), CodexAppServerSession))
  })

  it('opts out to the exec CodexSession for 0/false/no/off (case-insensitive)', () => {
    for (const v of ['0', 'false', 'no', 'off', 'OFF', ' false ']) {
      withEnv(v, () => assert.equal(getProvider('codex'), CodexSession, `opt-out value: "${v}"`))
    }
  })

  it('the opt-out never affects non-codex providers', () => {
    withEnv('0', () => assert.equal(getProvider('claude-cli'), CliSession))
  })
})
