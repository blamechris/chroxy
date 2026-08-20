/**
 * Tests for scripts/lint-windows-test-exemptions.mjs (#7270).
 *
 * The Windows job used to run a hardcoded list of eight test files while
 * packages/server/tests/ grew to 553. The list is now INVERTED: every
 * *.test.js runs on Windows unless WINDOWS_EXEMPT classifies it out.
 *
 * That inversion cannot fail silently — an unclassified POSIX-only file makes
 * the Windows job red, naming itself. So this gate does not look for
 * "unclassified files"; there is no such state. It guards the one thing that
 * CAN rot: the exempt manifest becoming the new silent skip.
 *
 * Strategy, copied from lint-entry-point-guard.test.js: build a temp fixture
 * tree, run the gate as a CHILD PROCESS against it with --tests-root and
 * --manifest, and assert the EXIT CODE. Never the output — a grep over stdout
 * reports grep's status, not the gate's (docs/false-safety-guards.md).
 *
 * --tests-root/--manifest point the SAME derivation at a fixture rather than
 * adding a second code path, so what these tests exercise is what CI runs.
 *
 * EVERY case carries a POSITIVE CONTROL — the same fixture WITHOUT the
 * offending thing, proving the fixture would otherwise have passed and that the
 * assertion is what caught it. "This fails" passes just as happily against a
 * gate that rejects everything.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATE = resolve(__dirname, '..', 'scripts', 'lint-windows-test-exemptions.mjs')
const WRAPPER = resolve(__dirname, '..', 'scripts', 'lint-windows-test-exemptions.sh')
const LIB = resolve(__dirname, '..', 'scripts', 'lib', 'windows-test-set.mjs')

const tmpRoots = []
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

/**
 * Build a fixture package: <root>/tests/*.test.js plus a manifest module.
 * `files` are paths relative to the package root (e.g. 'tests/a.test.js').
 */
function fixture ({ files, manifest, mustRun = [], reasons = null, maxRatio = null }) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-win-exempt-'))
  tmpRoots.push(root)
  for (const f of files) {
    const abs = join(root, f)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, "import { test } from 'node:test'\ntest('x', () => {})\n")
  }
  const body = [
    reasons
      ? `export const EXEMPT_REASONS = ${JSON.stringify(reasons, null, 2)}`
      // pathToFileURL: a bare absolute path is not a valid ESM specifier on
      // Windows — 'A:\\...' is read as protocol 'a:' and the loader refuses it.
      // This fixture is itself in the derived Windows run set, so it has to be
      // portable; measured failing on the real host before this line existed.
      : `export { EXEMPT_REASONS } from ${JSON.stringify(pathToFileURL(LIB).href)}`,
    `export const WINDOWS_EXEMPT = ${JSON.stringify(manifest, null, 2)}`,
    `export const MUST_RUN_ON_WINDOWS = ${JSON.stringify(mustRun, null, 2)}`,
    maxRatio !== null ? `export const MAX_EXEMPT_RATIO = ${maxRatio}` : '',
  ].join('\n')
  const manifestPath = join(root, 'manifest.mjs')
  writeFileSync(manifestPath, body + '\n')
  return { root, testsRoot: join(root, 'tests'), manifestPath }
}

function runGate ({ testsRoot, manifestPath, extra = [] }) {
  const r = spawnSync(process.execPath, [
    GATE, '--tests-root', testsRoot, '--manifest', manifestPath, ...extra,
  ], { encoding: 'utf8' })
  return r
}

// A row that satisfies every per-row rule, so each test can break exactly one
// thing and attribute the failure to it.
const goodRow = (file) => ({
  file,
  reason: 'node-pty',
  symptom: 'fail',
  note: 'spawns a real PTY and asserts POSIX exit semantics',
})

const TEN = Array.from({ length: 10 }, (_, i) => `tests/f${i}.test.js`)

