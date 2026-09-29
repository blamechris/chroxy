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
 * either suite. Every fixture (shim, marker) lives under `os.tmpdir()`; the
 * real `~/.chroxy`/`~/.claude` trees are never touched (the fs-sandbox guard
 * in `tests/_setup.mjs` would throw if they were), and `CHROXY_CONFIG_DIR` is
 * already redirected to a per-process tmp dir by that same setup file — the
 * one test that DOES write a real config file there (the C3(a) real-config
 * test, #8074 review) saves and restores it explicitly.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBinary, checkClaudeTuiCliVersion, runDoctorChecks } from '../src/doctor.js'
import { registerProvider, getProvider } from '../src/providers.js'
import { SdkSession } from '../src/sdk-session.js'
import { defaultBinaryTrustFile } from '../src/binary-provenance-trust.js'
import { configPath } from '../src/config-dir.js'
import { verifyProvenance as realVerifyProvenance } from '../src/utils/verify-provenance.js'

// #8093 review S5: `runDoctorChecks` also runs the cloudflared row — resolved
// off the real PATH, with no seam to point it at a fixture — regardless of
// `providers`. On a host where `claude`/`cloudflared` happens to be an npm JS
// launcher, the tests below would walk that REAL installed package tree with
// pinning on. Every `runDoctorChecks` call in this describe that turns the
// gate ON pins `classifyBinary` to a `native`-only stub, mirroring how
// verify-provenance.test.js / binary-provenance-trust.test.js already do this
// for the same reason — these tests are about the GATE's wiring, not about
// package-tree classification (covered end-to-end elsewhere).
const CLASSIFY_NATIVE_VERIFY_PROVENANCE = (opts) => realVerifyProvenance({ ...opts, classifyBinary: () => ({ kind: 'native' }) })

// #8096: `runDoctorChecks` always runs the cloudflared row too, independent of
// `providers` — resolved via `resolveBinary('cloudflared', cloudflaredCandidates)`,
// which tries `which cloudflared` off THIS PROCESS'S real PATH first and, when
// that fails, falls through to the fixed, real install paths in
// `CLOUDFLARED_CANDIDATES` (`/opt/homebrew/bin/cloudflared`, etc). On a host
// with cloudflared installed at ANY of those (this repo's own dev machines
// included), every `runDoctorChecks` call below that neither empties PATH nor
// overrides `cloudflaredCandidates` resolves, health-checks and — once healthy —
// EXECS `<real cloudflared> --version` for real, gate on or off (the gate only
// decides whether it's also HASHED first). Route every call through this
// helper instead of calling `runDoctorChecks` directly: it always passes
// `cloudflaredCandidates: []` (so the candidates fallback can never rediscover
// a real install) AND scopes `process.env.PATH` to empty for the call's
// duration (so `which cloudflared` can't find one either) — restoring PATH
// in a `finally` regardless of outcome. Either alone is insufficient: an
// emptied PATH with the real candidates list still finds a real install via
// the fallback, and an empty candidates list with a real PATH still finds one
// via `which`.
async function runDoctorChecksNoRealCloudflared(opts) {
  const savedPath = process.env.PATH
  process.env.PATH = ''
  try {
    return await runDoctorChecks({ cloudflaredCandidates: [], ...opts })
  } finally {
    process.env.PATH = savedPath
  }
}

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

  it('a missing binary in block mode reports "Not found" — never "provenance unreadable" (#8074 review C2)', () => {
    const ledger = fakeProvenanceLedger()
    const result = checkBinary('chroxy-8041-definitely-missing-xyz', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [],
      installHint: 'install chroxy-8041-definitely-missing-xyz',
      provenance: { mode: 'block', signatureGate: false, ledger },
    })
    assert.equal(result.status, 'fail')
    assert.match(result.message, /^Not found — /, `expected a "Not found" message, got: ${result.message}`)
    assert.doesNotMatch(result.message, /provenance/, 'a missing binary must never be reported as a provenance failure — the operator should never be told to disable a security control for a binary that was simply never installed')
  })

  it('a same-named file in the current working directory is never pinned by the ledger (#8074 review C2)', () => {
    // Reproduces the exact defect the review found: a bare, unresolved name
    // (no PATH match, no candidates) that happens to have a same-named file
    // sitting in cwd used to get READ, HASHED, and TOFU-PINNED under that
    // bare, relative key in warn mode — a path the real exec never runs,
    // since the exec's OWN PATH lookup resolves independently. The binary
    // is still reported "Not found" (the exec fails regardless — a bare
    // name off PATH can't be spawned either way), but the ledger must never
    // have been touched.
    const bogusName = 'chroxy-8041-cwd-decoy-bin'
    const decoyPath = join(process.cwd(), bogusName)
    writeFileSync(decoyPath, 'not a real binary — a decoy for #8074 review C2')
    const ledger = fakeProvenanceLedger()
    try {
      const result = checkBinary(bogusName, ['--version'], {
        parseVersion: (out) => out.trim(),
        required: false,
        candidates: [],
        installHint: `install ${bogusName}`,
        provenance: { mode: 'warn', signatureGate: false, ledger },
      })
      assert.match(result.message, /^Not found — /, `expected a "Not found" message, got: ${result.status}: ${result.message}`)
      assert.equal(ledger._records.size, 0, 'the cwd decoy must never be pinned under the bare, relative name — this is the test that goes red under a mutant that hashes/pins a not-found path')
    } finally {
      rmSync(decoyPath, { force: true })
    }
  })

  it('a warn-mode advisory survives an earlier recommended-version warn row (#8074 round-2 review)', { skip: WINDOWS_SHIM_EXEC_SKIP }, () => {
    // The shim reports 9.9.9, below this recommendedVersion — so the
    // "older than the recommended" warn returns BEFORE the clean-row branch
    // that used to be the only place the advisory was attached.
    const shim = makeGateShim()
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    try {
      const result = checkBinary('chroxy-8041-fixture-bin', ['--version'], {
        parseVersion: (out) => out.trim(),
        required: true,
        candidates: [shim.shimPath],
        installHint: 'install chroxy-8041-fixture-bin',
        recommendedVersion: '10.0.0',
        provenance: { mode: 'warn', signatureGate: false, ledger },
      })
      assert.equal(result.status, 'warn', `expected warn, got ${result.status}: ${result.message}`)
      assert.ok(result.message.includes('older than the recommended'), `expected the recommended-version warn, got: ${result.message}`)
      assert.ok(/provenance hash_mismatch/.test(result.message), `the warn-mode provenance advisory must ride along on an earlier warn row, got: ${result.message}`)
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
      // #8074 review S1: warn mode must surface as a `warn` row (not a silent
      // `pass`) so `chroxy doctor`/`chroxy start` don't print a clean "[ OK ]"
      // for a binary a provenance check just flagged — but it is still
      // ALLOWED, so the version probe still runs for real.
      assert.equal(result.status, 'warn', `warn mode must report a warn row, not pass, got ${result.status}: ${result.message}`)
      assert.match(result.message, /hash_mismatch/, 'the warn row must carry the provenance status')
      assert.match(result.message, /9\.9\.9/, 'the row must still carry the real probed version, proving the exec ran')
      assert.equal(existsSync(shim.markerPath), true, 'warn mode surfaces the mismatch but still execs')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })
})

