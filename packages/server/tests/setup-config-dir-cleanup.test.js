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
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SETUP_PATH = resolve(__dirname, '_setup.mjs')

const PROBE_SCRIPT = `
import { existsSync } from 'node:fs'
const dir = process.env.CHROXY_CONFIG_DIR
console.log(JSON.stringify({ dir, existedDuringRun: !!dir && existsSync(dir) }))
`

function runProbeChild(env) {
  const harnessDir = mkdtempSync(join(tmpdir(), 'chroxy-test-cfg-cleanup-harness-'))
  const scriptPath = join(harnessDir, 'probe.mjs')
  writeFileSync(scriptPath, PROBE_SCRIPT)
  try {
    const result = spawnSync(process.execPath, ['--import', SETUP_PATH, scriptPath], {
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
})
