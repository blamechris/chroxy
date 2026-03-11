import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('session-manager JSDoc completeness (#1989)', () => {
  const src = readFileSync(join(__dirname, '../src/session-manager.js'), 'utf-8')

  it('_pushHistory has @param for sessionId', () => {
    const methodIndex = src.indexOf('_pushHistory(history, entry, sessionId)')
    assert.ok(methodIndex > 0, '_pushHistory method should exist')

    // Find the JSDoc comment above the method
    const before = src.slice(Math.max(0, methodIndex - 300), methodIndex)
    assert.ok(before.includes('@param') && before.includes('sessionId'),
      '_pushHistory JSDoc should have @param for sessionId')
  })
})
