import fs from 'fs'
import path from 'path'

const pickerSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/components/SessionPicker.tsx'),
  'utf-8',
)

const overviewSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/components/SessionOverview.tsx'),
  'utf-8',
)

describe('SessionPicker cross-platform rename', () => {
  test('does NOT use Alert.prompt (iOS-only)', () => {
    expect(pickerSrc).not.toMatch(/Alert\.prompt/)
  })

  test('does NOT show "not available on this platform" message', () => {
    expect(pickerSrc).not.toMatch(/not available on this platform/)
  })

  test('uses Modal for rename UI', () => {
    expect(pickerSrc).toMatch(/import[\s\S]*Modal[\s\S]*from\s+['"]react-native['"]/)
  })

  test('has TextInput for entering new name', () => {
    expect(pickerSrc).toMatch(/import[\s\S]*TextInput[\s\S]*from\s+['"]react-native['"]/)
  })

  test('has rename modal state', () => {
    expect(pickerSrc).toMatch(/useState.*renameTarget|renameTarget.*useState/)
  })

  test('renders rename modal with Save and Cancel buttons', () => {
    expect(pickerSrc).toMatch(/Save/)
    expect(pickerSrc).toMatch(/Cancel/)
  })

  test('pre-fills TextInput with current session name', () => {
    expect(pickerSrc).toMatch(/renameTarget[\s\S]*?\.name/)
  })
})

describe('SessionOverview cross-platform rename', () => {
  test('does NOT use Alert.prompt (iOS-only)', () => {
    expect(overviewSrc).not.toMatch(/Alert\.prompt/)
  })

  test('uses Modal for rename UI', () => {
    expect(overviewSrc).toMatch(/import[\s\S]*Modal[\s\S]*from\s+['"]react-native['"]/)
  })

  test('has TextInput for entering new name', () => {
    expect(overviewSrc).toMatch(/import[\s\S]*TextInput[\s\S]*from\s+['"]react-native['"]/)
  })

  test('has rename modal state', () => {
    expect(overviewSrc).toMatch(/useState.*renameTarget|renameTarget.*useState/)
  })

  test('renders rename modal with Save and Cancel buttons', () => {
    expect(overviewSrc).toMatch(/Save/)
    expect(overviewSrc).toMatch(/Cancel/)
  })

  test('rename available on all platforms (no Platform.OS gate)', () => {
    // The rename button should not be behind a Platform.OS === 'ios' check
    expect(overviewSrc).not.toMatch(/Platform\.OS\s*===\s*['"]ios['"]\s*\)\s*\{[\s\S]*?Rename/)
  })
})
