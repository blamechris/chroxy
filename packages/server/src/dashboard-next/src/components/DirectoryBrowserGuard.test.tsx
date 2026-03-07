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
  it('captures requested path in closure for comparison', () => {
    // The navigate handler should capture the requested path in a closure variable
    expect(modalSource).toMatch(/const requestedPath/)
  })

  it('compares listing.path against requested path before applying', () => {
    // The callback should check listing.path matches the expected path
    expect(modalSource).toMatch(/listing\.path|listing\.parentPath/)
  })

  it('ignores stale responses from previous navigations', () => {
    // There should be a conditional return/guard in the callback
    // that prevents stale responses from updating state
    expect(modalSource).toMatch(/!==.*requestedPath.*return|return.*\/\/ stale/)
  })
})
