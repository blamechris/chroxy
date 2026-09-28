/**
 * #8041 — `chroxy start`'s dependency checks (`runDoctorChecks`,
 * `src/doctor.js`) used to exec the configured provider's binary (plus
 * `claude` for `claude-tui`) and `cloudflared` with `--version` before any
 * session existed, with NO provenance or signature gate of any kind — in
 * `binaryProvenance.mode: 'block'`, a provider binary or `cloudflared` whose
 * pinned hash no longer matched the ledger still ran here unchecked, even
 * though the exact same binary would refuse a real chat session.
 *
 * `checkBinary()` (used for both cloudflared and every provider binary) and
 * `checkClaudeTuiCliVersion()` now route their `--version` probe through the
 * SAME opt-in provenance gate the daemon uses: `verifyProvenance`
 * (`utils/verify-provenance.js`) — the exact function `runProviderPreflight`
 * (provider spawns) and the tunnel adapter's `_verifyCloudflaredProvenance`
 * (`tunnel/cloudflare.js`) both call — reused here, not reimplemented a
 * third time. `runDoctorChecks` resolves the gate's mode/signatureGate from
 * config + env through `resolveBinaryProvenanceMode` / `isBinarySignatureGateEnabled`
 * (the same resolvers `chroxy start` / `chroxy resume` use) and normalizes
 * the options bag through `buildBinaryProvenanceOptions` (#8065's helper,
 * `utils/preflight.js`) — the same normalizer, not a second "is the gate off"
 * definition.
 *
 * Conventions (`fakeProvenanceLedger`, `SPAWN_GATE_*_HASH`, `makeGateShim`,
 * `WINDOWS_SHIM_EXEC_SKIP`) mirror `cli/session-cmd-binary-gate.test.js`'s
 * #8061 suite, so a regression in the shared gate machinery is caught by
 * either suite. Every fixture (shim, marker, fake HOME for the cloudflared
 * candidate-path test) lives under `os.tmpdir()`; the real
 * `~/.chroxy`/`~/.claude` trees are never touched (the fs-sandbox guard in
 * `tests/_setup.mjs` would throw if they were), and `CHROXY_CONFIG_DIR` is
 * already redirected to a per-process tmp dir by that same setup file.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBinary, checkClaudeTuiCliVersion, runDoctorChecks } from '../src/doctor.js'
import { registerProvider } from '../src/providers.js'
import { SdkSession } from '../src/sdk-session.js'
import { defaultBinaryTrustFile } from '../src/binary-provenance-trust.js'

// ── shared tmp root ─────────────────────────────────────────────────────────

let _tmpRoot
function tmpDir(prefix) {
  if (!_tmpRoot) _tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-provenance-'))
  return mkdtempSync(join(_tmpRoot, `${prefix}-`))
}
after(() => {
  if (_tmpRoot) rmSync(_tmpRoot, { recursive: true, force: true })
})

// #8065-style isolation: a stray CHROXY_BINARY_PROVENANCE / CHROXY_BINARY_SIGNATURE_GATE
// in the shell this suite happens to run under would outrank every config/
// options-bag value below (same precedence chroxy start/resume use), silently
// flipping "block mode" cases to pass or "gates off" cases to refuse.
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

// A hash that can never match a real binary's content — same convention as
// session-cmd-binary-gate.test.js / web-task-manager.test.js. The matching-hash
// cases below compute the real hash per-fixture via `hashFile()` instead of a
// module-level constant, since each test builds its own shim file.
const SPAWN_GATE_WRONG_HASH = 'f'.repeat(64)

// doctor.test.js's own header warns that these tests run against the real
// system and can be flakily influenced by whatever the developer has in their
// REAL ~/.chroxy — `doctor-config-dir.test.js` exists specifically to inject
// a clean `detectStranded` stub instead of depending on it. Every
// `runDoctorChecks` call below that asserts on `passed` (the daemon-wide
// pass/fail used for `chroxy start`'s exit code) does the same: on a machine
// with a REAL `~/.chroxy/config.json` (this one, developing this suite,
// included), doctor's #7240 stranded-state detection compares the sandboxed
// `CHROXY_CONFIG_DIR` against that real root and marks `config.json`
// "high-consequence stranded", forcibly failing the unrelated `Config` check
// — which has nothing to do with the provenance gate under test here, but
// would otherwise flip `passed` to false regardless of it.
const CLEAN_STRANDED_STATE = () => ({
  relocated: false, source: '/tmp/doctor-provenance-fixture-home/.chroxy', target: '/tmp/doctor-provenance-fixture-home/.chroxy',
  stranded: [], highConsequence: [], unreadable: null,
})

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fakeProvenanceLedger(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    getRecord: (p) => (records.has(p) ? { ...records.get(p) } : null),
    approve: (p, sha256) => { records.set(p, { sha256 }); return true },
    _records: records,
  }
}

/**
 * A REAL, tiny executable script that writes a marker file the instant it
 * runs, prints a version-shaped line, and exits 0 — same convention as
 * `session-cmd-binary-gate.test.js`'s `makeGateShim()`. Used instead of a
 * mocked exec so "the version probe actually ran the VERIFIED path" (or
 * "never ran at all") is proven by a real subprocess side effect.
 */
