/**
 * #8061 — `chroxy resume` no longer execs a bare, unverified `claude`
 * from PATH. It now resolves AND verifies the binary through the same
 * `runProviderPreflight(CliSession, { provenance })` machinery
 * `SessionManager.verifyOneShotExecutable()` wraps (#8030/#8036), built from
 * config rather than a `SessionManager` instance (this CLI path has none).
 *
 * These tests exercise the REAL gate (`resolveVerifiedClaudeBinary` /
 * `runSessionResume`, `src/cli/session-cmd.js`) with a fixture provider class
 * and a fake ledger — same conventions (`fakeProvenanceLedger`,
 * `SPAWN_GATE_*_HASH`, `makeGateShim`) as `web-task-manager.test.js`'s own
 * #8039 suite and `session-manager-preflight.test.js` — rather than a
 * hand-rolled stand-in, so a regression in the shared gate machinery itself
 * would also be caught here.
 *
 * Never touches the real `~/.chroxy` / `~/.claude` — every fixture (session
 * state file, gate shim) lives under `os.tmpdir()`, and `readConfig` /
 * `ledger` are always injected fakes, never the real config.json / the real
 * `BinaryProvenanceLedger`.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveVerifiedClaudeBinary, runSessionResume } from '../../src/cli/session-cmd.js'

// ── shared tmp root ─────────────────────────────────────────────────────────

let _tmpRoot
function tmpDir(prefix) {
  if (!_tmpRoot) _tmpRoot = mkdtempSync(join(tmpdir(), 'session-resume-gate-'))
  const dir = mkdtempSync(join(_tmpRoot, `${prefix}-`))
  return dir
}
after(() => {
  if (_tmpRoot) rmSync(_tmpRoot, { recursive: true, force: true })
})

// #8065 review nitpick 1: isolate from an ambient CHROXY_BINARY_PROVENANCE /
// CHROXY_BINARY_SIGNATURE_GATE in the shell this suite happens to run under.
// Both env vars OUTRANK the injected `readConfig` fake inside
// `resolveVerifiedClaudeBinary` (the same precedence `chroxy start` uses —
// `resolveBinaryProvenanceMode`/`isBinarySignatureGateEnabled`), so a stray
// `CHROXY_BINARY_PROVENANCE=off` in the invoking shell would silently flip
// every "block mode" case below to pass for the wrong reason, and a stray
// `=block` would flip every "gates off" case to refuse unexpectedly. This
// matters whenever this suite runs inside a chroxy-spawned shell (e.g. a
// nested `chroxy resume` dev session) where these vars are commonly set.
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
// it — same convention as web-task-manager.test.js's #8039 suite.
const SPAWN_GATE_REAL_HASH = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
const SPAWN_GATE_WRONG_HASH = 'f'.repeat(64)

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

// A `CliSession`-shaped fixture whose "binary" is swappable per test, so
// preflight's existence/quarantine/hash checks run against a REAL file with
// no dependency on a `claude` CLI being installed on the test machine.
class FixtureClaudeProvider {
  static resolvedOverride = null
  static get resolvedBinary() { return FixtureClaudeProvider.resolvedOverride || process.execPath }
  static get displayLabel() { return 'Fixture Claude' }
  static get preflight() {
    return { label: 'Fixture Claude', binary: { name: 'claude', candidates: [] } }
  }
}

/**
 * A REAL, tiny executable script that writes a marker file the instant it
 * runs and exits 0 — same convention as web-task-manager.test.js /
 * session-manager-preflight.test.js's `makeGateShim()`. Used (rather than a
 * mocked `execFileSync`) so "the exec actually ran the VERIFIED path" is
 * proven by a real subprocess side effect, and so `runSessionResume`'s
 * literal `execFileSync(verifiedClaudePath, ...)` call site — deliberately
 * NOT hidden behind an injectable seam, so `scripts/lint-argv-sinks.mjs`
 * keeps tracing it — is exercised for real.
 */
function makeGateShim() {
  const dir = tmpDir('shim')
  const shimPath = join(dir, 'gate-shim.mjs')
  const markerPath = join(dir, 'marker.txt')
  const body = [
    '#!/usr/bin/env node',
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
    `console.log('shim-ok')`,
    'process.exit(0)',
  ].join('\n')
  writeFileSync(shimPath, body)
  chmodSync(shimPath, 0o755)
  return { dir, shimPath, markerPath }
}

