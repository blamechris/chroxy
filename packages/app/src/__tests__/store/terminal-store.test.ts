import { useTerminalStore } from '../../store/terminal'

describe('TerminalStore', () => {
  beforeEach(() => {
    useTerminalStore.getState().reset()
  })

  it('initializes with empty buffers', () => {
    const state = useTerminalStore.getState()
    expect(state.terminalBuffer).toBe('')
    expect(state.terminalRawBuffer).toBe('')
  })

  it('appends to terminal buffers', () => {
    useTerminalStore.getState().appendTerminalData('hello world')
    const state = useTerminalStore.getState()
    expect(state.terminalBuffer).toBe('hello world')
    expect(state.terminalRawBuffer).toBe('hello world')
  })

  it('strips ANSI from terminalBuffer but keeps raw', () => {
    useTerminalStore.getState().appendTerminalData('\x1b[32mgreen\x1b[0m')
    const state = useTerminalStore.getState()
    expect(state.terminalBuffer).toBe('green')
    expect(state.terminalRawBuffer).toBe('\x1b[32mgreen\x1b[0m')
  })

  it('accumulates multiple appends', () => {
    useTerminalStore.getState().appendTerminalData('line1\n')
    useTerminalStore.getState().appendTerminalData('line2\n')
    const state = useTerminalStore.getState()
    expect(state.terminalBuffer).toBe('line1\nline2\n')
    expect(state.terminalRawBuffer).toBe('line1\nline2\n')
  })

  it('caps terminalBuffer at 50KB', () => {
    const bigData = 'x'.repeat(60000)
    useTerminalStore.getState().appendTerminalData(bigData)
    expect(useTerminalStore.getState().terminalBuffer.length).toBeLessThanOrEqual(50000)
  })

  it('caps terminalRawBuffer at 100KB', () => {
    const bigData = 'x'.repeat(110000)
    useTerminalStore.getState().appendTerminalData(bigData)
    expect(useTerminalStore.getState().terminalRawBuffer.length).toBeLessThanOrEqual(100000)
  })

  it('clears terminal buffers', () => {
    useTerminalStore.getState().appendTerminalData('some data')
    useTerminalStore.getState().clearTerminalBuffer()
    const state = useTerminalStore.getState()
    expect(state.terminalBuffer).toBe('')
    expect(state.terminalRawBuffer).toBe('')
  })

  it('resets to initial state', () => {
    useTerminalStore.getState().appendTerminalData('test data')
    useTerminalStore.getState().reset()
    const state = useTerminalStore.getState()
    expect(state.terminalBuffer).toBe('')
    expect(state.terminalRawBuffer).toBe('')
  })
})
