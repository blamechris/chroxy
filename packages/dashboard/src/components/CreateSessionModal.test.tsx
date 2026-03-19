import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

describe('CreateSessionModal memoization (#1476)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, './CreateSessionModal.tsx'),
    'utf-8',
  )

  it('memoizes suggestions computation with useMemo', () => {
    expect(source).toMatch(/suggestions\s*=\s*useMemo\(/)
  })

  it('depends on knownCwds', () => {
    expect(source).toMatch(/suggestions\s*=\s*useMemo\([^[]*\[[\s\S]*?knownCwds/)
  })
})

describe('App knownCwds memoization (#1476)', () => {
  const appSource = fs.readFileSync(
    path.resolve(__dirname, '../App.tsx'),
    'utf-8',
  )

  it('memoizes knownCwds array with useMemo', () => {
    expect(appSource).toMatch(/knownCwds\s*=\s*useMemo\(/)
  })
})
