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
    const protocolSection = src.slice(
      src.indexOf('register_push_token'),
      src.indexOf('register_push_token') + 200
    )
    assert.ok(!protocolSection.includes('Expo push token'),
      'Should say "push token" not "Expo push token"')
    assert.ok(protocolSection.includes('register push token'),
      'Should describe as "register push token"')
  })
})
