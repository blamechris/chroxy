/**
 * #8066 — `chroxy tunnel setup` no longer execs a bare, unverified
 * `cloudflared` from PATH four times (the `--version` existence probe,
 * `tunnel login`, `tunnel create`, `tunnel route dns`). It now resolves AND
 * verifies the binary through the same `runProviderPreflight(ProviderClass,
 * { provenance })` machinery `chroxy resume` (#8061/#8065,
 * `session-cmd-binary-gate.test.js`) already exercises, built from config
 * rather than a `SessionManager` instance (this CLI path has none either).
 *
 * Same conventions as that suite (`fakeProvenanceLedger`,
 * `SPAWN_GATE_*_HASH`, `makeGateShim`) rather than a hand-rolled stand-in, so
 * a regression in the shared gate machinery itself would also be caught
 * here.
 *
 * Never touches the real `~/.chroxy` / `~/.claude` — every fixture (temp
 * config file, gate shim) lives under `os.tmpdir()`, and the "real ledger"
 * tests below rely on `tests/_setup.mjs` redirecting `CHROXY_CONFIG_DIR` to a
 * per-process tmp dir for every test file, never the developer's real
 * `binary-trust.json`.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  resolveVerifiedCloudflaredBinary,
  runTunnelSetup,
  cloudflaredCreateArgv,
  cloudflaredRouteDnsArgv,
} from '../../src/cli/tunnel-cmd.js'

const __filename = fileURLToPath(import.meta.url)
// tests/cli -> tests -> packages/server -> src
const TUNNEL_CMD_URL = pathToFileURL(resolve(__filename, '..', '..', '..', 'src', 'cli', 'tunnel-cmd.js')).href

// ── shared tmp root ─────────────────────────────────────────────────────────

let _tmpRoot
function tmpDir(prefix) {
  if (!_tmpRoot) _tmpRoot = mkdtempSync(join(tmpdir(), 'tunnel-setup-gate-'))
  return mkdtempSync(join(_tmpRoot, `${prefix}-`))
}
after(() => {
  if (_tmpRoot) rmSync(_tmpRoot, { recursive: true, force: true })
})

// #8065 review nitpick 1's rationale, reapplied here: isolate from an
// ambient CHROXY_BINARY_PROVENANCE / CHROXY_BINARY_SIGNATURE_GATE in the
// shell this suite happens to run under — both outrank the injected
// `readConfig`/file fake inside `resolveVerifiedCloudflaredBinary` (the same
// precedence `chroxy start` / `chroxy resume` use), so a stray value in the
// invoking shell would silently flip a case below to pass (or refuse) for
// the wrong reason.
const _savedProvenanceEnv = {}
before(() => {
  for (const key of ['CHROXY_BINARY_PROVENANCE', 'CHROXY_BINARY_SIGNATURE_GATE']) {
    _savedProvenanceEnv[key] = process.env[key]
    delete process.env[key]
  }
})
after(() => {
  for (const [key, value] of Object.entries(_savedProvenanceEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// The REAL hash of the running Node binary, and a hash that can never match
// it — same convention as web-task-manager.test.js's #8039 suite and
// session-cmd-binary-gate.test.js's #8061 suite.
const SPAWN_GATE_REAL_HASH = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
const SPAWN_GATE_WRONG_HASH = 'f'.repeat(64)

function fakeProvenanceLedger(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    getRecord: (p) => (records.has(p) ? { ...records.get(p) } : null),
    approve: (p, sha256) => { records.set(p, { sha256 }); return true },
    _records: records,
  }
}

/**
 * A ledger whose `getRecord` throws — used to PROVE provenance is never
 * consulted for a binary `verifyBinary` reports unhealthy (missing /
 * quarantined). If a regression ever moved the provenance check ahead of
 * the health check, this test would fail loudly (a thrown "must not be
 * called" error) instead of silently passing for the wrong reason.
 */
