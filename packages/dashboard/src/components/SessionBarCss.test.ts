/**
 * SessionBar CSS tests — keep horizontal tab scrolling unobtrusive.
 */
import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const componentsCss = fs.readFileSync(
  path.resolve(__dirname, '../theme/components.css'),
  'utf-8',
)

describe('SessionBar tab scrolling', () => {
  test('hides the horizontal scrollbar while preserving x-scroll', () => {
    expect(componentsCss).toMatch(/\.session-tabs\s*\{[^}]*overflow-x:\s*auto/)
    expect(componentsCss).toMatch(/\.session-tabs\s*\{[^}]*scrollbar-width:\s*none/)
    expect(componentsCss).toMatch(/\.session-tabs::-webkit-scrollbar\s*\{[^}]*display:\s*none/)
  })
})