function makeGateShim() {
  const dir = tmpDir('shim')
  const shimPath = join(dir, 'gate-shim.mjs')
  const markerPath = join(dir, 'marker.txt')
  const body = [
    // The absolute `process.execPath`, NOT `#!/usr/bin/env node` — the
    // cloudflared suite below empties `process.env.PATH` to keep `which
    // cloudflared` from finding a real install, and that same empty PATH
    // would leave `/usr/bin/env` unable to resolve a bare `node` for the
    // shim's OWN shebang, making the "exec'd for real" assertions fail for a
    // reason unrelated to the gate under test.
    `#!${process.execPath}`,
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
    `console.log('9.9.9 (gate-shim)')`,
    'process.exit(0)',
  ].join('\n')
  writeFileSync(shimPath, body)
  chmodSync(shimPath, 0o755)
  return { dir, shimPath, markerPath }
}

// A `.mjs` shebang shim is not directly executable via execFile/execFileSync
// on Windows (no shebang interpretation the way POSIX execve provides). Every
// case that instead proves a REFUSAL (a block-mode ledger mismatch, no spawn
// attempted) never reaches execFileSync at all, so those keep running
// unmodified on every platform, Windows included — only the "still execs"
// cases are skipped there.
const WINDOWS_SHIM_EXEC_SKIP = process.platform === 'win32'
  ? 'a .mjs shebang shim is not directly executable via execFileSync on Windows; the refusal/no-spawn cases still run there'
  : false

