import { useConversationStore } from '../../store/conversations'

describe('ConversationStore', () => {
  beforeEach(() => {
    useConversationStore.getState().reset()
  })

  it('initializes with empty state', () => {
    const state = useConversationStore.getState()
    expect(state.conversationHistory).toEqual([])
    expect(state.conversationHistoryLoading).toBe(false)
    expect(state.conversationHistoryError).toBeNull()
    expect(state.searchResults).toEqual([])
    expect(state.searchLoading).toBe(false)
    expect(state.searchQuery).toBe('')
    expect(state.searchError).toBeNull()
    expect(state.checkpoints).toEqual([])
    expect(state.slashCommands).toEqual([])
    expect(state.customAgents).toEqual([])
  })

  it('sets conversation history', () => {
    const conversations = [
      { conversationId: 'c1', project: null, projectName: 'proj1', modifiedAt: '2026-01-01', modifiedAtMs: 1000, sizeBytes: 100, preview: null, cwd: null },
    ]
    useConversationStore.getState().setConversationHistory(conversations)
    const state = useConversationStore.getState()
    expect(state.conversationHistory).toEqual(conversations)
    expect(state.conversationHistoryLoading).toBe(false)
    expect(state.conversationHistoryError).toBeNull()
  })

  it('sets conversation history loading', () => {
    useConversationStore.getState().setConversationHistoryLoading(true)
    expect(useConversationStore.getState().conversationHistoryLoading).toBe(true)
  })

  it('sets conversation history error', () => {
    useConversationStore.getState().setConversationHistoryError('Network error')
    const state = useConversationStore.getState()
    expect(state.conversationHistoryError).toBe('Network error')
    expect(state.conversationHistoryLoading).toBe(false)
  })

  it('sets search results', () => {
    const results = [
      { conversationId: 'c1', projectName: 'proj1', project: null, cwd: null, preview: null, snippet: 'test', matchCount: 1 },
    ]
    useConversationStore.getState().setSearchResults(results, 'test query')
    const state = useConversationStore.getState()
    expect(state.searchResults).toEqual(results)
    expect(state.searchQuery).toBe('test query')
    expect(state.searchLoading).toBe(false)
    expect(state.searchError).toBeNull()
  })

  it('sets search loading', () => {
    useConversationStore.getState().setSearchLoading(true)
    expect(useConversationStore.getState().searchLoading).toBe(true)
  })

  it('clears search results', () => {
    useConversationStore.getState().setSearchResults(
      [{ conversationId: 'c1', projectName: 'proj1', project: null, cwd: null, preview: null, snippet: 'x', matchCount: 1 }],
      'query'
    )
    useConversationStore.getState().clearSearchResults()
    const state = useConversationStore.getState()
    expect(state.searchResults).toEqual([])
    expect(state.searchQuery).toBe('')
    expect(state.searchLoading).toBe(false)
    expect(state.searchError).toBeNull()
  })

  it('adds a checkpoint', () => {
    const cp = { id: 'cp1', name: 'Save 1', description: 'desc', messageCount: 5, createdAt: 1000, hasGitSnapshot: false }
    useConversationStore.getState().addCheckpoint(cp)
    expect(useConversationStore.getState().checkpoints).toEqual([cp])
  })

  it('sets checkpoints list', () => {
    const cps = [
      { id: 'cp1', name: 'Save 1', description: '', messageCount: 5, createdAt: 1000, hasGitSnapshot: false },
      { id: 'cp2', name: 'Save 2', description: '', messageCount: 10, createdAt: 2000, hasGitSnapshot: true },
    ]
    useConversationStore.getState().setCheckpoints(cps)
    expect(useConversationStore.getState().checkpoints).toEqual(cps)
  })

  it('sets slash commands', () => {
    const commands = [{ name: '/test', description: 'Test command', source: 'project' as const }]
    useConversationStore.getState().setSlashCommands(commands)
    expect(useConversationStore.getState().slashCommands).toEqual(commands)
  })

  it('sets custom agents', () => {
    const agents = [{ name: 'my-agent', description: 'Custom agent', source: 'user' as const }]
    useConversationStore.getState().setCustomAgents(agents)
    expect(useConversationStore.getState().customAgents).toEqual(agents)
  })

  it('resets to initial state', () => {
    const store = useConversationStore.getState()
    store.setConversationHistory([
      { conversationId: 'c1', project: null, projectName: 'proj1', modifiedAt: '2026-01-01', modifiedAtMs: 1000, sizeBytes: 100, preview: null, cwd: null },
    ])
    store.addCheckpoint({ id: 'cp1', name: 'Save', description: '', messageCount: 5, createdAt: 1000, hasGitSnapshot: false })
    store.setSlashCommands([{ name: '/test', description: 'Test', source: 'project' as const }])
    store.reset()
    const state = useConversationStore.getState()
    expect(state.conversationHistory).toEqual([])
    expect(state.checkpoints).toEqual([])
    expect(state.slashCommands).toEqual([])
    expect(state.customAgents).toEqual([])
  })
})
