import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/store/message-handler.ts'),
  'utf-8',
)

describe('push_token_error handler (#1987)', () => {
  test('message handler has case for push_token_error', () => {
    expect(src).toMatch(/case 'push_token_error':/)
  })

  test('logs warning with errMessage from server', () => {
    expect(src).toMatch(/console\.warn\([^)]*(msg\.message|errMessage)[^)]*\)/i)
  })
})
