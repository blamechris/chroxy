/**
 * Regression test for #7271: tests/_setup.mjs creates a per-process
 * CHROXY_CONFIG_DIR temp dir via mkdtempSync but never removed it — every
 * `node --test` process (one per test file, per the doc comment atop
 * _setup.mjs) leaked one `chroxy-test-cfg-*` dir in $TMPDIR.
 *
 * This test spawns a real child process that imports the actual
 * tests/_setup.mjs (exactly as `--import ./tests/_setup.mjs` does in
 * package.json's test script), has it report the dir it created and whether
 * that dir existed WHILE the process was alive (the control — otherwise
 * "gone after exit" would trivially pass if the dir were never created), then
 * asserts the dir is gone once the child process has exited.
 *
 * A second case proves the cleanup handler is scoped correctly: a
 * developer-supplied CHROXY_CONFIG_DIR (the existing
 * `if (!process.env.CHROXY_CONFIG_DIR)` branch in _setup.mjs) must never be
 * removed by the exit handler.
 *
 * A third case pins the specific design choice #7271's fix made over the
 * issue's own suggested-fix shape (see the PR description): the exit handler
 * closes over the `ownedConfigTmpDir` local captured at creation time, rather
 * than re-reading `process.env.CHROXY_CONFIG_DIR` when the handler fires. A
 * test that overrides `CHROXY_CONFIG_DIR` mid-run and exits without restoring
 * it (the documented escape hatch — "Tests that explicitly need to override
 * it ... can still set it in their own beforeEach and restore in afterEach" —
 * assumes the restore happens, but an early return, a thrown assertion, or a
 * forgotten afterEach means it sometimes doesn't) must not change what gets
 * removed: the ORIGINALLY-owned dir, never whatever path the env var happens
 * to hold when the process exits. Reading env-at-exit instead of the closure
 * variable passes every other case in this file unchanged — it only differs
 * on this one, which is why it needs its own case.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SETUP_PATH = resolve(__dirname, '_setup.mjs')
// `--import` takes a module SPECIFIER: on Windows an absolute path like
// A:\...\_setup.mjs is rejected by the ESM loader (ERR_UNSUPPORTED_ESM_URL_SCHEME),
// so pass it as a file:// URL, which is valid on every platform.
const SETUP_URL = pathToFileURL(SETUP_PATH).href

const PROBE_SCRIPT = `
import { existsSync } from 'node:fs'
const dir = process.env.CHROXY_CONFIG_DIR
console.log(JSON.stringify({ dir, existedDuringRun: !!dir && existsSync(dir) }))
`

// Simulates a test that overrides CHROXY_CONFIG_DIR (the documented escape
// hatch in _setup.mjs) and exits without restoring it. The dir _setup.mjs
// itself created is reported BEFORE the override so the test can check the
// right path was removed, not whatever CHROXY_CONFIG_DIR ends up holding.
const MUTATING_PROBE_SCRIPT = `
const ownedDir = process.env.CHROXY_CONFIG_DIR
process.env.CHROXY_CONFIG_DIR = '/nonexistent/must-not-be-touched'
console.log(JSON.stringify({ ownedDir }))
`

function runProbeChild(env, script = PROBE_SCRIPT) {
  const harnessDir = mkdtempSync(join(tmpdir(), 'chroxy-test-cfg-cleanup-harness-'))
  const scriptPath = join(harnessDir, 'probe.mjs')
  writeFileSync(scriptPath, script)
  try {
    const result = spawnSync(process.execPath, ['--import', SETUP_URL, scriptPath], {
      encoding: 'utf-8',
      timeout: 15_000,
      env,
    })
    return result
  } finally {
    rmSync(harnessDir, { recursive: true, force: true })
  }
}

describe('tests/_setup.mjs CHROXY_CONFIG_DIR cleanup (#7271)', () => {
  it('removes the tmp config dir it created once the process exits', () => {
    const envWithoutConfigDir = { ...process.env }
    delete envWithoutConfigDir.CHROXY_CONFIG_DIR
    const result = runProbeChild(envWithoutConfigDir)

    assert.equal(result.status, 0, `probe child should exit cleanly (code ${result.status}); stderr: ${result.stderr}`)

    const lastLine = result.stdout.trim().split('\n').filter(Boolean).pop()
    assert.ok(lastLine, `expected JSON output from probe child; got stdout: ${JSON.stringify(result.stdout)}`)
    const { dir, existedDuringRun } = JSON.parse(lastLine)

    assert.ok(
      typeof dir === 'string' && dir.includes('chroxy-test-cfg-'),
      `probe child should have created a chroxy-test-cfg- dir, got: ${dir}`
    )
    // Control: prove the dir actually existed while the process was alive —
    // otherwise a no-op cleanup path would make the final assertion below
    // pass for the wrong reason (the dir simply never having been created).
    assert.equal(existedDuringRun, true, 'the tmp config dir must exist while the child process is running')

    assert.equal(existsSync(dir), false, 'the tmp config dir must be removed once the child process exits')
  })

  it('never removes a developer-supplied CHROXY_CONFIG_DIR', () => {
    const developerDir = mkdtempSync(join(tmpdir(), 'chroxy-developer-supplied-cfg-'))
    try {
      const result = runProbeChild({ ...process.env, CHROXY_CONFIG_DIR: developerDir })

      assert.equal(result.status, 0, `probe child should exit cleanly (code ${result.status}); stderr: ${result.stderr}`)

      const lastLine = result.stdout.trim().split('\n').filter(Boolean).pop()
      const { dir } = JSON.parse(lastLine)
      assert.equal(dir, developerDir, 'the child should have used the developer-supplied CHROXY_CONFIG_DIR verbatim')

      assert.equal(existsSync(developerDir), true, 'a developer-supplied CHROXY_CONFIG_DIR must survive child process exit')
    } finally {
      rmSync(developerDir, { recursive: true, force: true })
    }
  })

  it('removes the dir it owns even when CHROXY_CONFIG_DIR is left mutated at exit', () => {
    const envWithoutConfigDir = { ...process.env }
    delete envWithoutConfigDir.CHROXY_CONFIG_DIR
    const result = runProbeChild(envWithoutConfigDir, MUTATING_PROBE_SCRIPT)

    assert.equal(result.status, 0, `probe child should exit cleanly (code ${result.status}); stderr: ${result.stderr}`)

    const lastLine = result.stdout.trim().split('\n').filter(Boolean).pop()
    assert.ok(lastLine, `expected JSON output from probe child; got stdout: ${JSON.stringify(result.stdout)}`)
    const { ownedDir } = JSON.parse(lastLine)

    assert.ok(
      typeof ownedDir === 'string' && ownedDir.includes('chroxy-test-cfg-'),
      `probe child should have created a chroxy-test-cfg- dir, got: ${ownedDir}`
    )

    // The probe script reassigned process.env.CHROXY_CONFIG_DIR to a bogus
    // path right before exiting, without restoring it. If the exit handler
    // read process.env.CHROXY_CONFIG_DIR at exit time instead of the closed-
    // over ownedConfigTmpDir, it would attempt to rmSync the bogus path
    // (silently caught) and leave the real owned dir behind.
    assert.equal(
      existsSync(ownedDir),
      false,
      'the dir _setup.mjs created must still be removed, even though CHROXY_CONFIG_DIR was mutated before exit'
    )
  })
})
