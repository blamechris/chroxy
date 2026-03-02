/**
 * Contract test: assert server and dashboard image validation constants stay in sync.
 * If either side changes limits, this test catches the drift.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_ATTACHMENT_COUNT, MAX_IMAGE_SIZE, ALLOWED_IMAGE_TYPES } from '../src/ws-message-handlers.js'

// Read dashboard TypeScript source and extract constants via regex
const dashboardSrc = readFileSync(
  join(import.meta.dirname, '../src/dashboard-next/src/utils/image-utils.ts'),
  'utf-8'
)

function extractConstant(src, name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(.+)`)
  const match = src.match(re)
  if (!match) throw new Error(`Could not find ${name} in dashboard source`)
  return match[1].trim()
}

function extractArrayItems(src, name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]+)\\]`, 's')
  const match = src.match(re)
  if (!match) throw new Error(`Could not find ${name} in dashboard source`)
  return match[1]
    .split(',')
    .map(s => s.trim().replace(/['"]/g, ''))
    .filter(Boolean)
}

describe('image validation constants contract', () => {
  it('MAX_IMAGE_SIZE matches between server and dashboard', () => {
    const dashValue = extractConstant(dashboardSrc, 'MAX_IMAGE_SIZE')
    // Both should evaluate to 2 * 1024 * 1024
    assert.strictEqual(MAX_IMAGE_SIZE, 2 * 1024 * 1024, 'server MAX_IMAGE_SIZE should be 2MB')
    assert.ok(dashValue.includes('2 * 1024 * 1024'), `dashboard MAX_IMAGE_SIZE should be 2MB, got: ${dashValue}`)
  })

  it('MAX_IMAGE_COUNT / MAX_ATTACHMENT_COUNT match', () => {
    const dashValue = extractConstant(dashboardSrc, 'MAX_IMAGE_COUNT')
    // Server uses MAX_ATTACHMENT_COUNT, dashboard uses MAX_IMAGE_COUNT — both should be 5
    assert.strictEqual(MAX_ATTACHMENT_COUNT, 5, 'server MAX_ATTACHMENT_COUNT should be 5')
    assert.ok(dashValue.includes('5'), `dashboard MAX_IMAGE_COUNT should be 5, got: ${dashValue}`)
  })

  it('ALLOWED_IMAGE_TYPES match between server and dashboard', () => {
    const dashTypes = extractArrayItems(dashboardSrc, 'ALLOWED_IMAGE_TYPES')
    const serverTypes = [...ALLOWED_IMAGE_TYPES].sort()
    const sortedDash = [...dashTypes].sort()

    assert.deepStrictEqual(sortedDash, serverTypes,
      `Dashboard types ${JSON.stringify(sortedDash)} should match server types ${JSON.stringify(serverTypes)}`)
  })
})
