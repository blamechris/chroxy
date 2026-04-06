import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const versionCheckPath = join(__dirname, '../src/version-check.js')
const cliPath = join(__dirname, '../src/cli.js')

describe('Node version check (#2695)', () => {
  it('version-check.js exists and contains the version gate', () => {
    const src = readFileSync(versionCheckPath, 'utf-8')
    assert.ok(src.includes('nodeMajor < 22'), 'should gate on major version 22')
    assert.ok(src.includes('process.exit(1)'), 'should call process.exit(1)')
    assert.ok(src.includes('Node.js 22'), 'should mention Node.js 22 in the error message')
  })

  it('cli.js imports version-check.js as its first side-effect import', () => {
    const src = readFileSync(cliPath, 'utf-8')
    // version-check must appear before any other import
    const versionCheckIdx = src.indexOf("'./version-check.js'")
    const commanderIdx = src.indexOf("'commander'")
    assert.ok(versionCheckIdx !== -1, 'cli.js should import version-check.js')
    assert.ok(commanderIdx !== -1, 'cli.js should import commander')
    assert.ok(
      versionCheckIdx < commanderIdx,
      'version-check.js should be imported before commander'
    )
  })

  it('exits with code 1 and prints a clear message when Node version is too old', () => {
    // We inject a fake version by monkey-patching process.versions via a wrapper script
    // that replaces the node value before loading version-check.js.
    const script = `
      Object.defineProperty(process.versions, 'node', { value: '18.12.0', writable: false, configurable: true })
      await import(${JSON.stringify(versionCheckPath)})
    `
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: script,
      encoding: 'utf-8',
      timeout: 5000,
    })
    assert.strictEqual(result.status, 1, 'should exit with code 1')
    assert.ok(result.stderr.includes('Node.js 22'), 'stderr should mention Node.js 22')
    assert.ok(result.stderr.includes('18.12.0'), 'stderr should include the running version')
  })

  it('does not exit when Node version is 22 or later', () => {
    const script = `
      Object.defineProperty(process.versions, 'node', { value: '22.0.0', writable: false, configurable: true })
      await import(${JSON.stringify(versionCheckPath)})
      process.stdout.write('ok')
    `
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: script,
      encoding: 'utf-8',
      timeout: 5000,
    })
    assert.strictEqual(result.status, 0, 'should exit with code 0')
    assert.ok(result.stdout.includes('ok'), 'should complete without exiting early')
  })
})
