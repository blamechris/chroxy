import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/ConnectScreen.tsx'),
  'utf-8',
)

describe('ConnectScreen component structure', () => {
  test('renders title "Connect to Chroxy"', () => {
    expect(src).toMatch(/Connect to Chroxy/)
  })

  test('renders QR code scan button', () => {
    expect(src).toMatch(/Scan QR Code/)
    expect(src).toMatch(/onPress=\{handleScanQR\}/)
  })

  test('renders LAN scan button', () => {
    expect(src).toMatch(/Scan Local Network/)
    expect(src).toMatch(/onPress=\{handleScanLAN\}/)
  })

  test('renders manual entry toggle', () => {
    expect(src).toMatch(/Enter manually/)
    expect(src).toMatch(/setShowManual/)
  })

  test('manual form has Server URL and API Token inputs', () => {
    expect(src).toMatch(/Server URL/)
    expect(src).toMatch(/API Token/)
  })

  test('manual form has Connect button', () => {
    expect(src).toMatch(/onPress=\{handleConnect\}/)
    expect(src).toMatch(/Connect<\/Text>/)
  })

  test('shows reconnect button when savedConnection exists', () => {
    expect(src).toMatch(/savedConnection\s*&&/)
    expect(src).toMatch(/Reconnect/)
    expect(src).toMatch(/onPress=\{handleReconnect\}/)
  })

  test('shows forget button for saved connection', () => {
    expect(src).toMatch(/onPress=\{clearSavedConnection\}/)
    expect(src).toMatch(/Forget/)
  })

  test('parses chroxy:// URL scheme', () => {
    expect(src).toMatch(/chroxy:\/\//)
    expect(src).toMatch(/parseChroxyUrl/)
  })

  test('shows auto-connect spinner with cancel option', () => {
    expect(src).toMatch(/autoConnecting/)
    expect(src).toMatch(/Cancel auto-connect/)
    expect(src).toMatch(/ActivityIndicator/)
  })

  test('shows connection error banner when disconnected', () => {
    expect(src).toMatch(/connectionError\s*&&\s*connectionPhase\s*===\s*['"]disconnected['"]/)
  })

  test('shows port input for LAN scan', () => {
    expect(src).toMatch(/scanPort/)
    expect(src).toMatch(/keyboardType="number-pad"/)
  })

  test('shows discovered servers after LAN scan', () => {
    expect(src).toMatch(/discoveredServers\.map/)
    expect(src).toMatch(/discoveredHostname/)
  })

  test('shows scan progress percentage', () => {
    expect(src).toMatch(/scanProgress/)
    expect(src).toMatch(/Scanning\.\.\./)
  })

  test('shows "View Last Session" when cached messages exist', () => {
    expect(src).toMatch(/View Last Session/)
    expect(src).toMatch(/hasCachedMessages/)
    expect(src).toMatch(/viewCachedSession/)
  })

  test('camera scanner view has cancel button', () => {
    expect(src).toMatch(/showScanner/)
    expect(src).toMatch(/CameraView/)
    expect(src).toMatch(/Cancel scan/)
  })

  test('connects to store for connection state', () => {
    expect(src).toMatch(/useConnectionStore/)
    expect(src).toMatch(/connectionPhase/)
    expect(src).toMatch(/connectionError/)
  })
})
