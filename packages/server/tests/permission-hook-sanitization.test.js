import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

describe('Permission hook environment sanitization (#1831)', () => {
  it('hook script validates PORT is numeric', () => {
    const source = readFileSync(hookPath, 'utf-8')
    assert.ok(
      source.includes("*[!0-9]*") && source.includes('exit 0'),
      'Hook should reject non-numeric PORT values'
    )
  })

  it('hook script validates PERM_MODE is a known value', () => {
    const source = readFileSync(hookPath, 'utf-8')
    assert.ok(
      source.includes('approve|auto|acceptEdits|plan'),
      'Hook should validate permission mode against known values'
    )
  })

  it('exits silently with non-numeric CHROXY_PORT', () => {
    const result = execSync(
      `CHROXY_PORT="evil" /bin/bash ${hookPath}`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    assert.equal(result.trim(), '', 'Should produce no output for injected PORT')
  })

  it('falls back to approve for unknown permission mode', () => {
    // With valid port but invalid mode, hook should treat as approve mode
    // and try to route to phone (which will fail since no server is running)
    const source = readFileSync(hookPath, 'utf-8')
    assert.ok(
      source.includes('*) PERM_MODE="approve"'),
      'Unknown modes should fall back to approve'
    )
  })
})

describe('Permission mode audit logging (#1831)', () => {
  it('ws-message-handlers logs previous mode on permission change', () => {
    const source = readFileSync(
      join(__dirname, '../src/ws-message-handlers.js'),
      'utf-8'
    )
    assert.ok(
      source.includes('previousMode') && source.includes('toISOString'),
      'Permission mode changes should log previous mode and timestamp'
    )
  })
})
