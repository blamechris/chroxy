import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/components/SessionPicker.tsx'),
  'utf-8',
)

describe('SessionPicker cross-platform rename', () => {
  test('does NOT use Alert.prompt (iOS-only)', () => {
    expect(src).not.toMatch(/Alert\.prompt/)
  })

  test('does NOT show "not available on this platform" message', () => {
    expect(src).not.toMatch(/not available on this platform/)
  })

  test('uses Modal for rename UI', () => {
    expect(src).toMatch(/import[\s\S]*Modal[\s\S]*from\s+['"]react-native['"]/)
  })

  test('has TextInput for entering new name', () => {
    expect(src).toMatch(/import[\s\S]*TextInput[\s\S]*from\s+['"]react-native['"]/)
  })

  test('has rename modal state', () => {
    expect(src).toMatch(/useState.*renameTarget|renameTarget.*useState/)
  })

  test('renders rename modal with Save and Cancel buttons', () => {
    expect(src).toMatch(/Save/)
    expect(src).toMatch(/Cancel/)
  })

  test('pre-fills TextInput with current session name', () => {
    // The rename modal should initialize with session.name or renameTarget.name
    expect(src).toMatch(/renameTarget[\s\S]*?\.name/)
  })
})
