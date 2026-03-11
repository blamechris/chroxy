import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/SessionScreen.tsx'),
  'utf-8',
)

describe('handleSearchOpen timeout cleanup (#1959)', () => {
  test('focus timer is tracked in a ref', () => {
    expect(src).toMatch(/searchFocusTimerRef = useRef/)
  })

  test('handleSearchOpen tracks setTimeout in ref', () => {
    expect(src).toMatch(/searchFocusTimerRef\.current = setTimeout/)
  })

  test('handleSearchOpen clears previous timer', () => {
    // clearTimeout should be called before setting a new timer
    expect(src).toMatch(/handleSearchOpen[\s\S]*?clearTimeout\(searchFocusTimerRef\.current\)[\s\S]*?searchFocusTimerRef\.current = setTimeout/)
  })

  test('handleSearchClose clears the timer', () => {
    expect(src).toMatch(/handleSearchClose[\s\S]*?clearTimeout\(searchFocusTimerRef\.current\)/)
  })

  test('unmount cleanup effect clears timer', () => {
    expect(src).toMatch(/useEffect\(\(\) => \(\) => clearTimeout\(searchFocusTimerRef\.current\), \[\]\)/)
  })
})
