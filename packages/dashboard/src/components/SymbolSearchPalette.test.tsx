/**
 * SymbolSearchPalette — tests for the Cmd+Shift+O fuzzy symbol search (#6476).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SymbolSearchPalette } from './SymbolSearchPalette'

const mockRequestWorkspaceSymbols = vi.fn()
const mockOpenFileInBrowser = vi.fn()
let mockWorkspaceSymbols: any = null

vi.mock('../store/connection', () => {
  const storeState = () => ({
    requestWorkspaceSymbols: mockRequestWorkspaceSymbols,
    workspaceSymbols: mockWorkspaceSymbols,
    openFileInBrowser: mockOpenFileInBrowser,
  })
  const useConnectionStore = Object.assign(
    (selector: any) => selector(storeState()),
    { getState: () => storeState(), setState: () => {} },
  )
  return { useConnectionStore }
})

afterEach(() => cleanup())
beforeEach(() => {
  vi.clearAllMocks()
  mockWorkspaceSymbols = {
    path: null, truncated: false, error: null,
    symbols: [
      { name: 'parseSymbols', kind: 'function', file: 'src/ide/symbols.js', line: 42, exported: true },
      { name: 'Widget', kind: 'class', file: 'src/ui/Widget.tsx', line: 10, exported: true },
      { name: 'helper', kind: 'function', file: 'src/util.ts', line: 5, exported: false },
    ],
  }
})

describe('SymbolSearchPalette (#6476)', () => {
  it('does not render when closed', () => {
    render(<SymbolSearchPalette isOpen={false} onClose={() => {}} />)
    expect(screen.queryByTestId('symbol-search-palette')).toBeNull()
    expect(mockRequestWorkspaceSymbols).not.toHaveBeenCalled()
  })

  it('requests the workspace symbols and renders them when opened', async () => {
    render(<SymbolSearchPalette isOpen={true} onClose={() => {}} />)
    expect(mockRequestWorkspaceSymbols).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByTestId('symbol-search-item-parseSymbols')).toBeTruthy()
      expect(screen.getByTestId('symbol-search-item-Widget')).toBeTruthy()
    })
  })

  it('filters symbols by the typed query', async () => {
    render(<SymbolSearchPalette isOpen={true} onClose={() => {}} />)
    const input = await screen.findByTestId('symbol-search-input')
    fireEvent.change(input, { target: { value: 'widget' } })
    await waitFor(() => {
      expect(screen.getByTestId('symbol-search-item-Widget')).toBeTruthy()
      expect(screen.queryByTestId('symbol-search-item-parseSymbols')).toBeNull()
    })
  })

  it('jumps to file:line on Enter (opens the file at the symbol line)', async () => {
    const onClose = vi.fn()
    render(<SymbolSearchPalette isOpen={true} onClose={onClose} />)
    const input = await screen.findByTestId('symbol-search-input')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/ide/symbols.js', 42)
    expect(onClose).toHaveBeenCalled()
  })

  it('arrow-down then Enter jumps to the second symbol', async () => {
    render(<SymbolSearchPalette isOpen={true} onClose={() => {}} />)
    const input = await screen.findByTestId('symbol-search-input')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/ui/Widget.tsx', 10)
  })

  it('jumps on click', async () => {
    const onClose = vi.fn()
    render(<SymbolSearchPalette isOpen={true} onClose={onClose} />)
    const item = await screen.findByTestId('symbol-search-item-helper')
    fireEvent.mouseDown(item)
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/util.ts', 5)
  })

  it('closes on Escape without jumping', async () => {
    const onClose = vi.fn()
    render(<SymbolSearchPalette isOpen={true} onClose={onClose} />)
    const input = await screen.findByTestId('symbol-search-input')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(mockOpenFileInBrowser).not.toHaveBeenCalled()
  })
})
