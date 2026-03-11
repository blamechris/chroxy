import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('Supervisor restart timer tracking (#1954)', () => {
  let src

  beforeEach(() => {
    src = readFileSync(join(__dirname, '../src/supervisor.js'), 'utf-8')
  })

  it('initializes _restartTimer in constructor', () => {
    assert.ok(src.includes('this._restartTimer = null'),
      'Constructor should initialize _restartTimer to null')
  })

  it('stores setTimeout return value in _restartTimer', () => {
    const matches = src.match(/this\._restartTimer\s*=\s*setTimeout/g)
    assert.ok(matches, 'Should assign setTimeout to _restartTimer')
    assert.ok(matches.length >= 2, 'Both restart paths should track the timer')
  })

  it('clears _restartTimer in shutdown', () => {
    const shutdownStart = src.indexOf('async shutdown(')
    const shutdownBody = src.slice(shutdownStart, src.indexOf('\n  }', shutdownStart + 50))
    assert.ok(shutdownBody.includes('clearTimeout(this._restartTimer)'),
      'shutdown should clear _restartTimer')
  })
})
