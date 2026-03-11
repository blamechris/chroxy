import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/components/FolderBrowser.tsx'),
  'utf-8',
)

describe('FolderBrowser back button icon (#1955)', () => {
  test('uses Icon component instead of raw text chevron', () => {
    expect(src).toMatch(/<Icon name="chevronLeft"/)
    expect(src).not.toMatch(/'\< Back'/)
  })

  test('back button has accessibilityRole and accessibilityLabel', () => {
    expect(src).toMatch(/navigateUp[\s\S]*?accessibilityRole=["']button["']/)
    expect(src).toMatch(/accessibilityLabel=["']Go up to parent directory["']/)
  })

  test('disabled state uses different icon color', () => {
    expect(src).toMatch(/color=\{!parentPath \? COLORS\.textDim : COLORS\.textPrimary\}/)
  })
})
