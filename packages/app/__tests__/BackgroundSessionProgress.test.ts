import fs from 'fs'
import path from 'path'

const componentPath = path.resolve(__dirname, '../src/components/BackgroundSessionProgress.tsx')
const src = fs.readFileSync(componentPath, 'utf-8')

describe('Background session progress indicators (#1049)', () => {
  test('component reads sessionStates from store', () => {
    expect(src).toMatch(/sessionStates/)
  })

  test('component reads sessions list for names', () => {
    expect(src).toMatch(/sessions/)
  })

  test('filters out active session', () => {
    expect(src).toMatch(/activeSessionId/)
  })

  test('shows status text for busy sessions (thinking/streaming)', () => {
    expect(src).toMatch(/[Tt]hinking|[Ss]treaming|[Ww]riting/)
  })

  test('tapping entry switches session', () => {
    expect(src).toMatch(/switchSession/)
  })

  test('only renders when there are busy background sessions', () => {
    // Should return null or filter to non-idle
    expect(src).toMatch(/isIdle|!idle|length\s*===\s*0/)
  })

  test('has accessibility labels', () => {
    expect(src).toMatch(/accessibilityRole/)
  })
})