describe('lint-windows-test-exemptions: the manifest cannot rot silently (#7270)', () => {
  test('a clean manifest passes — the control for every case below', () => {
    const f = fixture({ files: TEN, manifest: [goodRow('tests/f0.test.js')] })
    const r = runGate(f)
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}\n${r.stderr}`)
  })

  test('an exempt row pointing at a missing file exits 2 (the gate is broken, not the code)', () => {
    const manifest = [goodRow('tests/gone.test.js')]
    const bad = fixture({ files: TEN, manifest })
    assert.equal(runGate(bad).status, 2)

    // POSITIVE CONTROL: same manifest, file present -> clean.
    const good = fixture({ files: [...TEN, 'tests/gone.test.js'], manifest })
    assert.equal(runGate(good).status, 0, 'control failed: the row is rejected for some OTHER reason')
  })

  test('an unknown reason category exits 1', () => {
    const bad = fixture({
      files: TEN,
      manifest: [{ ...goodRow('tests/f0.test.js'), reason: 'because-windows' }],
    })
    assert.equal(runGate(bad).status, 1)

    // POSITIVE CONTROL: identical row with a known category -> clean.
    const good = fixture({ files: TEN, manifest: [goodRow('tests/f0.test.js')] })
    assert.equal(runGate(good).status, 0, 'control failed')
  })

  test('a tracked-debt row without an issue exits 1', () => {
    const row = {
      file: 'tests/f0.test.js',
      reason: 'windows-defect',
      symptom: 'fail',
      note: 'a genuine cross-platform defect, not a POSIX dependency',
    }
    const bad = fixture({ files: TEN, manifest: [row] })
    assert.equal(runGate(bad).status, 1)

    // POSITIVE CONTROL: the SAME debt row with an issue number -> clean.
    const good = fixture({ files: TEN, manifest: [{ ...row, issue: 7999 }] })
    assert.equal(runGate(good).status, 0, 'control failed: the row is rejected for some OTHER reason')
  })

  test('a permanent row WITH an issue exits 1 (a permanent exemption has nothing to fix)', () => {
    const bad = fixture({
      files: TEN,
      manifest: [{ ...goodRow('tests/f0.test.js'), issue: 7999 }],
    })
    assert.equal(runGate(bad).status, 1)

    const good = fixture({ files: TEN, manifest: [goodRow('tests/f0.test.js')] })
    assert.equal(runGate(good).status, 0, 'control failed')
  })

  test('a missing or too-short note exits 1', () => {
    for (const note of [undefined, '', 'windows']) {
      const bad = fixture({
        files: TEN,
        manifest: [{ ...goodRow('tests/f0.test.js'), note }],
      })
      assert.equal(runGate(bad).status, 1, `note ${JSON.stringify(note)} should have been rejected`)
    }
    const good = fixture({ files: TEN, manifest: [goodRow('tests/f0.test.js')] })
    assert.equal(runGate(good).status, 0, 'control failed')
  })

  test('an unknown or missing symptom exits 1 — the symptom is a MEASURED observation', () => {
    for (const symptom of [undefined, 'probably-fails']) {
      const bad = fixture({
        files: TEN,
        manifest: [{ ...goodRow('tests/f0.test.js'), symptom }],
      })
      assert.equal(runGate(bad).status, 1, `symptom ${JSON.stringify(symptom)} should have been rejected`)
    }
    for (const symptom of ['fail', 'timeout', 'load-error']) {
      const good = fixture({
        files: TEN,
        manifest: [{ ...goodRow('tests/f0.test.js'), symptom }],
      })
      assert.equal(runGate(good).status, 0, `control failed for symptom ${symptom}`)
    }
  })

  test('a duplicate file row exits 1', () => {
    const bad = fixture({
      files: TEN,
      manifest: [goodRow('tests/f0.test.js'), goodRow('tests/f0.test.js')],
    })
    assert.equal(runGate(bad).status, 1)

    const good = fixture({
      files: TEN,
      manifest: [goodRow('tests/f0.test.js'), goodRow('tests/f1.test.js')],
    })
    assert.equal(runGate(good).status, 0, 'control failed')
  })

  test('exempting a MUST_RUN_ON_WINDOWS suite exits 1 — the mutation the roster exists to catch', () => {
    const bad = fixture({
      files: TEN,
      manifest: [goodRow('tests/f0.test.js')],
      mustRun: ['tests/f0.test.js'],
    })
    assert.equal(runGate(bad).status, 1)

    // POSITIVE CONTROL: the roster names a DIFFERENT file -> clean. Proves the
    // failure came from the overlap and not from having a roster at all.
    const good = fixture({
      files: TEN,
      manifest: [goodRow('tests/f0.test.js')],
      mustRun: ['tests/f1.test.js'],
    })
    assert.equal(runGate(good).status, 0, 'control failed')
  })

  test('a stale MUST_RUN_ON_WINDOWS entry exits 2', () => {
    const bad = fixture({
      files: TEN,
      manifest: [goodRow('tests/f0.test.js')],
      mustRun: ['tests/never-existed.test.js'],
    })
    assert.equal(runGate(bad).status, 2)

    const good = fixture({
      files: TEN,
      manifest: [goodRow('tests/f0.test.js')],
      mustRun: ['tests/f1.test.js'],
    })
    assert.equal(runGate(good).status, 0, 'control failed')
  })

  test('exempting more than MAX_EXEMPT_RATIO of the suite exits 1', () => {
    // 5 of 10 exempt against a 20% ceiling.
    const bad = fixture({
      files: TEN,
      manifest: TEN.slice(0, 5).map(goodRow),
      maxRatio: 0.2,
    })
    assert.equal(runGate(bad).status, 1)

    // POSITIVE CONTROL: the SAME five rows under a ceiling that admits them.
    const good = fixture({
      files: TEN,
      manifest: TEN.slice(0, 5).map(goodRow),
      maxRatio: 0.9,
    })
    assert.equal(runGate(good).status, 0, 'control failed: the rows are rejected for some OTHER reason')
  })

  test('a walk below --min-files exits 2 — "walked 3 clean files" must not read as "walked 553"', () => {
    const f = fixture({ files: TEN, manifest: [] })
    assert.equal(runGate({ ...f, extra: ['--min-files', '500'] }).status, 2)
    // POSITIVE CONTROL: the same tree under a floor it clears.
    assert.equal(runGate({ ...f, extra: ['--min-files', '10'] }).status, 0, 'control failed')
  })

  test('an empty tests tree exits 2 rather than reporting a clean set', () => {
    const f = fixture({ files: [], manifest: [] })
    mkdirSync(f.testsRoot, { recursive: true })
    assert.equal(runGate(f).status, 2)
  })

  test('a typo\'d flag exits 2 instead of silently walking the real tree', () => {
    const f = fixture({ files: TEN, manifest: [] })
    const r = spawnSync(process.execPath, [GATE, '--tests-rooot', f.testsRoot], { encoding: 'utf8' })
    assert.equal(r.status, 2)
  })

  test('an unloadable manifest exits 2, not 1 — "the gate broke" is not "the code is dirty"', () => {
    const f = fixture({ files: TEN, manifest: [] })
    writeFileSync(f.manifestPath, 'this is not valid javascript {{{\n')
    assert.equal(runGate(f).status, 2)
  })
})

describe('lint-windows-test-exemptions: the real manifest and the wrapper', () => {
  test('the repo\'s own manifest is clean', () => {
    const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8' })
    assert.equal(r.status, 0, `the real WINDOWS_EXEMPT manifest is not clean:\n${r.stderr}`)
  })

  test("the wrapper's --min-files floor is clearable by the real walk", () => {
    // Parsed out of the wrapper rather than hardcoded here: a second copy of
    // the number cannot notice when the wrapper's copy goes stale, and a
    // hardcoded copy was proven blind by mutation in lint-entry-point-guard.
    const wrapper = readFileSync(WRAPPER, 'utf8')
    const m = /--min-files\s+(\d+)/.exec(wrapper)
    assert.ok(m, 'could not find --min-files in the wrapper — this test is checking nothing')
    const floor = Number(m[1])
    const r = spawnSync(process.execPath, [GATE, '--min-files', String(floor)], { encoding: 'utf8' })
    assert.equal(r.status, 0, `the real tree does not clear the wrapper's floor of ${floor}:\n${r.stderr}`)
  })
})