/** A minimal session-state.json with one resumable session, at a tmp path. */
function makeStateFile(convId = 'conv-8061-test') {
  const dir = tmpDir('state')
  const stateFile = join(dir, 'session-state.json')
  writeFileSync(stateFile, JSON.stringify({
    sessions: [{ name: 'work', cwd: tmpdir(), conversationId: convId }],
    timestamp: Date.now(),
  }))
  return stateFile
}

// #8039-review precedent: a `.mjs` shebang shim is not directly executable
// via `execFile`/`execFileSync` on Windows (no shebang interpretation the way
// POSIX execve provides). Every case that instead proves a REFUSAL (a
// block-mode ledger mismatch, no spawn attempted) never reaches `execFileSync`
// at all, so those keep running unmodified on every platform, Windows
// included.
const WINDOWS_SHIM_EXEC_SKIP = process.platform === 'win32'
  ? 'a .mjs shebang shim is not directly executable via execFileSync on Windows; the refusal/no-spawn cases still run there'
  : false

describe('resolveVerifiedClaudeBinary (#8061)', () => {
  it('a block-mode ledger hash mismatch throws — refuses, never returns a path', () => {
    FixtureClaudeProvider.resolvedOverride = null // process.execPath
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    assert.throws(
      () => resolveVerifiedClaudeBinary({
        ProviderClass: FixtureClaudeProvider,
        ledger,
        readConfig: () => ({ binaryProvenance: { mode: 'block' } }),
      }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_BINARY_PROVENANCE')
        return true
      },
    )
  })

  it('a matching-hash ledger in block mode resolves the exact verified absolute path, not the bare string "claude"', () => {
    FixtureClaudeProvider.resolvedOverride = null // process.execPath
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_REAL_HASH } })
    const resolved = resolveVerifiedClaudeBinary({
      ProviderClass: FixtureClaudeProvider,
      ledger,
      readConfig: () => ({ binaryProvenance: { mode: 'block' } }),
    })
    assert.equal(resolved, process.execPath)
    assert.notEqual(resolved, 'claude')
  })

  it('gates off (no binaryProvenance config) resolves the healthy binary even against a ledger that would otherwise block', () => {
    FixtureClaudeProvider.resolvedOverride = null // process.execPath
    // Seeded with a MISMATCHING hash — if this were honored, block mode would
    // refuse. With the gate off, `buildBinaryProvenanceOptions` must return
    // `null` and `runProviderPreflight` must skip the provenance step
    // entirely, so this still resolves successfully.
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    const resolved = resolveVerifiedClaudeBinary({
      ProviderClass: FixtureClaudeProvider,
      ledger,
      readConfig: () => ({}),
    })
    assert.equal(resolved, process.execPath)
  })

  it('gates off + no ledger override never opens (or warns about) the real ledger file (#8065 review nitpick 3 — Copilot thread 1)', (t) => {
    FixtureClaudeProvider.resolvedOverride = null // process.execPath
    const warnMock = t.mock.method(console, 'warn')
    // No `ledger` key at all — the gate being off must short-circuit BEFORE
    // the lazy default (`new BinaryProvenanceLedger()`, the daemon's real
    // default-path trust file, itself sandboxed to a tmp CHROXY_CONFIG_DIR by
    // tests/_setup.mjs but still real disk I/O) ever runs.
    const resolved = resolveVerifiedClaudeBinary({
      ProviderClass: FixtureClaudeProvider,
      readConfig: () => ({}),
    })
    assert.equal(resolved, process.execPath)
    assert.equal(warnMock.mock.callCount(), 0, 'gates off must never open (or warn about) the ledger file — constructing it unconditionally is what produced the spurious warning Copilot flagged')
  })
})

