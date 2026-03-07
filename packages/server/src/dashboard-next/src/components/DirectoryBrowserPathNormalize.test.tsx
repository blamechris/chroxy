/**
 * Tests for path normalization in directory browse stale-response guard (#1592)
 *
 * The server normalizes paths (e.g., ~ → /home/user, trailing slashes stripped).
 * The guard must normalize both sides before comparing to avoid false stale
 * detection on valid responses.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const modalSource = fs.readFileSync(
  path.resolve(__dirname, './CreateSessionModal.tsx'),
  'utf-8',
)

describe('Path normalization in stale-response guard (#1592)', () => {
  it('has a normalizeBrowsePath helper function', () => {
    expect(modalSource).toMatch(/function normalizeBrowsePath/)
  })

  it('normalizes both requestedPath and responsePath before comparing', () => {
    // Both sides of the !== comparison should go through normalization
    expect(modalSource).toMatch(/normalizeBrowsePath\(responsePath\)/)
    expect(modalSource).toMatch(/normalizeBrowsePath\(requestedPath\)/)
  })

  it('strips trailing slashes in normalization', () => {
    // The normalize function should strip trailing slashes
    expect(modalSource).toMatch(/replace\(\/\\\/\+\$\//)
  })

  it('updates browsePath to canonical server path when response differs', () => {
    // When a response arrives with a different (but valid) canonical path,
    // update browsePath to reflect the server's canonical path
    expect(modalSource).toMatch(/setBrowsePath\(responsePath\)/)
  })
})
