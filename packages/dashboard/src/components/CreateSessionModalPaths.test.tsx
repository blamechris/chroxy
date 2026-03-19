/**
 * CreateSessionModal cross-platform path tests (#1479)
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const source = fs.readFileSync(
  path.resolve(__dirname, './CreateSessionModal.tsx'),
  'utf-8',
)

describe('CreateSessionModal cross-platform paths (#1479)', () => {
  it('has a shared basename helper that handles both / and \\', () => {
    // Should have a basename function that splits on both separators
    expect(source).toMatch(/function\s+basename/)
    expect(source).toMatch(/[/\\]|[\\/]|split\s*\(\s*\/\[.*?\\\\\]/)
  })

  it('generateDefaultName uses basename helper', () => {
    expect(source).toMatch(/generateDefaultName[\s\S]*?basename\(/)
  })

  it('suggestion label uses basename helper', () => {
    // The label derivation in JSX should use basename, not raw split('/')
    expect(source).toMatch(/basename\(path\)/)
  })
})
