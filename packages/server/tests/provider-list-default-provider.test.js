/**
 * #8151 (C3) — two server-side pieces of the dashboard-default-provider fix:
 *
 *  1. `provider_list` (and, by the same derivation, `auth_bootstrap`) carries
 *     the daemon's OWN resolved default provider (`resolveDaemonDefaultProvider`),
 *     so a client can override its baked-in `DEFAULT_PROVIDER` constant
 *     (claude-tui) with what THIS server actually runs by default — e.g. a
 *     Docker image's `ENV CHROXY_PROVIDER=claude-sdk`.
 *
 *  2. `listProviders()` marks `claude-tui` unavailable (`auth.ready: false`,
 *     with an actionable hint) when node-pty cannot load, so a client greys
 *     it out instead of letting a user pick a provider that will fail the
 *     moment a session is created with it.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listProviders } from '../src/providers.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { resetNodePtyProbeForTest, cachedNodePtyAvailable, probeNodePtyAvailable } from '../src/utils/node-pty-probe.js'
import { DEFAULT_PROVIDER } from '@chroxy/protocol'

const __dirname = dirname(fileURLToPath(import.meta.url))
// #8151 round-2 review (Windows fallout) — `--import` goes through Node's
// ESM loader, which rejects a bare Windows absolute path
// ("A:\foo\bar.mjs") with ERR_UNSUPPORTED_ESM_URL_SCHEME. `pathToFileURL`
// gives the portable form (a no-op on POSIX, `file:///A:/...` on Windows).
// The MAIN SCRIPT argument (PROBE_CHILD) must stay a plain path — Node
// resolves it through a different, path-based mechanism than `--import`'s
// ESM loader, and a file:// URL there fails even on POSIX (confirmed:
// resolved relative to cwd instead of being recognised as a URL). See
// node-pty-production-import.test.js for the full writeup.
const SETUP = pathToFileURL(join(__dirname, '_setup.mjs')).href
const REJECT_HOOK = pathToFileURL(join(__dirname, 'fixtures', 'reject-node-pty-import.mjs')).href
const SUCCESS_HOOK = pathToFileURL(join(__dirname, 'fixtures', 'resolve-node-pty-import-success.mjs')).href
const PROBE_CHILD = join(__dirname, 'fixtures', 'node-pty-probe-child.mjs')

describe('listProviders() marks claude-tui unavailable when node-pty cannot load (#8151 C3)', () => {
  it('nodePtyAvailable: false → claude-tui auth.ready is false with an actionable hint', () => {
    const providers = listProviders({ nodePtyAvailable: false })
    const claudeTui = providers.find((p) => p.name === 'claude-tui')
    assert.ok(claudeTui, 'expected claude-tui in the provider list')
    assert.equal(claudeTui.auth.ready, false)
    assert.match(claudeTui.auth.hint, /not supported in this environment/)
    assert.match(claudeTui.auth.hint, /node-pty unavailable/)
    assert.match(claudeTui.auth.hint, /use claude-sdk/)
  })

  it('nodePtyAvailable: true → claude-tui auth is whatever resolveAuth() itself says (unaffected)', () => {
    const withPty = listProviders({ nodePtyAvailable: true })
    const withoutInjection = listProviders({}) // cache is null in this test process → treated as available
    const a = withPty.find((p) => p.name === 'claude-tui').auth
    const b = withoutInjection.find((p) => p.name === 'claude-tui').auth
    assert.deepEqual(a, b, 'an explicit true should match the "no probe yet" default (both = available)')
  })

  it('other providers are never touched by the node-pty override', () => {
    const unavailable = listProviders({ nodePtyAvailable: false })
    const available = listProviders({ nodePtyAvailable: true })
    for (const name of ['claude-sdk', 'claude-cli', 'codex']) {
      const a = unavailable.find((p) => p.name === name)
      const b = available.find((p) => p.name === name)
      assert.ok(a && b, `expected ${name} in both lists`)
      assert.deepEqual(a.auth, b.auth, `${name}'s auth must not change with the claude-tui-only override`)
    }
  })

  it('mutant proof: deleting the name === "claude-tui" guard would also grey out claude-sdk — the guard is provider-specific, not blanket', () => {
    // Not a literal mutant harness (this file has no source copy to mutate) —
    // this assertion IS the thing that goes red if the guard's name check is
    // ever dropped or widened. ENVIRONMENT-INDEPENDENT on purpose (review
    // catch, #8151 round 2): an earlier version asserted `sdk.auth.ready ===
    // true`, which depends on whatever real claude-sdk credentials happen to
    // be on the machine running the suite — true on a dev box with a `claude
    // login` / ANTHROPIC_API_KEY, false on a clean CI runner with neither,
    // which is exactly the false !== true failure CI caught. claude-sdk has
    // no PTY dependency at all, so what this guard must prove is narrower and
    // ambient-credential-free: the override never TOUCHES claude-sdk's auth
    // (deep-equal against the nodePtyAvailable: true baseline — test 2 above
    // proves the same property across all three comparison providers; this
    // one additionally pins the specific, readable signal a reviewer would
    // check first) and its hint never mentions node-pty.
    const unavailable = listProviders({ nodePtyAvailable: false })
    const available = listProviders({ nodePtyAvailable: true })
    const sdkUnavailable = unavailable.find((p) => p.name === 'claude-sdk')
    const sdkAvailable = available.find((p) => p.name === 'claude-sdk')
    assert.deepEqual(sdkUnavailable.auth, sdkAvailable.auth)
    assert.doesNotMatch(sdkUnavailable.auth.hint || '', /node-pty/)
  })
})

describe('node-pty-probe.js — probe once and cache (#8151 C3)', () => {
  beforeEach(() => {
    resetNodePtyProbeForTest()
  })

  it('cachedNodePtyAvailable() is null before the first probe', () => {
    assert.equal(cachedNodePtyAvailable(), null)
  })

  it('probeNodePtyAvailable() resolves to a boolean and caches it', async () => {
    const result = await probeNodePtyAvailable()
    assert.equal(typeof result, 'boolean')
    assert.equal(cachedNodePtyAvailable(), result)
  })

  it('a second call returns the cached value without re-probing (no throw, same value both times)', async () => {
    const first = await probeNodePtyAvailable()
    const second = await probeNodePtyAvailable()
    assert.equal(first, second)
  })

  // #8151 round-2 review (Critical 3a): the tests above never actually
  // exercise a REAL `import('node-pty')` succeeding or failing — in this
  // bare test process, the real import's outcome depends on whatever
  // happens to be installed on the machine running the suite, and nothing
  // here counted resolution attempts. The reviewer proved the gap: with the
  // probe hardcoded to a constant `true` and the boot call removed
  // entirely, all 211 tests in this file's worker stayed green. These two
  // run the REAL probe in a child process under a `node:module` resolve
  // hook (shared with Critical 1's production-import test) that forces a
  // controlled outcome, and count actual resolve() attempts via a file the
  // hook appends to — proving BOTH that the probe's boolean tracks a real
  // import outcome, AND that the cache genuinely avoids a second resolution
  // (not merely that two calls happen to return the same value).
  function runProbeChild(hookPath, countFile) {
    const stdout = execFileSync(
      process.execPath,
      ['--import', SETUP, '--import', hookPath, PROBE_CHILD],
      { encoding: 'utf8', env: { ...process.env, PTY_RESOLVE_COUNT_FILE: countFile } },
    )
    const lines = stdout.trim().split('\n').filter(Boolean)
    return JSON.parse(lines[lines.length - 1])
  }

  it('probeNodePtyAvailable() returns false (and caches false) when the real import(\'node-pty\') rejects, resolving exactly once across two calls', () => {
    const countFile = join(mkdtempSync(join(tmpdir(), 'chroxy-pty-probe-count-')), 'count')
    try {
      const result = runProbeChild(REJECT_HOOK, countFile)
      assert.deepEqual(result, { first: false, second: false, cached: false })
      assert.ok(existsSync(countFile), 'the hook never recorded a resolve() attempt at all')
      assert.equal(readFileSync(countFile, 'utf8'), '.', 'expected exactly ONE resolve() attempt across two probe calls')
    } finally {
      rmSync(dirname(countFile), { recursive: true, force: true })
    }
  })

  it('probeNodePtyAvailable() returns true (and caches true) when the real import(\'node-pty\') resolves, resolving exactly once across two calls', () => {
    const countFile = join(mkdtempSync(join(tmpdir(), 'chroxy-pty-probe-count-')), 'count')
    try {
      const result = runProbeChild(SUCCESS_HOOK, countFile)
      assert.deepEqual(result, { first: true, second: true, cached: true })
      assert.ok(existsSync(countFile), 'the hook never recorded a resolve() attempt at all')
      assert.equal(readFileSync(countFile, 'utf8'), '.', 'expected exactly ONE resolve() attempt across two probe calls')
    } finally {
      rmSync(dirname(countFile), { recursive: true, force: true })
    }
  })

  // #8151 round-2 review (S-b) — the probe's own boolean and
  // `listProviders({ nodePtyAvailable: false })`'s EXPLICIT-injection
  // branch were each tested directly, but nothing proved they're actually
  // WIRED together the way production uses them: a boot-time probe, then
  // `listProviders()` called with NO argument, reading whatever got
  // cached. This closes that gap with a real child process.
  it('listProviders() with NO injection reads the boot-time probe\'s cache: claude-tui auth.ready is false after a real import failure', () => {
    const stdout = execFileSync(
      process.execPath,
      ['--import', SETUP, '--import', REJECT_HOOK, join(__dirname, 'fixtures', 'node-pty-probe-then-listproviders-child.mjs')],
      { encoding: 'utf8' },
    )
    const lines = stdout.trim().split('\n').filter(Boolean)
    const result = JSON.parse(lines[lines.length - 1])
    assert.equal(result.ready, false)
    assert.match(result.hint, /node-pty unavailable/)
  })

  // #8151 round-2 review (S-b) — a cheap, structural pin (matching this
  // file's existing source-level call-site checks, e.g.
  // entry-point-call-sites.test.js) that the boot path actually calls the
  // probe BEFORE the WS server can accept a connection — not merely that
  // the probe/listProviders wiring works in isolation, which the test
  // above already proves.
  it('server-cli.js calls probeNodePtyAvailable() before wsServer.start() (boot-order pin)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server-cli.js'), 'utf8')
    const probeIdx = src.indexOf('await probeNodePtyAvailable()')
    const startIdx = src.indexOf('wsServer.start(')
    assert.ok(probeIdx !== -1, 'server-cli.js no longer calls probeNodePtyAvailable() at all')
    assert.ok(startIdx !== -1, 'server-cli.js no longer calls wsServer.start() — update this pin\'s anchor')
    assert.ok(probeIdx < startIdx,
      'probeNodePtyAvailable() must run BEFORE wsServer.start() — otherwise the very first client connection can race the probe')
  })
})

describe('provider_list carries the daemon\'s resolved default provider (#8151 C3)', () => {
  function makeCtx(config) {
    const sent = []
    return {
      ctx: {
        transport: { send: (ws, msg) => sent.push(msg) },
        services: { config },
      },
      sent,
    }
  }

  it('defaultProvider reflects config.provider when set (the Docker image\'s CHROXY_PROVIDER=claude-sdk case)', () => {
    const { ctx, sent } = makeCtx({ provider: 'claude-sdk' })
    settingsHandlers.list_providers({}, {}, {}, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'provider_list')
    assert.equal(sent[0].defaultProvider, 'claude-sdk')
  })

  it('defaultProvider falls back to the shared DEFAULT_PROVIDER constant when config has no provider set — proves this is a REAL resolution, not a hardcoded echo of one value', () => {
    const { ctx, sent } = makeCtx({})
    settingsHandlers.list_providers({}, {}, {}, ctx)
    assert.equal(sent[0].defaultProvider, DEFAULT_PROVIDER)
  })

  it('a DIFFERENT configured provider (not claude-sdk) round-trips too — not a two-value special case', () => {
    const { ctx, sent } = makeCtx({ provider: 'gemini' })
    settingsHandlers.list_providers({}, {}, {}, ctx)
    assert.equal(sent[0].defaultProvider, 'gemini')
  })
})
