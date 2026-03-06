import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/ConnectScreen.tsx'),
  'utf-8',
)

describe('ConnectScreen accessibility', () => {
  test('auto-connect cancel button has a11y attrs', () => {
    // The cancel button sets autoConnecting to false
    expect(src).toMatch(/setAutoConnecting\(false\)[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/setAutoConnecting\(false\)[\s\S]*?accessibilityLabel/)
  })

  test('scanner cancel button has a11y attrs', () => {
    // Cancel button in scanner calls setShowScanner(false)
    expect(src).toMatch(/setShowScanner\(false\)[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/setShowScanner\(false\)[\s\S]*?accessibilityLabel/)
  })

  test('reconnect button has a11y attrs', () => {
    expect(src).toMatch(/onPress=\{handleReconnect\}[\s\S]*?accessibilityRole=["']button["']/)
  })

  test('forget button has a11y attrs', () => {
    expect(src).toMatch(/onPress=\{clearSavedConnection\}[\s\S]*?accessibilityRole=["']button["']/)
  })

  test('QR scan button has a11y attrs', () => {
    expect(src).toMatch(/onPress=\{handleScanQR\}[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/onPress=\{handleScanQR\}[\s\S]*?accessibilityLabel/)
  })

  test('LAN scan button has a11y attrs', () => {
    expect(src).toMatch(/onPress=\{handleScanLAN\}[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/onPress=\{handleScanLAN\}[\s\S]*?accessibilityLabel/)
  })

  test('manual connect toggle has a11y attrs', () => {
    expect(src).toMatch(/setShowManual\([\s\S]*?accessibilityRole=["']button["']/)
  })

  test('connect button has a11y attrs', () => {
    expect(src).toMatch(/onPress=\{handleConnect\}[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/onPress=\{handleConnect\}[\s\S]*?accessibilityLabel=["']Connect["']/)
  })

  test('discovered server items have a11y attrs', () => {
    expect(src).toMatch(/discoveredServers\.map[\s\S]*?accessibilityRole=["']button["']/)
  })
})
