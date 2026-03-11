import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('setup-repo.sh removed (#1960)', () => {
  it('scripts/setup-repo.sh does not exist', () => {
    const scriptPath = join(__dirname, '../../../scripts/setup-repo.sh')
    assert.ok(!existsSync(scriptPath),
      'setup-repo.sh should be removed — it is a one-shot bootstrap script')
  })
})
