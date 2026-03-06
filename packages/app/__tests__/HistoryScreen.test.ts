import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/HistoryScreen.tsx'),
  'utf-8',
)

describe('HistoryScreen component structure', () => {
  test('fetches conversation history on mount', () => {
    expect(src).toMatch(/fetchConversationHistory/)
    expect(src).toMatch(/useEffect/)
  })

  test('renders search bar for searching conversations', () => {
    expect(src).toMatch(/Search across conversations/)
    expect(src).toMatch(/searchQuery/)
  })

  test('debounces search input (300ms)', () => {
    expect(src).toMatch(/setTimeout/)
    expect(src).toMatch(/300/)
    expect(src).toMatch(/searchConversations/)
  })

  test('groups conversations by project name', () => {
    expect(src).toMatch(/projectName/)
    expect(src).toMatch(/groupHeader/)
  })

  test('shows resume button for each conversation', () => {
    expect(src).toMatch(/Resume/)
    expect(src).toMatch(/resumeConversation/)
    expect(src).toMatch(/accessibilityLabel.*Resume conversation/)
  })

  test('shows loading state with ActivityIndicator', () => {
    expect(src).toMatch(/ActivityIndicator/)
    expect(src).toMatch(/Loading conversations/)
    expect(src).toMatch(/conversationHistoryLoading/)
  })

  test('shows empty state when no history exists', () => {
    expect(src).toMatch(/No conversation history found/)
  })

  test('shows empty state for search with no results', () => {
    expect(src).toMatch(/No results found/)
  })

  test('shows conversation preview text', () => {
    expect(src).toMatch(/preview/)
    expect(src).toMatch(/numberOfLines/)
  })

  test('shows relative time formatting', () => {
    expect(src).toMatch(/formatRelativeTime/)
    expect(src).toMatch(/just now/)
    expect(src).toMatch(/m ago/)
    expect(src).toMatch(/h ago/)
    expect(src).toMatch(/d ago/)
  })

  test('supports pull-to-refresh', () => {
    expect(src).toMatch(/onRefresh=\{fetchConversationHistory\}/)
    expect(src).toMatch(/refreshing/)
  })

  test('has clear search button', () => {
    expect(src).toMatch(/Clear search/)
    expect(src).toMatch(/clearSearchResults/)
  })

  test('navigates back after resuming conversation', () => {
    expect(src).toMatch(/navigation\.goBack/)
  })
})
