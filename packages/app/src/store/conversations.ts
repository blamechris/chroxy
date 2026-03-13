import { create } from 'zustand'
import type {
  ConversationSummary,
  SearchResult,
  Checkpoint,
  SlashCommand,
  CustomAgent,
} from './types'

interface ConversationState {
  conversationHistory: ConversationSummary[]
  conversationHistoryLoading: boolean
  conversationHistoryError: string | null

  searchResults: SearchResult[]
  searchLoading: boolean
  searchQuery: string
  searchError: string | null

  checkpoints: Checkpoint[]
  slashCommands: SlashCommand[]
  customAgents: CustomAgent[]

  setConversationHistory: (conversations: ConversationSummary[]) => void
  setConversationHistoryLoading: (loading: boolean) => void
  setConversationHistoryError: (error: string | null) => void

  setSearchResults: (results: SearchResult[], query: string) => void
  setSearchLoading: (loading: boolean) => void
  clearSearchResults: () => void

  addCheckpoint: (checkpoint: Checkpoint) => void
  setCheckpoints: (checkpoints: Checkpoint[]) => void

  setSlashCommands: (commands: SlashCommand[]) => void
  setCustomAgents: (agents: CustomAgent[]) => void

  reset: () => void
}

const initialState = {
  conversationHistory: [] as ConversationSummary[],
  conversationHistoryLoading: false,
  conversationHistoryError: null as string | null,

  searchResults: [] as SearchResult[],
  searchLoading: false,
  searchQuery: '',
  searchError: null as string | null,

  checkpoints: [] as Checkpoint[],
  slashCommands: [] as SlashCommand[],
  customAgents: [] as CustomAgent[],
}

export const useConversationStore = create<ConversationState>((set) => ({
  ...initialState,

  setConversationHistory: (conversations) =>
    set({ conversationHistory: conversations, conversationHistoryLoading: false, conversationHistoryError: null }),

  setConversationHistoryLoading: (loading) =>
    set({ conversationHistoryLoading: loading }),

  setConversationHistoryError: (error) =>
    set({ conversationHistoryError: error, conversationHistoryLoading: false }),

  setSearchResults: (results, query) =>
    set({ searchResults: results, searchQuery: query, searchLoading: false, searchError: null }),

  setSearchLoading: (loading) =>
    set({ searchLoading: loading }),

  clearSearchResults: () =>
    set({ searchResults: [], searchQuery: '', searchLoading: false, searchError: null }),

  addCheckpoint: (checkpoint) =>
    set((state) => ({ checkpoints: [...state.checkpoints, checkpoint] })),

  setCheckpoints: (checkpoints) =>
    set({ checkpoints }),

  setSlashCommands: (commands) =>
    set({ slashCommands: commands }),

  setCustomAgents: (agents) =>
    set({ customAgents: agents }),

  reset: () => set(initialState),
}))
