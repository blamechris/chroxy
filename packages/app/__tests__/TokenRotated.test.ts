import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/store/message-handler.ts'),
  'utf-8',
)

describe('token_rotated handler (#989)', () => {
  test('handles token_rotated message type', () => {
    expect(src).toMatch(/case 'token_rotated'/)
  })

  test('clears saved connection on token rotation', () => {
    expect(src).toMatch(/token_rotated[\s\S]*?clearSavedConnection/)
  })

  test('disconnects the socket on token rotation', () => {
    expect(src).toMatch(/token_rotated[\s\S]*?disconnect\(\)/)
  })

  test('shows alert to the user about token rotation', () => {
    expect(src).toMatch(/token_rotated[\s\S]*?Alert\.alert/)
  })

  test('does NOT just console.log and break (the old behavior)', () => {
    // The handler should do more than just log — must have actual re-auth logic
    const match = src.match(/case 'token_rotated':\s*\{([\s\S]*?)\n    \}/)
    expect(match).toBeTruthy()
    expect(match[1]).toContain('clearSavedConnection')
    expect(match[1]).toContain('disconnect')
  })
})
