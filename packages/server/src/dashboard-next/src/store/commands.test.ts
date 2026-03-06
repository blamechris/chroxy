import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCommands, getMruCommands, recordMruCommand, useMruStore } from './commands'

// Mock the connection store
const mockStore = {
  connectionPhase: 'connected' as const,
  setViewMode: vi.fn(),
  sendInterrupt: vi.fn(),
  availableModels: [
    { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet' },
    { id: 'opus', label: 'Opus', fullId: 'claude-opus' },
  ],
  setModel: vi.fn(),
  sessions: [
    { sessionId: 's1', name: 'Session 1', cwd: '/tmp', type: 'cli' as const, hasTerminal: false, model: null, permissionMode: null, isBusy: false, createdAt: 1, conversationId: null },
  ],
  activeSessionId: 's1',
  viewMode: 'chat' as const,
}

vi.mock('./connection', () => ({
  useConnectionStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}))

afterEach(() => {
  vi.clearAllMocks()
  useMruStore.setState({ mruList: [] })
})

describe('useCommands', () => {
  it('returns commands array', () => {
    const { result } = renderHook(() => useCommands())
    expect(Array.isArray(result.current)).toBe(true)
    expect(result.current.length).toBeGreaterThan(0)
  })

  it('includes view commands', () => {
    const { result } = renderHook(() => useCommands())
    const names = result.current.map(c => c.name)
    expect(names).toContain('Switch to Chat')
    expect(names).toContain('Switch to Terminal')
  })

  it('includes session commands', () => {
    const { result } = renderHook(() => useCommands())
    const names = result.current.map(c => c.name)
    expect(names).toContain('New Session')
    expect(names).toContain('Interrupt')
  })

  it('assigns correct categories', () => {
    const { result } = renderHook(() => useCommands())
    const chatCmd = result.current.find(c => c.name === 'Switch to Chat')
    expect(chatCmd?.category).toBe('View')
    const interruptCmd = result.current.find(c => c.name === 'Interrupt')
    expect(interruptCmd?.category).toBe('Session')
  })

  it('wires view command actions to store', () => {
    const { result } = renderHook(() => useCommands())
    const chatCmd = result.current.find(c => c.name === 'Switch to Chat')!
    chatCmd.action()
    expect(mockStore.setViewMode).toHaveBeenCalledWith('chat')
  })

  it('wires interrupt to sendInterrupt', () => {
    const { result } = renderHook(() => useCommands())
    const cmd = result.current.find(c => c.name === 'Interrupt')!
    cmd.action()
    expect(mockStore.sendInterrupt).toHaveBeenCalled()
  })

  it('has unique command ids', () => {
    const { result } = renderHook(() => useCommands())
    const ids = result.current.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('MRU tracking', () => {
  beforeEach(() => {
    useMruStore.setState({ mruList: [] })
  })

  it('records command usage', () => {
    recordMruCommand('switch-chat')
    const mru = getMruCommands()
    expect(mru).toContain('switch-chat')
  })

  it('returns most recent first', () => {
    recordMruCommand('cmd-a')
    recordMruCommand('cmd-b')
    recordMruCommand('cmd-c')
    const mru = getMruCommands()
    expect(mru[0]).toBe('cmd-c')
  })

  it('deduplicates entries', () => {
    recordMruCommand('cmd-a')
    recordMruCommand('cmd-b')
    recordMruCommand('cmd-a')
    const mru = getMruCommands()
    expect(mru.filter(id => id === 'cmd-a')).toHaveLength(1)
    expect(mru[0]).toBe('cmd-a')
  })

  it('limits to 10 entries', () => {
    for (let i = 0; i < 15; i++) {
      recordMruCommand(`cmd-${i}`)
    }
    const mru = getMruCommands()
    expect(mru).toHaveLength(10)
  })

  it('exposes state via Zustand store', () => {
    recordMruCommand('test-cmd')
    const state = useMruStore.getState()
    expect(state.mruList).toContain('test-cmd')
  })
})
