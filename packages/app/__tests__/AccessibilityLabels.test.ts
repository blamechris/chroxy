import fs from 'fs'
import path from 'path'

const historyScreen = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/HistoryScreen.tsx'),
  'utf-8',
)

const sessionPicker = fs.readFileSync(
  path.resolve(__dirname, '../src/components/SessionPicker.tsx'),
  'utf-8',
)

const sessionOverview = fs.readFileSync(
  path.resolve(__dirname, '../src/components/SessionOverview.tsx'),
  'utf-8',
)

describe('HistoryScreen accessibility (#1925)', () => {
  test('search input has accessibilityLabel', () => {
    expect(historyScreen).toMatch(/searchInput[\s\S]*?accessibilityLabel=["']Search conversations["']/)
  })
})

describe('SessionPicker accessibility (#1927)', () => {
  test('session pill has accessibilityRole and accessibilityLabel', () => {
    expect(sessionPicker).toMatch(/accessibilityRole=["']tab["']/)
    expect(sessionPicker).toMatch(/accessibilityLabel=\{`Session \$\{session\.name\}/)
  })

  test('session pill has accessibilityState for selected', () => {
    expect(sessionPicker).toMatch(/accessibilityState=\{\{ selected: isActive \}\}/)
  })

  test('rename modal TextInput has accessibilityLabel', () => {
    expect(sessionPicker).toMatch(/renameInput[\s\S]*?accessibilityLabel=["']Session name["']/)
  })

  test('rename modal Cancel button has a11y attrs', () => {
    expect(sessionPicker).toMatch(/setRenameTarget\(null\)[\s\S]*?accessibilityRole=["']button["']/)
    expect(sessionPicker).toMatch(/accessibilityLabel=["']Cancel rename["']/)
  })

  test('rename modal Save button has a11y attrs', () => {
    expect(sessionPicker).toMatch(/renameSaveBtn[\s\S]*?accessibilityRole=["']button["']/)
    expect(sessionPicker).toMatch(/accessibilityLabel=["']Save session name["']/)
  })
})

describe('SessionOverview accessibility (#1929)', () => {
  test('rename modal TextInput has accessibilityLabel', () => {
    expect(sessionOverview).toMatch(/renameInput[\s\S]*?accessibilityLabel=["']Session name["']/)
  })

  test('rename modal Cancel button has a11y attrs', () => {
    expect(sessionOverview).toMatch(/setRenameTarget\(null\)[\s\S]*?accessibilityRole=["']button["']/)
    expect(sessionOverview).toMatch(/accessibilityLabel=["']Cancel rename["']/)
  })

  test('rename modal Save button has a11y attrs', () => {
    expect(sessionOverview).toMatch(/renameSaveBtn[\s\S]*?accessibilityRole=["']button["']/)
    expect(sessionOverview).toMatch(/accessibilityLabel=["']Save session name["']/)
  })
})
