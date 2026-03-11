import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/SessionScreen.tsx'),
  'utf-8',
)

describe('searchQuery shadowing fix (#1940)', () => {
  test('local state uses inSessionSearchQuery name', () => {
    expect(src).toMatch(/const \[inSessionSearchQuery, setInSessionSearchQuery\] = useState/)
  })

  test('no local state named searchQuery remains', () => {
    // Should not have a bare searchQuery state declaration
    expect(src).not.toMatch(/const \[searchQuery, setSearchQuery\] = useState/)
  })

  test('ChatView prop still uses searchQuery (component interface unchanged)', () => {
    expect(src).toMatch(/searchQuery=\{searchVisible \? inSessionSearchQuery : undefined\}/)
  })
})
