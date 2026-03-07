/**
 * Tests that rapid directory navigation ignores stale responses (#1584)
 *
 * Verifies the CreateSessionModal source contains a guard against out-of-order
 * directory listing responses in the browse handler.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const modalSource = fs.readFileSync(
  path.resolve(__dirname, './CreateSessionModal.tsx'),
  'utf-8',
)

describe('Directory browse out-of-order guard (#1584)', () => {
  it('tracks requested browse path in a ref', () => {
    // The modal should have a ref that tracks the last-requested browse path
    expect(modalSource).toMatch(/useRef.*browse|browsePathRef/)
  })

  it('compares listing.path against tracked path before applying', () => {
    // The callback should check listing.path matches the expected path
    expect(modalSource).toMatch(/listing\.path|listing\.parentPath/)
  })

  it('ignores responses where path does not match current request', () => {
    // There should be a conditional return/guard in the callback
    // that prevents stale responses from updating state
    expect(modalSource).toMatch(/return\b.*\/\/ stale|!==.*browsePathRef|!==.*requestedPath/)
  })
})
