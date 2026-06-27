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

  test('working dot breathes (dotBreathe, not the shrink keyframe dotPulse)', () => {
    // #6419 — dotPulse animates scale(0)->scale(1) so the dot vanished ~80% of the
    // cycle; dotBreathe (opacity + gentle scale) actually breathes.
    expect(componentsCss).toMatch(/sidebar-session-dot\.status-working\s*\{[^}]*animation:\s*dotBreathe/)
    expect(componentsCss).not.toMatch(/sidebar-session-dot\.status-working\s*\{[^}]*animation:\s*dotPulse/)
  })

  test('stale dot is static warning color', () => {
    expect(componentsCss).toMatch(/sidebar-session-dot\.status-stale\s*\{[^}]*background:\s*var\(--warning-fg/)
    expect(componentsCss).not.toMatch(/sidebar-session-dot\.status-stale\s*\{[^}]*animation:/)
  })

  test('dotBreathe keyframes exist in global.css', () => {
    expect(globalCss).toMatch(/@keyframes dotBreathe/)
  })

  test('working dot animation respects prefers-reduced-motion', () => {
    expect(componentsCss).toMatch(/prefers-reduced-motion[\s\S]*?sidebar-session-dot/)
  })
})
