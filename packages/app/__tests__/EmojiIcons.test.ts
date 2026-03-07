import fs from 'fs'
import path from 'path'

const iconsPath = path.resolve(__dirname, '../src/constants/icons.ts')
const iconsSrc = fs.readFileSync(iconsPath, 'utf-8')

const connectPath = path.resolve(__dirname, '../src/screens/ConnectScreen.tsx')
const connectSrc = fs.readFileSync(connectPath, 'utf-8')

// Emoji ranges: surrogate pairs (\uD800-\uDBFF followed by \uDC00-\uDFFF)
const SURROGATE_PAIR = /\\uD[89A-Fa-f][0-9A-Fa-f]{2}\\uD[C-Fc-f][0-9A-Fa-f]{2}/

describe('Emoji icon removal', () => {
  test('icons.ts contains no emoji (surrogate pair) constants', () => {
    // All remaining constants should be BMP text symbols (single \uXXXX or ASCII)
    expect(iconsSrc).not.toMatch(SURROGATE_PAIR)
  })

  test('icons.ts does not export ICON_SATELLITE', () => {
    expect(iconsSrc).not.toMatch(/ICON_SATELLITE/)
  })

  test('icons.ts does not export ICON_CAMERA', () => {
    expect(iconsSrc).not.toMatch(/ICON_CAMERA/)
  })

  test('icons.ts does not export ICON_MICROPHONE', () => {
    expect(iconsSrc).not.toMatch(/ICON_MICROPHONE/)
  })

  test('icons.ts does not export ICON_CLOCK', () => {
    expect(iconsSrc).not.toMatch(/ICON_CLOCK/)
  })

  test('icons.ts still exports text-symbol constants', () => {
    expect(iconsSrc).toMatch(/ICON_CHECK/)
    expect(iconsSrc).toMatch(/ICON_CLOSE/)
    expect(iconsSrc).toMatch(/ICON_BULLET/)
    expect(iconsSrc).toMatch(/ICON_DIFF/)
  })

  test('ConnectScreen uses Icon component instead of ICON_SATELLITE emoji', () => {
    expect(connectSrc).not.toMatch(/ICON_SATELLITE/)
    expect(connectSrc).toMatch(/<Icon name="satellite"/)
  })

  test('ConnectScreen does not import ICON_SATELLITE', () => {
    const importLine = connectSrc.match(/import\s*\{[^}]*\}\s*from\s*['"]\.\.\/constants\/icons['"]/)
    expect(importLine).toBeTruthy()
    expect(importLine![0]).not.toMatch(/ICON_SATELLITE/)
  })
})
