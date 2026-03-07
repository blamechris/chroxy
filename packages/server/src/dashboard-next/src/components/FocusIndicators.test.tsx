/**
 * Focus indicator and keyboard a11y tests (#997)
 *
 * Source-scan tests that verify :focus-visible CSS rules and ARIA attributes
 * exist across the dashboard codebase.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const componentsCss = fs.readFileSync(
  path.resolve(__dirname, '../theme/components.css'),
  'utf-8',
)

const globalCss = fs.readFileSync(
  path.resolve(__dirname, '../theme/global.css'),
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
  it('has global :focus-visible baseline in global.css', () => {
    expect(globalCss).toMatch(/:focus-visible/)
  })

  it('has :focus-visible styles for session tabs', () => {
    expect(componentsCss).toMatch(/\.session-tab:focus-visible/)
  })

  it('has :focus-visible styles for send/interrupt buttons', () => {
    expect(componentsCss).toMatch(/\.btn-send:focus-visible/)
    expect(componentsCss).toMatch(/\.btn-interrupt:focus-visible/)
  })

  it('has :focus-visible styles for permission buttons', () => {
    expect(componentsCss).toMatch(/\.btn-allow:focus-visible/)
    expect(componentsCss).toMatch(/\.btn-deny:focus-visible/)
  })

  it('has :focus-visible styles for tab close button', () => {
    expect(componentsCss).toMatch(/\.tab-close:focus-visible/)
  })

  it('has :focus-visible styles for new session button', () => {
    expect(componentsCss).toMatch(/\.btn-new-session:focus-visible/)
  })

  it('has :focus-visible styles for view tabs', () => {
    expect(componentsCss).toMatch(/\.view-tab:focus-visible/)
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

  it('tab container has role="tablist"', () => {
    expect(sessionBarSource).toMatch(/role="tablist"/)
  })

  it('session tabs have tabIndex', () => {
    expect(sessionBarSource).toMatch(/tabIndex=/)
  })

  it('session tabs have aria-selected', () => {
    expect(sessionBarSource).toMatch(/aria-selected/)
  })

  it('session tabs support Enter/Space keyboard activation', () => {
    expect(sessionBarSource).toMatch(/Enter/)
    expect(sessionBarSource).toMatch(/' '/)
  })

  it('session tabs support arrow key navigation', () => {
    expect(sessionBarSource).toMatch(/ArrowRight/)
    expect(sessionBarSource).toMatch(/ArrowLeft/)
  })
})
