import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/components/ChatView.tsx'),
  'utf-8',
)

describe('groupMessages memoization (#1937)', () => {
  test('groupMessages does not accept streamingMessageId parameter', () => {
    // Function signature should only take messages, not streaming state
    expect(src).toMatch(/function groupMessages\(messages: ChatMessage\[\]\): DisplayGroup\[\]/)
  })

  test('groupMessages sets isActive to false (structural only)', () => {
    // isActive should always be false in the pure grouping function
    expect(src).toMatch(/isActive: false,/)
  })

  test('baseGroups memo depends only on messages', () => {
    // Structural grouping should not include streamingMessageId in dependencies
    expect(src).toMatch(/useMemo\(\(\) => groupMessages\(messages\), \[messages\]\)/)
  })

  test('displayGroups overlays isActive separately', () => {
    // The streaming overlay should be a separate memo that depends on baseGroups
    expect(src).toMatch(/\[baseGroups, streamingMessageId, messages\]/)
  })

  test('streaming overlay is O(1) — only touches last group', () => {
    // Should slice off last element and push a new one, not re-create all groups
    expect(src).toMatch(/baseGroups\.slice\(0, -1\)/)
    expect(src).toMatch(/result\.push\(\{ \.\.\.last, isActive: true \}\)/)
  })
})
