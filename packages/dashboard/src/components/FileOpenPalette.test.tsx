/**
 * FileOpenPalette — tests for the Cmd+P quick-open file palette (#6473).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { FileOpenPalette } from './FileOpenPalette'

const mockFetchFileList = vi.fn()
const mockOpenFileInBrowser = vi.fn()
let mockFiles: any = null

vi.mock('../store/connection', () => {
  const storeState = () => ({
    fetchFileList: mockFetchFileList,
    filePickerFiles: mockFiles,
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
  mockFiles = [
    { path: 'src/index.ts', type: 'file', size: 100 },
    { path: 'src/App.tsx', type: 'file', size: 200 },
    { path: 'README.md', type: 'file', size: 50 },
  ]
})

describe('FileOpenPalette (#6473)', () => {
  it('does not render when closed', () => {
    render(<FileOpenPalette isOpen={false} onClose={() => {}} />)
    expect(screen.queryByTestId('file-open-palette')).toBeNull()
    expect(mockFetchFileList).not.toHaveBeenCalled()
  })

  it('fetches the file list and renders files when opened', async () => {
    render(<FileOpenPalette isOpen={true} onClose={() => {}} />)
    expect(mockFetchFileList).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByTestId('file-open-palette-input')).toBeTruthy()
      expect(screen.getByTestId('file-open-item-src/index.ts')).toBeTruthy()
      expect(screen.getByTestId('file-open-item-README.md')).toBeTruthy()
    })
  })

  it('filters files by the typed query', async () => {
    render(<FileOpenPalette isOpen={true} onClose={() => {}} />)
    const input = await screen.findByTestId('file-open-palette-input')
    fireEvent.change(input, { target: { value: 'readme' } })
    await waitFor(() => {
      expect(screen.getByTestId('file-open-item-README.md')).toBeTruthy()
      expect(screen.queryByTestId('file-open-item-src/index.ts')).toBeNull()
    })
  })

  it('opens the first file on Enter and closes', async () => {
    const onClose = vi.fn()
    render(<FileOpenPalette isOpen={true} onClose={onClose} />)
    const input = await screen.findByTestId('file-open-palette-input')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/index.ts')
    expect(onClose).toHaveBeenCalled()
  })

  it('arrow-down then Enter opens the second file', async () => {
    const onClose = vi.fn()
    render(<FileOpenPalette isOpen={true} onClose={onClose} />)
    const input = await screen.findByTestId('file-open-palette-input')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/App.tsx')
  })

  it('opens a file on click', async () => {
    const onClose = vi.fn()
    render(<FileOpenPalette isOpen={true} onClose={onClose} />)
    const item = await screen.findByTestId('file-open-item-README.md')
    fireEvent.mouseDown(item)
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('README.md')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape without opening a file', async () => {
    const onClose = vi.fn()
    render(<FileOpenPalette isOpen={true} onClose={onClose} />)
    const input = await screen.findByTestId('file-open-palette-input')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(mockOpenFileInBrowser).not.toHaveBeenCalled()
  })

  it('shows an empty state when the filter matches nothing', async () => {
    render(<FileOpenPalette isOpen={true} onClose={() => {}} />)
    const input = await screen.findByTestId('file-open-palette-input')
    fireEvent.change(input, { target: { value: 'zzz-no-match' } })
    await waitFor(() => expect(screen.getByTestId('file-open-palette-empty')).toBeTruthy())
  })
})
