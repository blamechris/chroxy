/**
 * Tests for scripts/run-windows-tests.mjs's DERIVATION (#7270).
 *
 * Runs on every platform via `--print-plan`, which resolves the set and batches
 * it without executing a single test — so the Linux `Server Tests` job (a
 * REQUIRED check) covers the runner's logic even though the runner itself only
 * ever executes on Windows.
 *
 * The batching path is the reason this file exists. Today's 482-file run set
 * fits in ONE batch, so the multi-batch code never runs in CI — untested code
 * on a path that only activates once the suite grows, which is this issue's own
 * defect class one level down. `--max-argv-bytes` forces it here.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNNER = resolve(__dirname, '..', 'scripts', 'run-windows-tests.mjs')

function plan(extra = []) {
  const r = spawnSync(process.execPath, [RUNNER, '--print-plan', ...extra], { encoding: 'utf8' })
  return { status: r.status, json: r.status === 0 ? JSON.parse(r.stdout) : null, stderr: r.stderr }
}

describe('run-windows-tests: the derived plan (#7270)', () => {
  test('the run set is every test file minus the exempt manifest', () => {
    const { status, json, stderr } = plan()
    assert.equal(status, 0, `--print-plan failed:\n${stderr}`)
    assert.equal(json.run, json.all - json.exempt)
    assert.ok(json.run > 0, 'an empty run set must never be reported as a plan')
    assert.ok(json.all > json.exempt, 'the manifest cannot exempt the entire suite')
  })

  test('batching partitions the run set without losing or duplicating a file', () => {
    // Small enough to force many batches out of today's one.
    const { status, json, stderr } = plan(['--max-argv-bytes', '400'])
    assert.equal(status, 0, `--print-plan failed:\n${stderr}`)
    assert.ok(json.batches.length > 1, 'the tiny budget did not actually force multiple batches — this test is checking nothing')
    assert.ok(json.batches.every((n) => n > 0), 'an empty batch would spawn a runner with no files, which globs the cwd')

    // Compare the FILES, not the counts. A partition that drops one file and
    // duplicates another sums correctly and is still wrong.
    const flat = json.batchFiles.flat()
    assert.equal(flat.length, json.run, 'batching lost or duplicated files')
    assert.equal(new Set(flat).size, json.run, 'a file appears in more than one batch')

    // …and the partition must be of the SAME set the single-batch plan derives.
    const whole = plan().json.batchFiles.flat()
    assert.deepEqual([...flat].sort(), [...whole].sort(), 'the batched partition is not the derived run set')
  })

  test('the runner carries its own collapse floor, since the .sh wrapper cannot run on Windows', () => {
    // The Linux gate gets its floor from the wrapper. The Windows job invokes
    // the runner directly, so "walked 3 files, all clean" must not read the
    // same as "walked 480".
    assert.equal(plan(['--min-files', '99999']).status, 2)
    // POSITIVE CONTROL: a floor the real tree clears.
    assert.equal(plan(['--min-files', '1']).status, 0, 'control failed')
  })

  test('a value-taking flag with no value exits 2 instead of silently using the default', () => {
    for (const argv of [['--tests-root'], ['--max-argv-bytes'], ['--test-concurrency'], ['--min-files']]) {
      const r = spawnSync(process.execPath, [RUNNER, '--print-plan', ...argv], { encoding: 'utf8' })
      assert.equal(r.status, 2, `argv ${JSON.stringify(argv)} must fail closed`)
    }
    // A following FLAG is not a value either.
    const r = spawnSync(process.execPath, [RUNNER, '--tests-root', '--min-files', '1'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
  })

  test('the default budget keeps every batch under the Windows command-line cap', () => {
    const { json } = plan()
    // CreateProcessW's limit is 32,767; the default budget is well under it and
    // this asserts the relationship rather than restating the number.
    assert.ok(json.maxArgvBytes < 32767, 'the argv budget must sit below the Windows cap')
    assert.ok(json.batches.length >= 1)
  })

  test('an unusable argv budget exits 2 rather than silently batching badly', () => {
    assert.equal(plan(['--max-argv-bytes', '10']).status, 2)
    assert.equal(plan(['--max-argv-bytes', 'banana']).status, 2)
    // POSITIVE CONTROL: a sane budget still works, so the rejection above came
    // from the value and not from the flag being unsupported.
    assert.equal(plan(['--max-argv-bytes', '24000']).status, 0)
  })

  test('a typo\'d flag exits 2 instead of running an unintended set', () => {
    assert.equal(plan(['--max-argv-bytez', '24000']).status, 2)
  })
})
