import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('_pushHistory simplification (#1990)', () => {
  let src

  beforeEach(() => {
    // _pushHistory now lives in session-message-history.js (extracted from session-manager.js)
    src = readFileSync(join(__dirname, '../src/session-message-history.js'), 'utf-8')
  })

  it('uses single shift instead of while loop', () => {
    const methodStart = src.indexOf('_pushHistory(history, entry, sessionId)')
    const methodEnd = src.indexOf('\n  }', methodStart + 10)
    const methodBody = src.slice(methodStart, methodEnd)

    assert.ok(!methodBody.includes('while'), '_pushHistory should not use while loop')
    assert.ok(methodBody.includes('history.shift()'), 'Should use single history.shift()')
    assert.ok(methodBody.includes('history.push(entry)'), 'Should still push entry')
  })
})
