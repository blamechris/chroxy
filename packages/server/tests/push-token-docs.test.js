import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('push token documentation (#1986)', () => {
  it('ws-server.js protocol comment does not say "Expo push token"', () => {
    const src = readFileSync(join(__dirname, '../src/ws-server.js'), 'utf-8')
    const idx = src.indexOf('register_push_token')
    assert.ok(idx !== -1, 'register_push_token should exist in ws-server.js')
    const protocolSection = src.slice(idx, idx + 200)
    assert.ok(!protocolSection.includes('Expo push token'),
      'Should say "push token" not "Expo push token"')
    assert.ok(protocolSection.includes('register push token'),
      'Should describe as "register push token"')
  })

  it('reference.md protocol table does not say "Expo push token"', () => {
    const src = readFileSync(join(__dirname, '../../../docs/architecture/reference.md'), 'utf-8')
    const idx = src.indexOf('register_push_token')
    assert.ok(idx !== -1, 'register_push_token should exist in reference.md')
    const row = src.slice(idx, idx + 200)
    assert.ok(!row.includes('Expo push token'),
      'reference.md should say "push token" not "Expo push token"')
  })
})
