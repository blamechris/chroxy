/**
 * Sidebar dot animation tests — verify idle dots have breathing animation.
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
  test('idle dot has dotBreathe animation', () => {
    expect(componentsCss).toMatch(/sidebar-idle-dot[\s\S]*?animation:\s*dotBreathe/)
  })

  test('busy dot has dotPulse animation', () => {
    expect(componentsCss).toMatch(/sidebar-busy-dot[\s\S]*?animation:\s*dotPulse/)
  })

  test('dotBreathe keyframes exist in global.css', () => {
    expect(globalCss).toMatch(/@keyframes dotBreathe/)
  })

  test('dotBreathe is slower than dotPulse (3s vs 1.5s)', () => {
    expect(componentsCss).toMatch(/sidebar-idle-dot[\s\S]*?animation:\s*dotBreathe\s+3s/)
    expect(componentsCss).toMatch(/sidebar-busy-dot[\s\S]*?animation:\s*dotPulse\s+1\.5s/)
  })

  test('idle dot animation respects prefers-reduced-motion', () => {
    expect(componentsCss).toMatch(/prefers-reduced-motion[\s\S]*?sidebar-idle-dot/)
  })
})
