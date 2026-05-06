/**
 * Sidebar dot animation tests — verify only working dots pulse.
 */
import { describe, test, expect } from 'vitest'
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

describe('Sidebar dot animations (#1675)', () => {
  test('idle dot is static', () => {
    expect(componentsCss).toMatch(/sidebar-session-dot\.status-idle\s*\{[^}]*background:\s*var\(--accent-blue\)/)
    expect(componentsCss).not.toMatch(/sidebar-session-dot\.status-idle\s*\{[^}]*animation:/)
  })

  test('working dot has dotPulse animation', () => {
    expect(componentsCss).toMatch(/sidebar-session-dot\.status-working\s*\{[^}]*animation:\s*dotPulse/)
  })

  test('stale dot is static warning color', () => {
    expect(componentsCss).toMatch(/sidebar-session-dot\.status-stale\s*\{[^}]*background:\s*var\(--warning-fg/)
    expect(componentsCss).not.toMatch(/sidebar-session-dot\.status-stale\s*\{[^}]*animation:/)
  })

  test('dotPulse keyframes exist in global.css', () => {
    expect(globalCss).toMatch(/@keyframes dotPulse/)
  })

  test('working dot animation respects prefers-reduced-motion', () => {
    expect(componentsCss).toMatch(/prefers-reduced-motion[\s\S]*?sidebar-session-dot/)
  })
})