describe('checkClaudeTuiCliVersion — opt-in provenance gate (#8041)', () => {
  it('a block-mode ledger hash mismatch returns null — never execs, and reports no duplicate fail row', () => {
    const shim = makeGateShim()
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    try {
      const result = checkClaudeTuiCliVersion({
        resolveBinary: () => shim.shimPath,
        provenance: { mode: 'block', signatureGate: false, ledger },
      })
      // #8074 review S3: a blocked verdict returns `null`, not a second
      // `fail` row — the claude binary's own provider-preflight row (via
      // checkProvider → checkBinary against the SAME provenance options)
      // already reports this exact refusal; this function's own docblock
      // already promised "null when claude can't be run".
      assert.equal(result, null, `expected null (the provider row already reports this refusal), got ${JSON.stringify(result)}`)
      assert.equal(existsSync(shim.markerPath), false, 'the claude-tui version probe must never exec an unverified binary')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('a missing binary (health check fails) returns null when a gate is on — never calls verifyProvenance at all (#8074 review C2)', () => {
    // No shim at all — `resolveBinary` returns a path that doesn't exist.
    const missingPath = join(tmpDir('missing-claude'), 'does-not-exist-claude')
    let verifyProvenanceCalls = 0
    const result = checkClaudeTuiCliVersion({
      resolveBinary: () => missingPath,
      provenance: { mode: 'block', signatureGate: false, ledger: fakeProvenanceLedger() },
      verifyProvenance: () => { verifyProvenanceCalls++; return { ok: true, blocked: false, status: 'skipped' } },
    })
    assert.equal(result, null, `expected null for a not-found binary, got ${JSON.stringify(result)}`)
    assert.equal(verifyProvenanceCalls, 0, 'verifyProvenance must never run on a path the health check never confirmed — this is the test that goes red under a mutant that hashes a not-found path relative to cwd')
  })

  describe('warn-mode advisory on every row (#8074 review S1 + round-2 review)', () => {
    // Hermetic: resolution, health, provenance and exec are all injected, so
    // these run on every platform and never touch a real `claude`.
    const advisoryDeps = (execOutput) => ({
      resolveBinary: () => '/abs/fixture/claude',
      verify: () => ({ ok: true, path: '/abs/fixture/claude' }),
      provenance: { mode: 'warn', signatureGate: false, ledger: fakeProvenanceLedger() },
      verifyProvenance: () => ({ ok: false, blocked: false, status: 'hash_mismatch', message: 'fixture mismatch' }),
      exec: () => execOutput,
      tested: '2.1.100',
    })

    it('a version matching the tested baseline is a warn row carrying the advisory, never a clean pass', () => {
      const result = checkClaudeTuiCliVersion(advisoryDeps('2.1.100 (Claude Code)'))
      assert.equal(result.status, 'warn', `expected warn, got ${result.status}: ${result.message}`)
      assert.ok(/matches the tested TUI-driving baseline/.test(result.message), `got: ${result.message}`)
      assert.ok(/provenance hash_mismatch: fixture mismatch/.test(result.message), `got: ${result.message}`)
    })

    it('a baseline-drift warn still carries the advisory', () => {
      const result = checkClaudeTuiCliVersion(advisoryDeps('2.2.0 (Claude Code)'))
      assert.equal(result.status, 'warn')
      assert.ok(/differs from the tested TUI-driving baseline/.test(result.message), `got: ${result.message}`)
      assert.ok(/provenance hash_mismatch: fixture mismatch/.test(result.message), `got: ${result.message}`)
    })

    it('an unparseable-version warn still carries the advisory', () => {
      const result = checkClaudeTuiCliVersion(advisoryDeps('not a version'))
      assert.equal(result.status, 'warn')
      assert.ok(/Could not parse/.test(result.message), `got: ${result.message}`)
      assert.ok(/provenance hash_mismatch: fixture mismatch/.test(result.message), `got: ${result.message}`)
    })
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

  // #8041 review, corrected by #8074 review N4: `binaryProvenanceMode`/
  // `binarySignatureGate` are passed as PLAIN FUNCTION ARGUMENTS (a seam
  // `runDoctorChecks` added specifically for this suite) in most of the
  // tests below, rather than via a real config file or `process.env`
  // mutation — this is NOT because sibling `it()`s in one file run
  // concurrently (they don't; this runner's default is sequential), but
  // because the override lets each test set the gate's mode directly,
  // without needing a real config file on disk. It still exercises the
  // real `buildBinaryProvenanceOptions` normalization and the real
  // lazy-ledger construction path in `runDoctorChecks`; only the
  // mode/signatureGate RESOLUTION step itself is bypassed for those tests —
  // covered instead by the dedicated real-config-file test below (#8074
  // review C3(a), which catches mutant R1).
  it('block mode: the provider binary row fails with the provenance code, doctor as a whole fails, and the binary is never exec\'d', async () => {
    const shim = makeGateShim()
    const providerName = 'test-8041-provider-block'
    registerFixtureProvider(providerName, [shim.shimPath])
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    try {
      const { checks, passed } = await runDoctorChecksNoRealCloudflared({
        providers: [providerName],
        binaryProvenanceMode: 'block',
        binaryProvenanceLedger: ledger,
        verifyProvenance: CLASSIFY_NATIVE_VERIFY_PROVENANCE,
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
      // #8074 review C3(d): assert on the PROVIDER ROW only, never on the
      // top-level `passed` — `passed` folds in the cloudflared check too,
      // and a host with no cloudflared installed (every ubuntu-24.04 CI
      // runner) makes `passed` false regardless of anything this test is
      // actually about, which is exactly the assertion that made this test
      // depend on the host.
      const { checks } = await runDoctorChecksNoRealCloudflared({
        providers: [providerName],
        binaryProvenanceMode: 'block',
        binaryProvenanceLedger: ledger,
        verifyProvenance: CLASSIFY_NATIVE_VERIFY_PROVENANCE,
        detectStranded: CLEAN_STRANDED_STATE,
      })
      const row = binaryRow(checks, providerName)
      assert.ok(row)
      assert.equal(row.status, 'pass', `expected pass, got ${row.status}: ${row.message}`)
      assert.match(row.message, /9\.9\.9/, 'the printed version must come from the shim at the verified path, proving that exact path was probed')
      assert.equal(existsSync(shim.markerPath), true)
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
      // #8074 review C3(d): same reasoning as above — assert on the row, not
      // on host-dependent `passed`.
      const { checks } = await runDoctorChecksNoRealCloudflared({
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
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('block mode resolved from a REAL config.json, with no mode override — proves the config+env wiring, not just the gate logic (#8074 review C3(a))', async () => {
    // Unlike every OTHER test in this describe, this one passes NO
    // `binaryProvenanceMode` override — it writes a real config file to the
    // sandboxed `CHROXY_CONFIG_DIR` and lets `runDoctorChecks` resolve the
    // mode from it via the REAL `resolveBinaryProvenanceMode`, exactly as
    // `chroxy doctor` (and `chroxy start` with no `-c`) would. This is the
    // test that catches mutant R1 (production mode resolution forced to
    // `'off'`) — every other test in this file bypasses that resolution
    // step entirely via the override seam, so R1 was invisible to them.
    const shim = makeGateShim()
    const providerName = 'test-8041-provider-real-config'
    registerFixtureProvider(providerName, [shim.shimPath])
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    const cfgPath = configPath('config.json')
    const hadConfig = existsSync(cfgPath)
    const priorConfig = hadConfig ? readFileSync(cfgPath, 'utf-8') : null
    writeFileSync(cfgPath, JSON.stringify({ binaryProvenance: { mode: 'block' } }))
    try {
      const { checks } = await runDoctorChecksNoRealCloudflared({
        providers: [providerName],
        binaryProvenanceLedger: ledger,
        verifyProvenance: CLASSIFY_NATIVE_VERIFY_PROVENANCE,
        detectStranded: CLEAN_STRANDED_STATE,
      })
      const row = binaryRow(checks, providerName)
      assert.ok(row, 'the provider binary row must be present')
      assert.equal(row.status, 'fail', `expected fail (resolved from the real config file), got ${row.status}: ${row.message}`)
      assert.match(row.message, /hash_mismatch/)
      assert.equal(existsSync(shim.markerPath), false, 'the provider binary must never have been exec\'d')
    } finally {
      if (hadConfig) writeFileSync(cfgPath, priorConfig)
      else rmSync(cfgPath, { force: true })
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('gates off never constructs (or touches) the real binary-trust.json ledger', async () => {
    const providerName = 'test-8041-provider-no-ledger-touch'
    registerFixtureProvider(providerName, [])
    // No `binaryProvenanceLedger` override AND no mode override — exercises
    // the REAL config+env resolution (ambient CHROXY_BINARY_PROVENANCE is
    // cleared for this whole file by the outer before/after, and no test in
    // this file leaves a real config.json behind — see the config-file
    // save/restore in the test just above) and the REAL lazy-construct
    // branch. If gate resolution were wrong (e.g. defaulting to "on"), this
    // would create the real default-path ledger file. Checked via the
    // filesystem rather than a mocked console.warn/log, since a mock on the
    // shared `console` global would be a poor substitute for the dedicated
    // construction-spy test in `doctor-binary-provenance-ledger-construction.test.js`
    // (#8074 review N1) — this test only adds a filesystem-level check that
    // the REAL ledger class never writes.
    await runDoctorChecksNoRealCloudflared({ providers: [providerName] })
    assert.equal(
      existsSync(defaultBinaryTrustFile()),
      false,
      'gates off must never construct (or write) the real binary-trust.json — every OTHER test in this file that turns the gate on always supplies an explicit ledger override, so this file is the only writer and this check is race-free',
    )
  })
})

describe('runDoctorChecks — claude-tui version-probe provenance wiring (#8074 review C3(c))', () => {
  // `claudeTuiResolveBinary` (a #8074 test seam on `runDoctorChecks`) points
  // ONLY the claude-tui-driving probe's resolution at a fixture, so this test
  // is hermetic regardless of whether a real `claude` binary happens to
  // resolve on the machine running the suite — with no seam, a machine with
  // no claude-tui candidate installed would return `null` (not-found) under
  // BOTH the correctly-gated code AND mutant R2 (the probe called with
  // `provenance` dropped), making the two indistinguishable.
  //
  // `providers: ['claude-tui']` deliberately uses the REAL, already-registered
  // 'claude-tui' provider NAME rather than a fixture provider name —
  // `runDoctorChecks` only runs the driving-probe when the resolved provider
  // is literally named 'claude-tui'. That does NOT require keeping the REAL
  // `ClaudeTuiSession` CLASS registered under that name for these two tests,
  // though: `checkProvider('claude-tui', ...)` (a SEPARATE row, keyed by
  // 'claude' — unrelated to the 'claude-tui driving' row these tests assert
  // on) resolves `claude` via the real, fixed `CLAUDE_BINARY_CANDIDATES` list,
  // and on a host with `claude` installed at one of those (this repo's own
  // dev machines: `~/.local/bin/claude`), that row resolves — and, in the
  // gate-off test below, actually EXECS — the REAL claude binary (#8096).
  // Swap the registry entry for a harmless fixture provider (bogus binary
  // name, no candidates) for the DURATION of this describe only, restored
  // in `after()` — a plain map get/set on the SAME registry `getProvider`/
  // `registerProvider` already use elsewhere in this file, undone before any
  // other test in this file's process can observe it (this runner's `it()`s
  // run sequentially within a file — see the #8074 review N4 comment above).
  const REAL_CLAUDE_TUI_PROVIDER = getProvider('claude-tui')
  class FixtureClaudeTuiSession extends SdkSession {
    static get preflight() {
      return {
        label: 'Claude TUI (fixture, #8096)',
        binary: { name: 'chroxy-8096-fixture-claude-tui-bin', args: ['--version'], candidates: [] },
      }
    }
  }
  before(() => { registerProvider('claude-tui', FixtureClaudeTuiSession) })
  after(() => { registerProvider('claude-tui', REAL_CLAUDE_TUI_PROVIDER) })

  it('a stub that blocks every path means the claude-tui driving row never appears — proves the gate is wired, not just present', async () => {
    const shim = makeGateShim()
    try {
      const alwaysBlocked = () => ({ ok: false, blocked: true, status: 'hash_mismatch', message: 'stubbed refusal', remediation: null })
      const { checks } = await runDoctorChecksNoRealCloudflared({
        providers: ['claude-tui'],
        binaryProvenanceMode: 'block',
        binaryProvenanceLedger: fakeProvenanceLedger(),
        verifyProvenance: alwaysBlocked,
        claudeTuiResolveBinary: () => shim.shimPath,
        detectStranded: CLEAN_STRANDED_STATE,
      })
      assert.equal(
        checks.find((c) => c.name === 'claude-tui driving'),
        undefined,
        'a blocked verdict must return null from checkClaudeTuiCliVersion, so no row is pushed at all (#8074 review S3) — this is the test that goes red under mutant R2 (the probe called with provenance dropped), because R2 would exec the shim for real and produce a row',
      )
      assert.equal(existsSync(shim.markerPath), false, 'the shim must never have been exec\'d')
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('sanity check: with the gate off, the SAME shim DOES produce a claude-tui driving row — proves the test above is not vacuous', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
    const shim = makeGateShim()
    try {
      const { checks } = await runDoctorChecksNoRealCloudflared({
        providers: ['claude-tui'],
        binaryProvenanceMode: 'off',
        binarySignatureGate: false,
        claudeTuiResolveBinary: () => shim.shimPath,
        detectStranded: CLEAN_STRANDED_STATE,
      })
      const row = checks.find((c) => c.name === 'claude-tui driving')
      assert.ok(row, 'expected a claude-tui driving row when the gate is off and the probe execs the shim for real')
      assert.equal(existsSync(shim.markerPath), true)
    } finally {
      rmSync(shim.dir, { recursive: true, force: true })
    }
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
  // cloudflared on PATH. `PATH` is process-global, so — unlike the
  // `binaryProvenanceMode`/`cloudflaredCandidates` seams, which are plain
  // function arguments needing no shared mutable state at all — every
  // scenario that needs an empty PATH runs as a sequential step inside ONE
  // test, sharing ONE override installed and restored exactly once (simpler
  // than three separate save/restore dances, not a concurrency workaround —
  // #8074 review N4: this runner's default is sequential `it()`s per file).
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
