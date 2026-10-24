import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = resolve(fileURLToPath(import.meta.url), '../../report-coverage.mjs')
// These three reports were emitted by c8 11 from a one-file Node 22 test.
const nativeFixture = resolve(fileURLToPath(import.meta.url), '../fixtures/coverage-report')
const validSummary = JSON.parse(readFileSync(resolve(nativeFixture, 'coverage-summary.json'), 'utf8'))

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'chroxy-coverage-'))
  const directory = resolve(root, 'packages/server/coverage')
  mkdirSync(directory, { recursive: true })
  for (const filename of ['coverage-summary.json', 'lcov.info', 'index.html']) {
    copyFileSync(resolve(nativeFixture, filename), resolve(directory, filename))
  }
  return { root, directory }
}

function run(root) {
  return spawnSync(process.execPath, [script, 'server', '--root', root], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
  })
}

test('valid package report produces a named, source-wide row', () => {
  const { root } = fixture()
  try {
    const result = run(root)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes('| Server | 1 | 100.00% | 66.66% | 100.00% | 100.00% |'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const [name, mutate, message] of [
  ['absent JSON summary', (directory) => rmSync(resolve(directory, 'coverage-summary.json')), /missing expected report/],
  ['malformed JSON summary', (directory) => writeFileSync(resolve(directory, 'coverage-summary.json'), '{'), /malformed JSON/],
  ['zero source files', (directory) => writeFileSync(resolve(directory, 'coverage-summary.json'), JSON.stringify({ total: validSummary.total })), /zero instrumented source files/],
  ['malformed source entry', (directory) => writeFileSync(resolve(directory, 'coverage-summary.json'), JSON.stringify({ ...validSummary, [Object.keys(validSummary)[1]]: {} })), /invalid or zero lines for/],
  ['zero instrumented lines', (directory) => writeFileSync(resolve(directory, 'coverage-summary.json'), JSON.stringify({ ...validSummary, total: { ...validSummary.total, lines: { total: 0, covered: 0, pct: 100 } } })), /invalid or zero lines total/],
  ['absent LCOV', (directory) => rmSync(resolve(directory, 'lcov.info')), /missing expected report/],
  ['malformed LCOV', (directory) => writeFileSync(resolve(directory, 'lcov.info'), 'SF:src/example.mjs\nDA:1,1\n'), /malformed or empty LCOV/],
  ['empty HTML', (directory) => writeFileSync(resolve(directory, 'index.html'), ''), /empty expected report/],
]) {
  test(`${name} fails legibly`, () => {
    const { root, directory } = fixture()
    try {
      mutate(directory)
      const result = run(root)
      assert.equal(result.status, 1, `${name} unexpectedly passed: ${result.stdout}`)
      assert.ok(message.test(result.stderr), `${name} error was unclear: ${result.stderr}`)
      assert.equal(result.signal, null, `${name} timed out or was killed`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
