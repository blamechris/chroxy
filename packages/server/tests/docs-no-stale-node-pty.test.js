import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('self-hosting guide has no stale node-pty references (#1957)', () => {
  const doc = readFileSync(join(__dirname, '../../../docs/self-hosting-guide.md'), 'utf-8')

  it('requirements table does not reference node-pty', () => {
    const reqSection = doc.slice(0, doc.indexOf('## Quick Start'))
    assert.ok(!reqSection.includes('node-pty'),
      'Requirements should not reference node-pty (removed in v0.2.0)')
  })

  it('troubleshooting does not have node-pty compile section', () => {
    assert.ok(!doc.includes('node-pty fails to compile'),
      'Troubleshooting should not have node-pty compile section')
  })
})
