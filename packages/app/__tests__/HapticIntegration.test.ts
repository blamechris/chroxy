import fs from 'fs'
import path from 'path'

const connectionSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/store/connection.ts'),
  'utf-8',
)

const messageHandlerSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/store/message-handler.ts'),
  'utf-8',
)

const sessionPickerSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/components/SessionPicker.tsx'),
  'utf-8',
)

describe('Haptic feedback integration', () => {
  // connection.ts haptics
  test('sendMessage triggers hapticLight', () => {
    // hapticLight is called inside the sendMessage function when socket is open
    expect(connectionSrc).toMatch(/readyState.*===.*WebSocket\.OPEN[\s\S]*?hapticLight\(\)/)
  })

  test('interrupt triggers hapticMedium', () => {
    expect(connectionSrc).toMatch(/interrupt[\s\S]*?hapticMedium\(\)/)
  })

  test('permission deny triggers hapticWarning', () => {
    expect(connectionSrc).toMatch(/deny.*hapticWarning|hapticWarning.*deny/)
  })

  test('switchSession triggers hapticLight', () => {
    expect(connectionSrc).toMatch(/switchSession[\s\S]*?hapticLight\(\)/)
  })

  test('disconnect triggers hapticMedium', () => {
    expect(connectionSrc).toMatch(/disconnect[\s\S]*?hapticMedium\(\)/)
  })

  // message-handler.ts haptics
  test('auth_ok triggers hapticSuccess', () => {
    expect(messageHandlerSrc).toMatch(/auth_ok[\s\S]*?hapticSuccess\(\)/)
  })

  test('result triggers hapticSuccess', () => {
    expect(messageHandlerSrc).toMatch(/case 'result'[\s\S]*?hapticSuccess\(\)/)
  })

  // SessionPicker haptics
  test('long-press triggers hapticMedium', () => {
    expect(sessionPickerSrc).toMatch(/handleLongPress[\s\S]*?hapticMedium\(\)/)
  })
})
