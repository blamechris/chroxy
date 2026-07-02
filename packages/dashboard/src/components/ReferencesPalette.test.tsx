/**
 * ReferencesPalette — tests for the find-all-references result list (#6477).
 * Opened by alt+click; no query input — the symbol is fixed by the click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ReferencesPalette } from './ReferencesPalette'

const mockOpenFileInBrowser = vi.fn()
let mockReferencesResult: any = null
let mockReferencesLoading = false
let mockReferencesSymbol = ''

vi.mock('../store/connection', () => {
  const storeState = () => ({
    referencesResult: mockReferencesResult,
    referencesLoading: mockReferencesLoading,
    referencesSymbol: mockReferencesSymbol,
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
  mockReferencesLoading = false
  mockReferencesSymbol = 'widget'
  mockReferencesResult = {
    symbol: 'widget', truncated: false, error: null,
    results: [
      { file: 'src/a.ts', line: 3, column: 7, text: 'const widget = 1' },
      { file: 'src/b.ts', line: 9, column: 1, text: 'widget()' },
    ],
  }
})

describe('ReferencesPalette (#6477)', () => {
  it('does not render when closed', () => {
    render(<ReferencesPalette isOpen={false} onClose={() => {}} />)
    expect(screen.queryByTestId('references-palette')).toBeNull()
  })

  it('shows the queried symbol in the header + the result count', () => {
    render(<ReferencesPalette isOpen={true} onClose={() => {}} />)
    const header = screen.getByTestId('references-header')
    expect(header.textContent).toContain('widget')
    expect(header.textContent).toContain('2')
  })

  it('renders a row per referencing site', () => {
    render(<ReferencesPalette isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId('references-item-0')).toBeTruthy()
    expect(screen.getByTestId('references-item-1')).toBeTruthy()
  })

  it('shows "Searching…" while loading', () => {
    mockReferencesLoading = true
    render(<ReferencesPalette isOpen={true} onClose={() => {}} />)
    expect(screen.getByText('Searching…')).toBeTruthy()
    expect(screen.queryByTestId('references-item-0')).toBeNull()
  })

  it('ignores a stale result whose symbol does not match the requested one', () => {
    mockReferencesSymbol = 'somethingElse'
    render(<ReferencesPalette isOpen={true} onClose={() => {}} />)
    // The stored result is for `widget`, not `somethingElse` → treated as not-current.
    expect(screen.queryByTestId('references-item-0')).toBeNull()
  })

  it('shows "No references found" for a current empty result', () => {
    mockReferencesResult = { symbol: 'widget', truncated: false, error: null, results: [] }
    render(<ReferencesPalette isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId('references-empty')).toBeTruthy()
  })

  it('opens the file at the site on Enter, then closes', async () => {
    const onClose = vi.fn()
    render(<ReferencesPalette isOpen={true} onClose={onClose} />)
    const list = await screen.findByRole('listbox')
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/a.ts', 3)
    expect(onClose).toHaveBeenCalled()
  })

  it('arrow-down then Enter opens the second site', async () => {
    render(<ReferencesPalette isOpen={true} onClose={() => {}} />)
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/b.ts', 9)
  })

  it('opens a site on click', async () => {
    render(<ReferencesPalette isOpen={true} onClose={() => {}} />)
    fireEvent.mouseDown(await screen.findByTestId('references-item-1'))
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/b.ts', 9)
  })

  it('closes on Escape without opening anything', () => {
    const onClose = vi.fn()
    render(<ReferencesPalette isOpen={true} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(mockOpenFileInBrowser).not.toHaveBeenCalled()
  })
})