function boobyTrappedLedger() {
  return {
    getRecord: () => { throw new Error('getRecord must not be called for an unhealthy binary') },
    approve: () => { throw new Error('approve must not be called for an unhealthy binary') },
  }
}

// A `preflight`-shaped fixture whose "binary" is swappable per test, so
// preflight's existence/quarantine/hash checks run against a REAL file with
// no dependency on a `cloudflared` install being present on the test
// machine — same convention as `FixtureClaudeProvider` in
// session-cmd-binary-gate.test.js.
class FixtureCloudflaredProvider {
  static resolvedOverride = null
  static get resolvedBinary() { return FixtureCloudflaredProvider.resolvedOverride || process.execPath }
  static get preflight() {
    return { label: 'cloudflared', binary: { name: 'cloudflared', candidates: [] } }
  }
}

/**
 * A REAL, tiny executable script that records every invocation (argv +
 * which absolute path it ran as, via `process.argv[1]`) to a marker file and
 * exits 0 — same convention as `makeGateShim()` in
 * session-cmd-binary-gate.test.js / web-task-manager.test.js. Used so "the
 * exec actually ran the VERIFIED path" is proven by a real subprocess side
 * effect, and so `setupCloudflare`'s literal `execFileSync(cloudflaredPath,
 * ...)` call sites — deliberately NOT hidden behind an injectable seam, so
 * `scripts/lint-argv-sinks.mjs` keeps tracing them — are exercised for real.
 */
