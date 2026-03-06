/**
 * Focus indicator and keyboard a11y tests (#997)
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const cssSource = fs.readFileSync(
  path.resolve(__dirname, '../theme/components.css'),
  'utf-8',
)

const permSource = fs.readFileSync(
  path.resolve(__dirname, './PermissionPrompt.tsx'),
  'utf-8',
)

const sessionBarSource = fs.readFileSync(
  path.resolve(__dirname, './SessionBar.tsx'),
  'utf-8',
)

describe('Focus indicators (#997)', () => {
  it('has global :focus-visible styles for buttons', () => {
    expect(cssSource).toMatch(/button[\s\S]*?:focus-visible/)
  })

  it('has :focus-visible styles for session tabs', () => {
    expect(cssSource).toMatch(/session-tab[\s\S]*?:focus-visible|:focus-visible[\s\S]*?session-tab/)
  })
})

describe('Permission prompt a11y (#997)', () => {
  it('Allow button has aria-label', () => {
    expect(permSource).toMatch(/btn-allow[\s\S]*?aria-label/)
  })

  it('Deny button has aria-label', () => {
    expect(permSource).toMatch(/btn-deny[\s\S]*?aria-label/)
  })
})

describe('Session bar keyboard nav (#997)', () => {
  it('session tabs have role="tab"', () => {
    expect(sessionBarSource).toMatch(/role="tab"/)
  })

  it('session tabs have tabIndex', () => {
    expect(sessionBarSource).toMatch(/tabIndex=/)
  })

  it('session tabs support Enter/Space keyboard navigation', () => {
    expect(sessionBarSource).toMatch(/onKeyDown/)
  })
})