describe('runSessionResume — the exec is gated (#8061)', () => {
  it('a block-mode ledger mismatch refuses: no claude spawn attempted, non-zero exit, and no "Resuming" banner (#8065 review nitpick 2)', async (t) => {
    const shim = makeGateShim()
    // Point the fixture at the shim so a mutant that swallows the refusal
    // and execs anyway would spawn THIS shim and flip the marker-absence
    // assertion below — resolving to `process.execPath` (the default) would
    // make that assertion meaningless (nothing there ever writes a marker).
    FixtureClaudeProvider.resolvedOverride = shim.shimPath
    const stateFile = makeStateFile()
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    const savedExitCode = process.exitCode
    process.exitCode = 0
    // #8065 review nitpick 2: the title claimed 'no "Resuming" banner' but
    // nothing asserted it — mutant R6 (the banner moved above the gate)
    // survived. Mock console.log/console.error (default implementation still
    // calls through, so output isn't lost) and check the actual calls.
    const logMock = t.mock.method(console, 'log')
    const errorMock = t.mock.method(console, 'error')
    try {
      await runSessionResume('1', {}, {
        stateFile,
        resolveBinary: () => resolveVerifiedClaudeBinary({
          ProviderClass: FixtureClaudeProvider,
          ledger,
          readConfig: () => ({ binaryProvenance: { mode: 'block' } }),
        }),
      })
      assert.equal(process.exitCode, 1, 'a gate refusal must set a non-zero exit code')
      assert.equal(existsSync(shim.markerPath), false, 'the shim must never have been spawned — this is the test that goes red under a mutant that swallows the refusal and execs anyway')
      const errorMessages = errorMock.mock.calls.map(c => String(c.arguments[0]))
      assert.ok(
        errorMessages.some(msg => /Refusing to resume:.*hash changed/.test(msg)),
        `expected a "Refusing to resume: ... hash changed" console.error call, got: ${JSON.stringify(errorMessages)}`,
      )
      const logMessages = logMock.mock.calls.map(c => String(c.arguments[0]))
      assert.ok(
        !logMessages.some(msg => /Resuming/.test(msg)),
        `no "Resuming" banner may print before a refusal — this is the test that goes red under mutant R6 (banner moved above the gate); got console.log calls: ${JSON.stringify(logMessages)}`,
      )
    } finally {
      process.exitCode = savedExitCode
      FixtureClaudeProvider.resolvedOverride = null
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('a matching-hash ledger execs the exact verified absolute path (never the bare string "claude")', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
    const shim = makeGateShim()
    FixtureClaudeProvider.resolvedOverride = shim.shimPath
    const stateFile = makeStateFile()
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: hashFile(shim.shimPath) } })
    let capturedPath = null
    try {
      await runSessionResume('1', {}, {
        stateFile,
        resolveBinary: () => {
          capturedPath = resolveVerifiedClaudeBinary({
            ProviderClass: FixtureClaudeProvider,
            ledger,
            readConfig: () => ({ binaryProvenance: { mode: 'block' } }),
          })
          return capturedPath
        },
      })
      assert.equal(capturedPath, shim.shimPath, 'the gate must resolve the exact shim path, not a bare "claude"')
      assert.notEqual(capturedPath, 'claude')
      assert.equal(existsSync(shim.markerPath), true, 'execFileSync must have spawned the verified path for real (execFileSync is synchronous, so the marker exists by the time this returns)')
    } finally {
      FixtureClaudeProvider.resolvedOverride = null
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })

  it('with gates off, a healthy binary still resolves and spawns — the observable outcome matches pre-#8061, even though an existence/quarantine check now runs first (#8065 review nitpick 5)', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
    const shim = makeGateShim()
    FixtureClaudeProvider.resolvedOverride = shim.shimPath
    const stateFile = makeStateFile()
    // A WRONG hash — ignored entirely because mode is 'off'.
    const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    try {
      await runSessionResume('1', {}, {
        stateFile,
        resolveBinary: () => resolveVerifiedClaudeBinary({
          ProviderClass: FixtureClaudeProvider,
          ledger,
          readConfig: () => ({}),
        }),
      })
      // #8065 review nitpick 5: this is NOT literally "unchanged" — with
      // gates off, resume now still runs `runProviderPreflight`'s
      // existence/quarantine check (only the provenance step is skipped), so
      // a MISSING or quarantined binary now refuses with a labeled error
      // instead of throwing a raw ENOENT/EPERM. For a HEALTHY binary (this
      // case) the observable result is the same as pre-#8061: it spawns.
      assert.equal(existsSync(shim.markerPath), true, 'gates off: a healthy binary must still spawn — the same observable outcome as before #8061')
    } finally {
      FixtureClaudeProvider.resolvedOverride = null
      rmSync(shim.dir, { recursive: true, force: true })
    }
  })
})