function makeCloudflaredShim() {
  const dir = tmpDir('shim')
  const shimPath = join(dir, 'cloudflared-shim.mjs')
  const logPath = join(dir, 'invocations.jsonl')
  const body = [
    '#!/usr/bin/env node',
    `import { appendFileSync } from 'node:fs'`,
    // This string is the BODY of a separate, dynamically-written shim script
    // (written to disk and exec'd as its own process below) — `argv[1]`
    // records which absolute path the OS invoked THAT shim as, for this
    // test's own assertions. Not this file determining its own entry point.
    // lint-ignore-entry-point-guard: records the invoked shim's own path, not this file's entry point
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv0: process.argv[1], args: process.argv.slice(2) }) + '\\n')`,
    `process.exit(0)`,
  ].join('\n')
  writeFileSync(shimPath, body)
  chmodSync(shimPath, 0o755)
  return {
    dir,
    shimPath,
    readInvocations: () => existsSync(logPath)
      ? readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [],
  }
}

/**
 * A tiny harness script, run in its OWN child process via `spawnSync`, that
 * calls the real `runTunnelSetup` with an injected `resolveBinary` (fixed to
 * whatever path argv gives it) and a canned prompt-answer queue.
 *
 * `setupCloudflare`'s pre-existing login-failure branch calls `process.exit(1)`
 * directly (unchanged by #8066 — out of scope here) — if a bare, unresolved
 * `'cloudflared'` ever reaches that `execFileSync` call (which is exactly
 * what a "gate call removed" / "one exec site reverted to bare 'cloudflared'"
 * mutant produces, since nothing on this test's PATH is named `cloudflared`),
 * the login exec throws ENOENT and that branch exits the process outright.
 * Running this in-process would kill the whole `node --test` run instead of
 * failing one test red (see docs/false-safety-guards.md's "a guard that
 * HANGS instead of failing" entry) — spawning a real child process means a
 * mutant-triggered `process.exit()` only ends that child; the parent test
 * reads the shim's marker file (or the child's exit code / stderr) as the
 * ground truth regardless of how the child ended.
 */
function makeSetupHarness() {
  const dir = tmpDir('harness')
  const harnessPath = join(dir, 'run-setup.mjs')
  const body = [
    `import { runTunnelSetup } from ${JSON.stringify(TUNNEL_CMD_URL)}`,
    'const [, , cloudflaredPath, answersJson, configPath] = process.argv',
    'const answers = JSON.parse(answersJson)',
    'let i = 0',
    "const promptFn = async () => answers[i++] ?? ''",
    'await runTunnelSetup({ config: configPath }, { resolveBinary: () => cloudflaredPath, promptFn })',
  ].join('\n')
  writeFileSync(harnessPath, body)
  return harnessPath
}

// #8039-review precedent: a `.mjs` shebang shim is not directly executable
// via `execFile`/`execFileSync` on Windows (no shebang interpretation the
// way POSIX execve provides). Every case that instead proves a REFUSAL (a
// block-mode ledger mismatch, no spawn attempted) never reaches
// `execFileSync` at all, so those keep running unmodified on every
// platform, Windows included.
const WINDOWS_SHIM_EXEC_SKIP = process.platform === 'win32'
  ? 'a .mjs shebang shim is not directly executable via execFileSync on Windows; the refusal/no-spawn cases still run there'
  : false

describe('resolveVerifiedCloudflaredBinary (#8066)', () => {
  it('a block-mode ledger hash mismatch throws — refuses, never returns a path', () => {
    FixtureCloudflaredProvider.resolvedOverride = null // process.execPath
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    assert.throws(
      () => resolveVerifiedCloudflaredBinary({
        ProviderClass: FixtureCloudflaredProvider,
        ledger,
        readConfig: () => ({ binaryProvenance: { mode: 'block' } }),
      }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_BINARY_PROVENANCE')
        return true
      },
    )
  })

  it('a matching-hash ledger in block mode resolves the exact verified absolute path, not the bare string "cloudflared"', () => {
    FixtureCloudflaredProvider.resolvedOverride = null // process.execPath
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_REAL_HASH } })
    const resolved = resolveVerifiedCloudflaredBinary({
      ProviderClass: FixtureCloudflaredProvider,
      ledger,
      readConfig: () => ({ binaryProvenance: { mode: 'block' } }),
    })
    assert.equal(resolved, process.execPath)
    assert.notEqual(resolved, 'cloudflared')
  })

  it('gates off (no binaryProvenance config) resolves the healthy binary even against a ledger that would otherwise block', () => {
    FixtureCloudflaredProvider.resolvedOverride = null // process.execPath
    // Seeded with a MISMATCHING hash — if this were honored, block mode
    // would refuse. With the gate off, `buildBinaryProvenanceOptions` must
    // return `null` and `runProviderPreflight` must skip the provenance
    // step entirely, so this still resolves successfully.
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    const resolved = resolveVerifiedCloudflaredBinary({
      ProviderClass: FixtureCloudflaredProvider,
      ledger,
      readConfig: () => ({}),
    })
    assert.equal(resolved, process.execPath)
  })

  it('gates off + no ledger override never opens (or warns about) the real ledger file', (t) => {
    FixtureCloudflaredProvider.resolvedOverride = null // process.execPath
    const warnMock = t.mock.method(console, 'warn')
    // No `ledger` key at all — the gate being off must short-circuit BEFORE
    // the lazy default (`new BinaryProvenanceLedger()`, the daemon's real
    // default-path trust file — sandboxed to a tmp CHROXY_CONFIG_DIR by
    // tests/_setup.mjs but still real disk I/O) ever runs.
    const resolved = resolveVerifiedCloudflaredBinary({
      ProviderClass: FixtureCloudflaredProvider,
      readConfig: () => ({}),
    })
    assert.equal(resolved, process.execPath)
    assert.equal(warnMock.mock.callCount(), 0, 'gates off must never open (or warn about) the ledger file')
  })

  it('a missing binary refuses with the ordinary "not found" error, never a provenance failure, and never consults the ledger', () => {
    const missingPath = join(tmpDir('missing'), 'cloudflared-does-not-exist')
    FixtureCloudflaredProvider.resolvedOverride = missingPath
    try {
      assert.throws(
        () => resolveVerifiedCloudflaredBinary({
          ProviderClass: FixtureCloudflaredProvider,
          // A ledger that throws if the provenance step is ever reached —
          // proves the "not found" path never hashes anything, in block
          // mode, where a regression would be most dangerous (silently
          // TOFU-pinning or refusing for the wrong reason).
          ledger: boobyTrappedLedger(),
          readConfig: () => ({ binaryProvenance: { mode: 'block' } }),
        }),
        (err) => {
          assert.equal(err.code, 'PROVIDER_BINARY_NOT_FOUND')
          assert.match(err.message, /not found/)
          assert.doesNotMatch(err.message, /provenance/i)
          return true
        },
      )
    } finally {
      FixtureCloudflaredProvider.resolvedOverride = null
    }
  })

  it('reads the gate mode from a NON-default config path (-c <path>), not the default config.json', () => {
    // #8066 review lesson: the gate mode must come from the MERGED config
    // for the file `-c`/`--config` points at, not always
    // `<configDir>/config.json`. Uses the REAL `readGateConfig` (no
    // `readConfig` override) reading a REAL temp file, so this proves the
    // `configPath` plumbing end to end, not just that an injected fake gets
    // consulted.
    FixtureCloudflaredProvider.resolvedOverride = null // process.execPath
    const dir = tmpDir('config')
    const customConfigPath = join(dir, 'custom-config.json')
    writeFileSync(customConfigPath, JSON.stringify({ binaryProvenance: { mode: 'block' } }))
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_WRONG_HASH } })

    assert.throws(
      () => resolveVerifiedCloudflaredBinary({
        ProviderClass: FixtureCloudflaredProvider,
        ledger,
        configPath: customConfigPath,
      }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_BINARY_PROVENANCE')
        return true
      },
      'a block-mode custom config file reached via configPath must gate, proving configPath (not the default config.json) drove the mode',
    )

    // Sanity check the inverse: pointing at a config file with the gate OFF
    // resolves successfully even against the same mismatching ledger — so
    // the throw above is really coming from THIS file's content, not from
    // some other ambient state.
    const offConfigPath = join(dir, 'off-config.json')
    writeFileSync(offConfigPath, JSON.stringify({ binaryProvenance: { mode: 'off' } }))
    const resolved = resolveVerifiedCloudflaredBinary({
      ProviderClass: FixtureCloudflaredProvider,
      ledger,
      configPath: offConfigPath,
    })
    assert.equal(resolved, process.execPath)
  })

  it('production wiring: the REAL config reader + REAL default-path ledger refuse a block-mode hash mismatch (sandboxed under CHROXY_CONFIG_DIR)', () => {
    // No `readConfig` and no `ledger` override — exercises
    // `readGateConfig` (cli/shared.js) reading a REAL file, and
    // `new BinaryProvenanceLedger()` at its REAL default path, which
    // tests/_setup.mjs has already redirected under a per-process tmp
    // CHROXY_CONFIG_DIR (never the developer's real ~/.chroxy).
    const dir = tmpDir('prod-wiring')
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ binaryProvenance: { mode: 'block' } }))

    const shimDir = tmpDir('prod-wiring-bin')
    const shimPath = join(shimDir, 'cloudflared-prod-wiring')
    writeFileSync(shimPath, '#!/bin/sh\nexit 0\n')
    chmodSync(shimPath, 0o755)
    FixtureCloudflaredProvider.resolvedOverride = shimPath

    // First sight: trust-on-first-use pins the hash and allows — no prior
    // record exists yet in this test's fresh sandboxed ledger file.
    const firstResolved = resolveVerifiedCloudflaredBinary({
      ProviderClass: FixtureCloudflaredProvider,
      configPath,
    })
    assert.equal(firstResolved, shimPath)

    // Now the shim's content changes in place (simulating a swapped
    // binary) — the REAL ledger's pinned hash no longer matches, and block
    // mode must refuse, using the REAL config reader and REAL ledger path
    // the whole way (no injected `readConfig`/`ledger` in this call).
    writeFileSync(shimPath, '#!/bin/sh\necho changed\nexit 0\n')
    assert.throws(
      () => resolveVerifiedCloudflaredBinary({
        ProviderClass: FixtureCloudflaredProvider,
        configPath,
      }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_BINARY_PROVENANCE')
        return true
      },
      'a changed binary must be refused by the REAL default-path ledger in block mode — production wiring, no injected seams',
    )
  })
})

describe('runTunnelSetup — the exec is gated (#8066)', () => {
  it('a gate refusal: no prompt, no setup(), non-zero exit, and the printed message names the refusal', async (t) => {
    const savedExitCode = process.exitCode
    process.exitCode = 0
    const errorMock = t.mock.method(console, 'error')
    let setupCalled = false
    let promptCalled = false
    try {
      await runTunnelSetup({ config: '/nonexistent/config.json' }, {
        resolveBinary: () => { throw Object.assign(new Error('binary hash changed'), { code: 'PROVIDER_BINARY_PROVENANCE' }) },
        setup: () => { setupCalled = true },
        promptFn: async () => { promptCalled = true; return '' },
      })
      assert.equal(process.exitCode, 1, 'a gate refusal must set a non-zero exit code')
      assert.equal(setupCalled, false, 'setup() must never run after a refusal — this is the test that goes red under a mutant that swallows the refusal and proceeds anyway')
      assert.equal(promptCalled, false, 'no prompt may fire before a refusal')
      const errorMessages = errorMock.mock.calls.map((c) => String(c.arguments[0]))
      assert.ok(
        errorMessages.some((msg) => /Refusing to set up the tunnel:.*hash changed/.test(msg)),
        `expected a "Refusing to set up the tunnel: ... hash changed" console.error call, got: ${JSON.stringify(errorMessages)}`,
      )
    } finally {
      process.exitCode = savedExitCode
    }
  })

  it('a resolved path is forwarded to setup() exactly, with the promptFn seam', async () => {
    let captured = null
    await runTunnelSetup({ config: '/nonexistent/config.json' }, {
      resolveBinary: () => '/verified/absolute/path/to/cloudflared',
      setup: (path, deps) => { captured = { path, deps } },
      promptFn: async () => '',
    })
    assert.equal(captured.path, '/verified/absolute/path/to/cloudflared')
    assert.equal(typeof captured.deps.promptFn, 'function')
  })
})

describe('setupCloudflare execs the verified path for real (#8066)', () => {
  it('every cloudflared exec (login, create, route dns) runs the verified absolute path, never the bare string "cloudflared"', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
    const shim = makeCloudflaredShim()
    const harnessPath = makeSetupHarness()
    try {
      // Run out-of-process (see makeSetupHarness's docblock) — the child's
      // own exit code/status is not asserted on directly; the shim's marker
      // file, written by a REAL subprocess exec, is the ground truth.
      spawnSync(process.execPath, [
        harnessPath,
        shim.shimPath,
        JSON.stringify(['', '', 'chroxy.example.com']),
        '/nonexistent/config.json',
      ], { encoding: 'utf-8' })

      const invocations = shim.readInvocations()
      assert.equal(invocations.length, 3, `expected 3 cloudflared invocations (login, create, route dns), got: ${JSON.stringify(invocations)}`)
      for (const inv of invocations) {
        assert.equal(inv.argv0, shim.shimPath, 'every invocation must run the verified absolute path, not a bare "cloudflared" resolved off PATH')
      }
      assert.deepEqual(invocations[0].args, ['tunnel', 'login'])
      assert.deepEqual(invocations[1].args, cloudflaredCreateArgv('chroxy'))
      assert.deepEqual(invocations[2].args, cloudflaredRouteDnsArgv('chroxy', 'chroxy.example.com'))
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })
})
