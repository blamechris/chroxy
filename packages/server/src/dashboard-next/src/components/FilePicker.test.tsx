/**
 * FilePicker component tests (#1286)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FilePicker, type FilePickerItem } from './FilePicker'

afterEach(cleanup)

const mockFiles: FilePickerItem[] = [
  { path: 'src/index.ts', type: 'file', size: 1024 },
  { path: 'src/utils/helpers.ts', type: 'file', size: 512 },
  { path: 'README.md', type: 'file', size: 256 },
  { path: 'package.json', type: 'file', size: 128 },
]

describe('FilePicker', () => {
  it('renders file list', () => {
    render(
      <FilePicker
        files={mockFiles}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    expect(screen.getByText('src/index.ts')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('filters files by path substring', () => {
    render(
      <FilePicker
        files={mockFiles}
        filter="helper"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    expect(screen.getByText('src/utils/helpers.ts')).toBeInTheDocument()
    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
  })

  it('filter is case-insensitive', () => {
    render(
      <FilePicker
        files={mockFiles}
        filter="README"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('shows empty state when no files match filter', () => {
    render(
      <FilePicker
        files={mockFiles}
        filter="nonexistent"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    expect(screen.getByText('No files found')).toBeInTheDocument()
  })

  it('shows loading state when files is null', () => {
    render(
      <FilePicker
        files={null}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    expect(screen.getByText('Loading files...')).toBeInTheDocument()
  })

  it('calls onSelect with file path when clicked', () => {
    const onSelect = vi.fn()
    render(
      <FilePicker
        files={mockFiles}
        filter=""
        onSelect={onSelect}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    fireEvent.click(screen.getByText('README.md'))
    expect(onSelect).toHaveBeenCalledWith('README.md')
  })

  it('highlights selected index', () => {
    render(
      <FilePicker
        files={mockFiles}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={1}
      />
    )
    const items = screen.getAllByRole('option')
    expect(items[1]).toHaveAttribute('aria-selected', 'true')
    expect(items[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('has listbox role for accessibility', () => {
    render(
      <FilePicker
        files={mockFiles}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('closes on click outside', () => {
    const onClose = vi.fn()
    render(
      <div>
        <div data-testid="outside">outside</div>
        <FilePicker
          files={mockFiles}
          filter=""
          onSelect={vi.fn()}
          onClose={onClose}
          selectedIndex={0}
        />
      </div>
    )
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows file size in human-readable format', () => {
    render(
      <FilePicker
        files={[{ path: 'big.js', type: 'file', size: 2048 }]}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
  })
})