describe('checkBinary — opt-in provenance gate (#8041)', () => {
  it('a block-mode ledger hash mismatch returns fail with the provenance code — never execs', () => {
    const shim = makeGateShim()
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    try {
      const result = checkBinary('chroxy-8041-fixture-bin', ['--version'], {
        parseVersion: (out) => out.trim(),
        required: true,
        candidates: [shim.shimPath],
        installHint: 'install chroxy-8041-fixture-bin',
        provenance: { mode: 'block', signatureGate: false, ledger },
      })
      assert.equal(result.status, 'fail', `expected fail, got ${result.status}: ${result.message}`)
      assert.match(result.message, /hash_mismatch/)
      assert.ok(result.message.includes(shim.shimPath), 'the fail message must name the resolved path that was refused')
      assert.equal(existsSync(shim.markerPath), false, 'the shim must never have been exec\'d — this is the test that goes red under a mutant that swallows the refusal and execs anyway')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('a matching-hash ledger in block mode execs the exact verified absolute path and returns pass', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
    const shim = makeGateShim()
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: hashFile(shim.shimPath) } })
    try {
      const result = checkBinary('chroxy-8041-fixture-bin', ['--version'], {
        parseVersion: (out) => out.trim(),
        required: true,
        candidates: [shim.shimPath],
        installHint: 'install chroxy-8041-fixture-bin',
        provenance: { mode: 'block', signatureGate: false, ledger },
      })
      assert.equal(result.status, 'pass', `expected pass, got ${result.status}: ${result.message}`)
      assert.match(result.message, /9\.9\.9/, 'the printed version must come from the shim, proving it was actually exec\'d')
      assert.equal(existsSync(shim.markerPath), true, 'execFileSync is synchronous, so the marker exists by the time checkBinary returns')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('gates off (provenance: null) execs unchanged even against a ledger that would otherwise block', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
    const shim = makeGateShim()
    try {
      // provenance defaults to null — no ledger is even passed, mirroring how
      // buildBinaryProvenanceOptions returns null when the operator hasn't
      // opted in (runDoctorChecks then never constructs a ledger either).
      const result = checkBinary('chroxy-8041-fixture-bin', ['--version'], {
        parseVersion: (out) => out.trim(),
        required: true,
        candidates: [shim.shimPath],
        installHint: 'install chroxy-8041-fixture-bin',
      })
      assert.equal(result.status, 'pass', `expected pass, got ${result.status}: ${result.message}`)
      assert.equal(existsSync(shim.markerPath), true, 'gates off must still exec the healthy binary — the same observable outcome as before #8041')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('warn mode with a hash mismatch still execs — surfaced, not blocked', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
    const shim = makeGateShim()
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    try {
      const result = checkBinary('chroxy-8041-fixture-bin', ['--version'], {
        parseVersion: (out) => out.trim(),
        required: true,
        candidates: [shim.shimPath],
        installHint: 'install chroxy-8041-fixture-bin',
        provenance: { mode: 'warn', signatureGate: false, ledger },
      })
      assert.equal(result.status, 'pass', `warn mode must still allow the spawn, got ${result.status}: ${result.message}`)
      assert.equal(existsSync(shim.markerPath), true, 'warn mode surfaces the mismatch but still execs')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })
})

describe('checkClaudeTuiCliVersion — opt-in provenance gate (#8041)', () => {
  it('a block-mode ledger hash mismatch returns fail with the provenance code — never execs', () => {
    const shim = makeGateShim()
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    try {
      const result = checkClaudeTuiCliVersion({
        resolveBinary: () => shim.shimPath,
        provenance: { mode: 'block', signatureGate: false, ledger },
      })
      assert.ok(result, 'expected a check result, not null')
      assert.equal(result.status, 'fail', `expected fail, got ${result.status}: ${result.message}`)
      assert.match(result.message, /hash_mismatch/)
      assert.equal(existsSync(shim.markerPath), false, 'the claude-tui version probe must never exec an unverified binary')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('a matching-hash ledger in block mode execs the exact verified absolute path', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
    const shim = makeGateShim()
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: hashFile(shim.shimPath) } })
    try {
      const result = checkClaudeTuiCliVersion({
        resolveBinary: () => shim.shimPath,
        provenance: { mode: 'block', signatureGate: false, ledger },
      })
      assert.ok(result, 'expected a check result, not null')
      assert.notEqual(result.status, 'fail', `expected a non-fail result, got ${result.status}: ${result.message}`)
      assert.equal(existsSync(shim.markerPath), true, 'the verified shim must have been exec\'d for real')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('gates off (provenance: null, the default) execs unchanged', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
    const shim = makeGateShim()
    try {
      const result = checkClaudeTuiCliVersion({ resolveBinary: () => shim.shimPath })
      assert.ok(result)
      assert.notEqual(result.status, 'fail')
      assert.equal(existsSync(shim.markerPath), true)
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })
})

describe('runDoctorChecks — provider binary provenance gate, production wiring (#8041)', () => {
  function registerFixtureProvider(name, candidates) {
    class FixtureSession extends SdkSession {
      static get preflight() {
        return {
          label: name,
          // A bogus binary name (never on any real PATH) forces resolveBinary's
          // `which`/`where` lookup to fail and fall through to `candidates` —
          // deterministic regardless of what happens to be installed on the
          // machine running this suite.
          binary: { name: 'chroxy-8041-fixture-bin', args: ['--version'], candidates },
        }
      }
    }
    registerProvider(name, FixtureSession)
  }

  function binaryRow(checks, provider) {
    return checks.find((c) => c.provider === provider && c.name === 'chroxy-8041-fixture-bin')
  }

  // #8041 review: `binaryProvenanceMode`/`binarySignatureGate` are passed as
  // PLAIN FUNCTION ARGUMENTS (a seam `runDoctorChecks` added specifically for
  // this suite), never via `process.env.CHROXY_BINARY_PROVENANCE` mutation —
  // this test runner schedules sibling `it()`s within one file concurrently,
  // so a shared, mutated `process.env` var is a race (two tests observing
  // each other's value mid-flight). The override still exercises the real
  // `buildBinaryProvenanceOptions` normalization and the real lazy-ledger
  // construction path in `runDoctorChecks` — only the mode/signatureGate
  // RESOLUTION step (config file + env, already covered by config.js's own
  // `resolveBinaryProvenanceMode`/`isBinarySignatureGateEnabled` tests) is
  // bypassed.
  it('block mode: the provider binary row fails with the provenance code, doctor as a whole fails, and the binary is never exec\'d', async () => {
    const shim = makeGateShim()
    const providerName = 'test-8041-provider-block'
    registerFixtureProvider(providerName, [shim.shimPath])
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    try {
      const { checks, passed } = await runDoctorChecks({
        providers: [providerName],
        binaryProvenanceMode: 'block',
        binaryProvenanceLedger: ledger,
        detectStranded: CLEAN_STRANDED_STATE,
      })
      const row = binaryRow(checks, providerName)
      assert.ok(row, 'the provider binary row must be present')
      assert.equal(row.status, 'fail', `expected fail, got ${row.status}: ${row.message}`)
      assert.match(row.message, /hash_mismatch/)
      assert.equal(passed, false, 'runDoctorChecks.passed must be false — this is the exact field server-cmd.js filters on to set a non-zero chroxy start exit code')
      assert.equal(existsSync(shim.markerPath), false, 'the provider binary must never have been exec\'d — red under a mutant that swallows the refusal and execs anyway')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('a matching-hash ledger in block mode probes the exact verified absolute path (never the bare binary name)', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
    const shim = makeGateShim()
    const providerName = 'test-8041-provider-match'
    registerFixtureProvider(providerName, [shim.shimPath])
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: hashFile(shim.shimPath) } })
    try {
      const { checks, passed } = await runDoctorChecks({
        providers: [providerName],
        binaryProvenanceMode: 'block',
        binaryProvenanceLedger: ledger,
        detectStranded: CLEAN_STRANDED_STATE,
      })
      const row = binaryRow(checks, providerName)
      assert.ok(row)
      assert.equal(row.status, 'pass', `expected pass, got ${row.status}: ${row.message}`)
      assert.match(row.message, /9\.9\.9/, 'the printed version must come from the shim at the verified path, proving that exact path was probed')
      assert.equal(existsSync(shim.markerPath), true)
      assert.equal(passed, true, `expected passed=true; failing checks: ${JSON.stringify(checks.filter(c => c.status === 'fail'))}`)
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('gates off: behaviour is unchanged even against a ledger that would otherwise block', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
    const shim = makeGateShim()
    const providerName = 'test-8041-provider-off'
    registerFixtureProvider(providerName, [shim.shimPath])
    // A WRONG hash — ignored entirely because binaryProvenanceMode: 'off' is
    // explicit here (never inherited from ambient env/config).
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    try {
      const { checks, passed } = await runDoctorChecks({
        providers: [providerName],
        binaryProvenanceMode: 'off',
        binarySignatureGate: false,
        binaryProvenanceLedger: ledger,
        detectStranded: CLEAN_STRANDED_STATE,
      })
      const row = binaryRow(checks, providerName)
      assert.ok(row)
      assert.equal(row.status, 'pass', `gates off must still pass a healthy binary, got ${row.status}: ${row.message}`)
      assert.equal(existsSync(shim.markerPath), true)
      assert.equal(passed, true)
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('gates off never constructs (or touches) the real binary-trust.json ledger', async () => {
    const providerName = 'test-8041-provider-no-ledger-touch'
    registerFixtureProvider(providerName, [])
    // No `binaryProvenanceLedger` override AND no mode override — exercises
    // the REAL config+env resolution (ambient CHROXY_BINARY_PROVENANCE is
    // cleared for this whole file by the outer before/after) and the REAL
    // lazy-construct branch. If gate resolution were wrong (e.g. defaulting
    // to "on"), this would create the real default-path ledger file. Checked
    // via the filesystem rather than a mocked console.warn/log — a mock on
    // the shared `console` global would itself race against any OTHER test
    // in this file that legitimately warns (e.g. the "warn mode" cases
    // above) under this runner's concurrent scheduling.
    await runDoctorChecks({ providers: [providerName] })
    assert.equal(
      existsSync(defaultBinaryTrustFile()),
      false,
      'gates off must never construct (or write) the real binary-trust.json — every OTHER test in this file that turns the gate on always supplies an explicit ledger override, so this file is the only writer and this check is race-free',
    )
  })
})

describe('runDoctorChecks — cloudflared provenance gate, production wiring (#8041)', () => {
  // `cloudflaredCandidates` (a #8041 test seam on `runDoctorChecks`) points
  // resolution at a fixture instead of depending on whether a REAL
  // cloudflared happens to be installed at one of the fixed production
  // candidates on the machine running this suite — it was, during
  // development of this test (a homebrew cloudflared at
  // `/opt/homebrew/bin/cloudflared`), which is exactly the environment
  // dependency this seam removes. `process.env.PATH` still needs emptying
  // for the same reason: `resolveBinary` tries a bare `which cloudflared`
  // BEFORE ever consulting `candidates`, and that dev machine also has
  // cloudflared on PATH. `PATH` is process-global and this test runner
  // schedules sibling `it()`s within a file concurrently, so — unlike the
  // `binaryProvenanceMode`/`cloudflaredCandidates` seams, which are plain
  // function arguments — every scenario that needs an empty PATH runs as a
  // sequential step inside ONE test, sharing ONE override installed and
  // restored exactly once.
  class NoPreflightSession extends SdkSession {
    static get preflight() { return null }
  }
  before(() => {
    // No provider binary requirement in play — isolates every assertion
    // below to the cloudflared row.
    registerProvider('test-8041-cloudflared-noop-provider', NoPreflightSession)
  })

  it('block mode refuses and never execs; a matching-hash ledger probes the verified path; gates off is unchanged', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
    const shim = makeGateShim()
    const savedPath = process.env.PATH
    process.env.PATH = ''
    try {
      const cloudflaredRow = async (opts) => {
        const { checks } = await runDoctorChecks({
          providers: ['test-8041-cloudflared-noop-provider'],
          cloudflaredCandidates: [shim.shimPath],
          ...opts,
        })
        return checks.find((c) => c.name === 'cloudflared')
      }

      // Step 1 — block mode, hash mismatch: refuses, never execs.
      const mismatchLedger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
      const blockedRow = await cloudflaredRow({ binaryProvenanceMode: 'block', binaryProvenanceLedger: mismatchLedger })
      assert.ok(blockedRow)
      assert.equal(blockedRow.status, 'fail', `expected fail, got ${blockedRow.status}: ${blockedRow.message}`)
      assert.match(blockedRow.message, /hash_mismatch/)
      assert.equal(existsSync(shim.markerPath), false, 'cloudflared must never have been exec\'d — red under a mutant that swallows the refusal and execs anyway')

      // Step 2 — block mode, matching hash: probes the exact verified path.
      const matchLedger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: hashFile(shim.shimPath) } })
      const matchedRow = await cloudflaredRow({ binaryProvenanceMode: 'block', binaryProvenanceLedger: matchLedger })
      assert.ok(matchedRow)
      assert.equal(matchedRow.status, 'pass', `expected pass, got ${matchedRow.status}: ${matchedRow.message}`)
      assert.match(matchedRow.message, /9\.9\.9/, 'the printed version must come from the verified shim, proving that exact path was probed')
      assert.equal(existsSync(shim.markerPath), true)

      // Step 3 — gates off: unchanged, even against a ledger that would
      // otherwise block.
      rmSync(shim.markerPath, { force: true })
      const offRow = await cloudflaredRow({ binaryProvenanceMode: 'off', binarySignatureGate: false, binaryProvenanceLedger: mismatchLedger })
      assert.ok(offRow)
      assert.equal(offRow.status, 'pass', `gates off must still pass, got ${offRow.status}: ${offRow.message}`)
      assert.equal(existsSync(shim.markerPath), true)
    } finally {
      process.env.PATH = savedPath
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })
})
