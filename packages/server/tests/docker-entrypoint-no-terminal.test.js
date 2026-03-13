import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCRIPT_PATH = resolve(import.meta.dirname, '../../../scripts/docker-entrypoint.sh')

describe('docker-entrypoint.sh stale terminal guard (#2031)', () => {
  it('does not reference the removed --terminal flag', () => {
    const src = readFileSync(SCRIPT_PATH, 'utf-8')
    assert.ok(
      !src.includes('--terminal'),
      'docker-entrypoint.sh should not reference the removed --terminal flag',
    )
  })

  it('does not reference node-pty', () => {
    const src = readFileSync(SCRIPT_PATH, 'utf-8')
    assert.ok(
      !src.includes('node-pty'),
      'docker-entrypoint.sh should not reference node-pty (removed in v0.2.0)',
    )
  })
})
