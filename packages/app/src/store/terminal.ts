import { create } from 'zustand'
import { stripAnsi } from './utils'

interface TerminalState {
  terminalBuffer: string
  terminalRawBuffer: string

  appendTerminalData: (data: string) => void
  clearTerminalBuffer: () => void
  reset: () => void
}

const TERMINAL_BUFFER_CAP = 50000
const TERMINAL_RAW_BUFFER_CAP = 100000

const initialState = {
  terminalBuffer: '',
  terminalRawBuffer: '',
}

export const useTerminalStore = create<TerminalState>((set) => ({
  ...initialState,

  appendTerminalData: (data) =>
    set((state) => ({
      terminalBuffer: (state.terminalBuffer + stripAnsi(data)).slice(-TERMINAL_BUFFER_CAP),
      terminalRawBuffer: (state.terminalRawBuffer + data).slice(-TERMINAL_RAW_BUFFER_CAP),
    })),

  clearTerminalBuffer: () =>
    set({ terminalBuffer: '', terminalRawBuffer: '' }),

  reset: () => set(initialState),
}))
