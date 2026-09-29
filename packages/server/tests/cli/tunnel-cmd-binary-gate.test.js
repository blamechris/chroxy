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
 * #8076 review C1 — SAFETY: any test whose failure path could exec the real
 * `cloudflared` is dangerous on a developer machine, because
 * `CLOUDFLARED_CANDIDATES` (tunnel/cloudflare.js) holds ABSOLUTE fallback
 * paths — a sanitized PATH does not stop `resolveBinary()` from finding a
 * real install there. Every test that runs the real `setupCloudflare` does so
 * in a CHILD PROCESS (`makeSetupHarness`) with an exec tripwire installed
 * BEFORE `tunnel-cmd.js` is ever imported: every `child_process` spawn
 * function is patched to allow ONLY the exact shim path this suite controls,
 * so a regression that bypasses the injected resolver, or reverts an exec
 * site to a bare/real path, is refused inside the child and logged, never
 * actually executed. This is independent of whether the harness's own
 * `deps.resolveBinary` seam is honoured — it protects against exactly the
 * regression where it isn't (see the D6 mutant note on `makeSetupHarness`).
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
import { BinaryProvenanceLedger } from '../../src/binary-provenance-trust.js'
import { PathHashTrustLedger } from '../../src/path-hash-trust-ledger.js'

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
 * A REAL, tiny executable script that records every invocation's args to a
 * marker file and exits 0 — same convention as `makeGateShim()` in
 * session-cmd-binary-gate.test.js / web-task-manager.test.js. Used so "the
 * exec actually ran the VERIFIED path" is proven by a real subprocess side
 * effect, and so `setupCloudflare`'s literal `execFileSync(cloudflaredPath,
 * ...)` call sites — deliberately NOT hidden behind an injectable seam, so
 * `scripts/lint-argv-sinks.mjs` keeps tracing them — are exercised for real.
 *
 * #8076 review N3: no longer records `process.argv[1]` ("argv0") — that
 * assertion could never fail on its own (the shim's absolute path is the
 * only way to reach it at all, so a recorded invocation always came from
 * it), and dropping it also drops the need for a `lint-ignore-entry-point-
 * guard` marker. The exec tripwire in `makeSetupHarness` is what actually
 * proves no OTHER path was ever exec'd.
 */
function makeCloudflaredShim() {
  const dir = tmpDir('shim')
  const shimPath = join(dir, 'cloudflared-shim.mjs')
  const logPath = join(dir, 'invocations.jsonl')
  const body = [
    '#!/usr/bin/env node',
    `import { appendFileSync } from 'node:fs'`,
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n')`,
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
 * #8076 review C1 — the exec tripwire below is installed BEFORE
 * `tunnel-cmd.js` is imported (`syncBuiltinESMExports()` propagates the
 * patched `node:child_process` CJS exports onto the ESM namespace every
 * `import('child_process')` — static or dynamic, anywhere in this process —
 * observes from then on). It allows a spawn ONLY when its target file is
 * EXACTLY `cloudflaredPath` (this harness invocation's own shim); anything
 * else — `which`, a real `/opt/homebrew/bin/cloudflared` a mutant resolved
 * through the absolute `CLOUDFLARED_CANDIDATES` fallback, a bare
 * `'cloudflared'` — is refused with a synthetic ENOENT and logged to
 * `tripLogPath`. This is what lets mutant D6 (`runTunnelSetup` ignores the
 * injected resolver and always calls the real `resolveVerifiedCloudflaredBinary`)
 * run safely: without it, D6 would resolve the REAL installed `cloudflared`
 * via `CLOUDFLARED_CANDIDATES` and exec `tunnel login` for real, opening a
 * genuine Cloudflare OAuth page.
 *
 * `setupCloudflare`'s pre-existing login-failure branch calls `process.exit(1)`
 * directly (unchanged by #8066 — out of scope here) — if a blocked exec (or a
 * bare, unresolved `'cloudflared'`) ever reaches that `execFileSync` call,
 * the login exec throws and that branch exits the process outright. Running
 * this in-process would kill the whole `node --test` run instead of failing
 * one test red (see docs/false-safety-guards.md's "a guard that HANGS
 * instead of failing" entry) — spawning a real child process means a
 * mutant-triggered `process.exit()` only ends that child; the parent test
 * reads the shim's marker file, the trip log, and the child's exit code /
 * stderr as the ground truth regardless of how the child ended.
 */
function makeSetupHarness() {
  const dir = tmpDir('harness')
  const harnessPath = join(dir, 'run-setup.mjs')
  const tripLogPath = join(dir, 'trip.jsonl')
  const body = [
    `import { createRequire, syncBuiltinESMExports } from 'node:module'`,
    `import { appendFileSync } from 'node:fs'`,
    'const [, , cloudflaredPath, answersJson, configPath, tripLogPath] = process.argv',
    "const cp = createRequire(import.meta.url)('node:child_process')",
    "for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {",
    '  const real = cp[name]',
    '  cp[name] = function tripwire(file, ...rest) {',
    '    if (file === cloudflaredPath) return real.call(this, file, ...rest)',
    "    appendFileSync(tripLogPath, JSON.stringify({ fn: name, file: String(file) }) + '\\n')",
    "    const err = new Error('tripwire: blocked a non-shim exec of ' + file)",
    "    err.code = 'ENOENT'",
    '    throw err',
    '  }',
    '}',
    'syncBuiltinESMExports()',
    `const { runTunnelSetup } = await import(${JSON.stringify(TUNNEL_CMD_URL)})`,
    'const answers = JSON.parse(answersJson)',
    'let i = 0',
    "const promptFn = async () => answers[i++] ?? ''",
    'await runTunnelSetup({ config: configPath }, { resolveBinary: () => cloudflaredPath, promptFn })',
  ].join('\n')
  writeFileSync(harnessPath, body)
  return { dir, harnessPath, tripLogPath }
}

/**
 * Read the tripwire's log (see `makeSetupHarness`). Absent file (nothing was
 * ever blocked) reads the same as an empty array.
 */
function readTripLog(tripLogPath) {
  return existsSync(tripLogPath)
    ? readFileSync(tripLogPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
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
    // #8076 review S5: "never warns" alone cannot fail — a missing ledger
    // file never warns whether or not it was opened, so a mutant that
    // unconditionally constructs `new BinaryProvenanceLedger()` survived
    // against `console.warn` alone (D7). Spy on the actual load call
    // instead — `BinaryProvenanceLedger`'s constructor calls
    // `this._loadRecords()` directly (binary-provenance-trust.js), so a
    // callCount of 0 proves no ledger was ever constructed, not just that
    // nothing logged.
    const loadMock = t.mock.method(PathHashTrustLedger.prototype, '_loadRecords')
    // No `ledger` key at all — the gate being off must short-circuit BEFORE
    // the lazy default (`new BinaryProvenanceLedger()`, the daemon's real
    // default-path trust file — sandboxed to a tmp CHROXY_CONFIG_DIR by
    // tests/_setup.mjs but still real disk I/O) ever runs.
    const resolved = resolveVerifiedCloudflaredBinary({
      ProviderClass: FixtureCloudflaredProvider,
      readConfig: () => ({}),
    })
    assert.equal(resolved, process.execPath)
    assert.equal(loadMock.mock.callCount(), 0, 'gates off must never construct (or load) the real ledger file — this is the test that goes red under D7 (a mutant that unconditionally constructs one)')
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

  it('a corrupt -c config file refuses via GATE_CONFIG_UNREADABLE, never silently falls open to gates-off (#8076 review S6)', () => {
    // #8076 review S6 (D5b): the tunnel resolver must not catch
    // `readConfig()`'s throw and default to `{}`. Uses the REAL
    // `readGateConfig` (no `readConfig` override), so a wrapper that
    // swallowed the error would resolve successfully instead of throwing.
    FixtureCloudflaredProvider.resolvedOverride = null // process.execPath
    const dir = tmpDir('corrupt-config')
    const configPath = join(dir, 'corrupt.json')
    writeFileSync(configPath, '{"binaryProvenance":{"mode":"block"},}') // trailing comma
    assert.throws(
      () => resolveVerifiedCloudflaredBinary({
        ProviderClass: FixtureCloudflaredProvider,
        configPath,
      }),
      (err) => {
        assert.equal(err.code, 'GATE_CONFIG_UNREADABLE')
        return true
      },
    )
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

  it('a missing-binary refusal prints the ordinary "not found" message, not "Refusing to set up the tunnel" (#8076 review N1)', async (t) => {
    const savedExitCode = process.exitCode
    process.exitCode = 0
    const errorMock = t.mock.method(console, 'error')
    let setupCalled = false
    try {
      await runTunnelSetup({ config: '/nonexistent/config.json' }, {
        resolveBinary: () => {
          throw Object.assign(new Error('cloudflared: required binary "cloudflared" not found (checked PATH). brew install cloudflared.'), {
            code: 'PROVIDER_BINARY_NOT_FOUND',
            installHint: 'brew install cloudflared',
          })
        },
        setup: () => { setupCalled = true },
      })
      assert.equal(process.exitCode, 1)
      assert.equal(setupCalled, false)
      const errorMessages = errorMock.mock.calls.map((c) => String(c.arguments[0]))
      assert.ok(
        errorMessages.some((msg) => /cloudflared not found\. Install with: brew install cloudflared/.test(msg)),
        `expected the ordinary "cloudflared not found. Install with: ..." message, got: ${JSON.stringify(errorMessages)}`,
      )
      assert.ok(
        !errorMessages.some((msg) => /Refusing to set up the tunnel/.test(msg)),
        `a missing-binary message must not read like a security refusal, got: ${JSON.stringify(errorMessages)}`,
      )
    } finally {
      process.exitCode = savedExitCode
    }
  })

  it('a resolved path is forwarded to setup() exactly, with the configPath and promptFn seams (#8076 review S3)', async () => {
    let captured = null
    await runTunnelSetup({ config: '/some/config/path.json' }, {
      resolveBinary: () => '/verified/absolute/path/to/cloudflared',
      setup: (path, configWritePath, deps) => { captured = { path, configWritePath, deps } },
      promptFn: async () => '',
    })
    assert.equal(captured.path, '/verified/absolute/path/to/cloudflared')
    assert.equal(captured.configWritePath, '/some/config/path.json', 'the SAME -c path must reach setup() for Step 4 to write to')
    assert.equal(typeof captured.deps.promptFn, 'function')
  })

  it('a corrupt -c config refuses via GATE_CONFIG_UNREADABLE through the PRODUCTION default resolver — no setup() call (#8076 review S6)', async () => {
    const dir = tmpDir('corrupt-config-e2e')
    const configPath = join(dir, 'corrupt.json')
    writeFileSync(configPath, '{"binaryProvenance":{"mode":"block"},}') // trailing comma
    const savedExitCode = process.exitCode
    process.exitCode = 0
    let setupCalled = false
    try {
      // No `resolveBinary` override — exercises the REAL default
      // `resolveVerifiedCloudflaredBinary` end to end. `setup` is a spy, so
      // nothing execs even if resolution unexpectedly fell through to a
      // real candidate path.
      await runTunnelSetup({ config: configPath }, {
        setup: () => { setupCalled = true },
        promptFn: async () => '',
      })
      assert.equal(process.exitCode, 1, 'a corrupt gate config must refuse with a non-zero exit code')
      assert.equal(setupCalled, false, 'setup() must never run when the gate config cannot be read')
    } finally {
      process.exitCode = savedExitCode
    }
  })

  it('the default resolver + the -c hop both drive the gate, through the PRODUCTION path end to end (#8076 review S1)', async () => {
    // #8076 review S1: every other `runTunnelSetup` test injects
    // `resolveBinary`, so a mutant that replaces the DEFAULT resolver with a
    // bare stub (D3), or that drops `-c` on its way to the resolver (D2b),
    // survived every test in this file. This test supplies NEITHER
    // `resolveBinary` NOR a `ProviderClass` override — only `setup` (a spy,
    // so nothing execs even if resolution unexpectedly succeeds) and a
    // `-c` config path pointing at a REAL, block-mode file with a
    // REAL, sandboxed ledger seeded with the WRONG hash for a REAL stub
    // executable that `which cloudflared` can find on a deliberately
    // minimal PATH (no `/opt/homebrew/bin` or other real-cloudflared
    // location).
    const dir = tmpDir('prod-wiring-runsetup')
    const binDir = tmpDir('prod-wiring-runsetup-bin')
    const stubPath = join(binDir, 'cloudflared')
    writeFileSync(stubPath, '#!/bin/sh\nexit 0\n')
    chmodSync(stubPath, 0o755)

    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ binaryProvenance: { mode: 'block' } }))

    // Seed the REAL sandboxed default-path ledger with a WRONG hash for
    // this exact stub path — `approve()` persists synchronously.
    new BinaryProvenanceLedger().approve(stubPath, SPAWN_GATE_WRONG_HASH)

    const savedPath = process.env.PATH
    process.env.PATH = `${binDir}:/usr/bin:/bin`
    const savedExitCode = process.exitCode
    process.exitCode = 0
    let setupCalled = false
    try {
      await runTunnelSetup({ config: configPath }, {
        setup: () => { setupCalled = true },
        promptFn: async () => '',
      })
      assert.equal(process.exitCode, 1, 'a block-mode hash mismatch on the production path must refuse')
      assert.equal(setupCalled, false, 'setup() must never run — this is the test that goes red under D3 (default resolver replaced with a bare stub) and D2b (-c dropped on the hop to the resolver)')
    } finally {
      process.env.PATH = savedPath
      process.exitCode = savedExitCode
    }
  })
})

describe('setupCloudflare execs the verified path for real (#8066)', () => {
  it('every cloudflared exec (login, create, route dns) runs the verified absolute path, never the bare string "cloudflared", and Step 4 writes to the -c path (#8076 review S3)', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
    const shim = makeCloudflaredShim()
    const harness = makeSetupHarness()
    const configPath = join(tmpDir('exec-config'), 'config.json')
    try {
      const result = spawnSync(process.execPath, [
        harness.harnessPath,
        shim.shimPath,
        JSON.stringify(['', '', 'chroxy.example.com']),
        configPath,
        harness.tripLogPath,
      ], { encoding: 'utf-8', timeout: 30_000 })

      const diag = `status=${result.status} signal=${result.signal} stderr=${result.stderr}`
      assert.equal(result.signal, null, `the harness child was killed by a signal (possibly the 30s timeout) — ${diag}`)

      // #8076 review C1: the tripwire log must be EMPTY — proves nothing
      // other than the shim path was ever exec'd, regardless of how the
      // child otherwise behaved.
      const tripEntries = readTripLog(harness.tripLogPath)
      assert.deepEqual(tripEntries, [], `the tripwire recorded a non-shim exec attempt — ${diag}`)

      const invocations = shim.readInvocations()
      assert.equal(invocations.length, 3, `expected 3 cloudflared invocations (login, create, route dns), got ${invocations.length}: ${JSON.stringify(invocations)} — ${diag}`)
      assert.deepEqual(invocations[0].args, ['tunnel', 'login'])
      assert.deepEqual(invocations[1].args, cloudflaredCreateArgv('chroxy'))
      assert.deepEqual(invocations[2].args, cloudflaredRouteDnsArgv('chroxy', 'chroxy.example.com'))

      // #8076 review S3: Step 4 must write to the -c path, not the default
      // config.json — the file the gate read from.
      assert.ok(existsSync(configPath), `Step 4 must write the tunnel settings to the -c path — ${diag}`)
      const written = JSON.parse(readFileSync(configPath, 'utf-8'))
      assert.equal(written.tunnel, 'named')
      assert.equal(written.tunnelName, 'chroxy')
      assert.equal(written.tunnelHostname, 'chroxy.example.com')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
