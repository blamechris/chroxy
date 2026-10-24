import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = resolve(fileURLToPath(import.meta.url), '../../report-coverage.mjs')
// These three reports were emitted by c8 11 from a one-file Node 22 test.
const nativeFixture = resolve(fileURLToPath(import.meta.url), '../fixtures/coverage-report')
const validSummary = JSON.parse(readFileSync(resolve(nativeFixture, 'coverage-summary.json'), 'utf8'))

function fixture(packageName = 'server') {
  const root = mkdtempSync(resolve(tmpdir(), 'chroxy-coverage-'))
  const directory = resolve(root, 'packages', packageName, 'coverage')
  mkdirSync(directory, { recursive: true })
  for (const filename of ['coverage-summary.json', 'lcov.info', 'index.html']) {
    copyFileSync(resolve(nativeFixture, filename), resolve(directory, filename))
  }
  // Keep the native c8 metrics and HTML shape, while proving that a report
  // generated in a different checkout can be validated after relocation.
  const extension = packageName === 'server' ? 'mjs' : 'ts'
  const source = `/runner/packages/${packageName}/src/example.${extension}`
  const originalSource = Object.keys(validSummary).find((key) => key !== 'total')
  writeFileSync(resolve(directory, 'coverage-summary.json'), JSON.stringify({
    total: validSummary.total,
    [source]: validSummary[originalSource],
  }))
  writeFileSync(resolve(directory, 'lcov.info'),
    readFileSync(resolve(directory, 'lcov.info'), 'utf8').replace('SF:src/example.mjs', `SF:src/example.${extension}`))
  return { root, directory }
}

function run(root, packageName = 'server', entry = script) {
  return spawnSync(process.execPath, [entry, packageName, '--root', root], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
  })
}

for (const [packageName, label] of [
  ['server', 'Server'], ['app', 'Mobile app'], ['dashboard', 'Dashboard'], ['store-core', 'Store core'],
]) {
  test(`valid ${packageName} report from a relocated checkout produces a named row`, () => {
    const { root } = fixture(packageName)
    try {
      const result = run(root, packageName)
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.includes(`| ${label} | 1 | 100.00% | 66.66% | 100.00% | 100.00% |`))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('symlinked invocation with no arguments runs main and fails with usage', () => {
  const { root } = fixture()
  try {
    const entry = resolve(root, 'coverage-cli.mjs')
    symlinkSync(script, entry)
    const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 5_000 })
    assert.equal(result.status, 1, `symlinked CLI skipped main: ${result.stdout}`)
    assert.ok(/usage: node scripts\/report-coverage/.test(result.stderr), result.stderr)
    assert.equal(result.signal, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('symlinked invocation with a valid report executes and prints the row', () => {
  const { root } = fixture()
  try {
    const entry = resolve(root, 'coverage-cli.mjs')
    symlinkSync(script, entry)
    const result = run(root, 'server', entry)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes('| Server | 1 |'))
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
  ['LCOV source outside JSON', (directory) => writeFileSync(resolve(directory, 'lcov.info'), readFileSync(resolve(directory, 'lcov.info'), 'utf8').replace('SF:src/example.mjs', 'SF:src/unrelated.mjs')), /LCOV source mismatch/],
  ['LCOV line counts disagree with JSON', (directory) => writeFileSync(resolve(directory, 'lcov.info'), readFileSync(resolve(directory, 'lcov.info'), 'utf8').replace('LF:1', 'LF:2')), /LCOV line counts mismatch/],
  ['empty HTML', (directory) => writeFileSync(resolve(directory, 'index.html'), ''), /empty expected report/],
  ['plain text HTML', (directory) => writeFileSync(resolve(directory, 'index.html'), 'broken report'), /malformed HTML report/],
  ['truncated HTML', (directory) => writeFileSync(resolve(directory, 'index.html'), '<html><body>'), /malformed HTML report/],
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

test('summary source from another package fails despite matching metrics', () => {
  const { root, directory } = fixture()
  try {
    const source = Object.keys(validSummary).find((key) => key !== 'total')
    writeFileSync(resolve(directory, 'coverage-summary.json'), JSON.stringify({
      total: validSummary.total,
      '/other/packages/app/src/example.mjs': validSummary[source],
    }))
    const result = run(root)
    assert.equal(result.status, 1, `wrong-package report passed: ${result.stdout}`)
    assert.ok(/unexpected source for server/.test(result.stderr), result.stderr)
    assert.equal(result.signal, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
