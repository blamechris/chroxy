import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/ConnectScreen.tsx'),
  'utf-8',
)

describe('ConnectScreen accessibility', () => {
  test('auto-connect cancel button has a11y attrs', () => {
    expect(src).toMatch(/setAutoConnecting\(false\)[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/accessibilityLabel=["']Cancel connection attempt["']/)
  })

  test('scanner cancel button has a11y attrs', () => {
    expect(src).toMatch(/setShowScanner\(false\)[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/setShowScanner\(false\)[\s\S]*?accessibilityLabel=["']Cancel scan["']/)
  })

  test('reconnect button has descriptive a11y label with URL context', () => {
    expect(src).toMatch(/onPress=\{handleReconnect\}[\s\S]*?accessibilityRole=["']button["']/)
    // Label should include dynamic URL context
    expect(src).toMatch(/accessibilityLabel=\{[`"]Reconnect to/)
  })

  test('forget button has descriptive a11y label', () => {
    expect(src).toMatch(/onPress=\{clearSavedConnection\}[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/onPress=\{clearSavedConnection\}[\s\S]*?accessibilityLabel=["']Remove saved server connection["']/)
  })

  test('QR scan button has descriptive a11y label', () => {
    expect(src).toMatch(/onPress=\{handleScanQR\}[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/onPress=\{handleScanQR\}[\s\S]*?accessibilityLabel=["']Open camera to scan QR code["']/)
  })

  test('LAN scan button has descriptive a11y label', () => {
    expect(src).toMatch(/onPress=\{handleScanLAN\}[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/onPress=\{handleScanLAN\}[\s\S]*?accessibilityLabel=["']Scan local network for Chroxy servers["']/)
  })

  test('manual connect toggle has a11y attrs', () => {
    expect(src).toMatch(/setShowManual\([\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/accessibilityLabel=["']Enter server address manually["']/)
  })

  test('connect button has a11y attrs', () => {
    expect(src).toMatch(/onPress=\{handleConnect\}[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/onPress=\{handleConnect\}[\s\S]*?accessibilityLabel=["']Connect to server["']/)
  })

  test('discovered server items have a11y attrs', () => {
    expect(src).toMatch(/discoveredServers\.map[\s\S]*?accessibilityRole=["']button["']/)
    // Label should include dynamic server context
    expect(src).toMatch(/accessibilityLabel=\{[`"]Connect to \$\{server/)
  })

  test('manual toggle meets 44pt minimum touch target', () => {
    // minHeight: 44 ensures touch target compliance
    expect(src).toMatch(/manualToggle[\s\S]*?minHeight:\s*44/)
  })

  test('port input has accessibility label', () => {
    expect(src).toMatch(/portInput[\s\S]*?accessibilityLabel=["']LAN scan port number["']/)
  })

  test('URL input has accessibility label', () => {
    expect(src).toMatch(/Server URL[\s\S]*?accessibilityLabel=["']Server URL["']/)
  })

  test('token input has accessibility label', () => {
    expect(src).toMatch(/API Token[\s\S]*?accessibilityLabel=["']API Token["']/)
  })
})
