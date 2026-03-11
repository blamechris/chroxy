import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/ConnectScreen.tsx'),
  'utf-8',
)

describe('LAN scan AbortController fix (#1947)', () => {
  test('onOuterAbort clears timeout before aborting', () => {
    // The outer abort handler must clearTimeout to prevent double-abort
    expect(src).toMatch(/onOuterAbort = \(\) => \{[\s\S]*?clearTimeout\(timeout\)[\s\S]*?ctrl\.abort\(\)[\s\S]*?\}/)
  })

  test('finally block still clears timeout as safety net', () => {
    expect(src).toMatch(/finally \{[\s\S]*?clearTimeout\(timeout\)/)
  })
})
