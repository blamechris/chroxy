import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../..')

describe('bump-version.sh includes desktop package.json (#1964)', () => {
  it('bump-version.sh references packages/desktop/package.json', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/bump-version.sh'), 'utf-8')
    assert.ok(
      src.includes('packages/desktop/package.json'),
      'bump-version.sh should update packages/desktop/package.json',
    )
  })

  it('desktop package.json version matches server package.json version', () => {
    const serverPkg = JSON.parse(readFileSync(resolve(ROOT, 'packages/server/package.json'), 'utf-8'))
    const desktopPkg = JSON.parse(readFileSync(resolve(ROOT, 'packages/desktop/package.json'), 'utf-8'))
    assert.equal(
      desktopPkg.version,
      serverPkg.version,
      `desktop version (${desktopPkg.version}) should match server version (${serverPkg.version})`,
    )
  })
})
