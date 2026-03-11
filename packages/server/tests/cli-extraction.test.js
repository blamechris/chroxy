import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

describe('CLI command extraction (#1842)', () => {
  it('cli.js is under 150 lines', () => {
    const source = readFileSync(join(srcDir, 'cli.js'), 'utf-8')
    const lines = source.split('\n').length
    assert.ok(lines < 150, `cli.js has ${lines} lines, expected < 150`)
  })

  it('shared options module exports addServerOptions and loadAndMergeConfig', () => {
    const source = readFileSync(join(srcDir, 'cli/shared.js'), 'utf-8')
    assert.ok(source.includes('export function addServerOptions'), 'should export addServerOptions')
    assert.ok(source.includes('export function loadAndMergeConfig'), 'should export loadAndMergeConfig')
  })

  it('shared options are defined once via addServerOptions', () => {
    const source = readFileSync(join(srcDir, 'cli/shared.js'), 'utf-8')
    assert.ok(source.includes('--config'), 'shared options should include --config')
    assert.ok(source.includes('--model'), 'shared options should include --model')
    assert.ok(source.includes('--tunnel'), 'shared options should include --tunnel')
    assert.ok(source.includes('--provider'), 'shared options should include --provider')
  })

  it('command modules export register functions', () => {
    const modules = [
      'cli/init-cmd.js',
      'cli/server-cmd.js',
      'cli/config-cmd.js',
      'cli/tunnel-cmd.js',
      'cli/doctor-cmd.js',
      'cli/deploy-cmd.js',
      'cli/session-cmd.js',
      'cli/service-cmd.js',
      'cli/update-cmd.js',
    ]

    for (const mod of modules) {
      const source = readFileSync(join(srcDir, mod), 'utf-8')
      assert.ok(
        source.includes('export function register'),
        `${mod} should export a register function`
      )
    }
  })

  it('start and dev commands use addServerOptions from shared', () => {
    const source = readFileSync(join(srcDir, 'cli/server-cmd.js'), 'utf-8')
    assert.ok(source.includes('addServerOptions'), 'server-cmd should use addServerOptions')
  })

  it('cli.js imports and registers all command modules', () => {
    const source = readFileSync(join(srcDir, 'cli.js'), 'utf-8')
    const modules = [
      'init-cmd', 'server-cmd', 'config-cmd', 'tunnel-cmd',
      'doctor-cmd', 'deploy-cmd', 'session-cmd', 'service-cmd', 'update-cmd',
    ]
    for (const mod of modules) {
      assert.ok(
        source.includes(mod),
        `cli.js should import ${mod}`
      )
    }
  })
})
