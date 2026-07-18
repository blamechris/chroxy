/**
 * FilePicker component tests (#1286)
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FilePicker, type FilePickerItem } from './FilePicker'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

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

  it('scrolls selected item into view on selectedIndex change', () => {
    const { rerender } = render(
      <FilePicker
        files={mockFiles}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )

    ;(Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear()

    rerender(
      <FilePicker
        files={mockFiles}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={2}
      />
    )

    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('caps display at 200 items with overflow indicator', () => {
    const manyFiles: FilePickerItem[] = Array.from({ length: 300 }, (_, i) => ({
      path: `src/file${i.toString().padStart(3, '0')}.ts`,
      type: 'file' as const,
      size: 100,
    }))
    render(
      <FilePicker
        files={manyFiles}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    const items = screen.getAllByRole('option')
    expect(items.length).toBe(200)
    expect(screen.getByText(/100 more files/)).toBeInTheDocument()
  })

  it('does not show overflow indicator when under cap', () => {
    render(
      <FilePicker
        files={mockFiles}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        selectedIndex={0}
      />
    )
    expect(screen.queryByText(/more files/)).not.toBeInTheDocument()
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

  // #6823 — MCP resources in the @-picker.
  describe('MCP resources', () => {
    const resources = [
      { uri: 'file:///notes.md', name: 'Notes', server: 'stub' },
      { uri: 'db://users', name: 'Users', server: 'stub' },
    ]

    it('renders a "MCP Resources" section with resource rows', () => {
      render(
        <FilePicker
          files={mockFiles}
          resources={resources}
          filter=""
          onSelect={vi.fn()}
          onSelectResource={vi.fn()}
          onClose={vi.fn()}
          selectedIndex={0}
        />
      )
      expect(screen.getByTestId('file-picker-resources-group')).toBeInTheDocument()
      expect(screen.getByText('Notes')).toBeInTheDocument()
      expect(screen.getByText('Users')).toBeInTheDocument()
    })

    it('clicking a resource fires onSelectResource with its uri', () => {
      const onSelectResource = vi.fn()
      render(
        <FilePicker
          files={[]}
          resources={resources}
          filter=""
          onSelect={vi.fn()}
          onSelectResource={onSelectResource}
          onClose={vi.fn()}
          selectedIndex={0}
        />
      )
      fireEvent.click(screen.getByText('Users'))
      expect(onSelectResource).toHaveBeenCalledWith('db://users')
    })

    it('filters resources by uri or name', () => {
      render(
        <FilePicker
          files={[]}
          resources={resources}
          filter="notes"
          onSelect={vi.fn()}
          onSelectResource={vi.fn()}
          onClose={vi.fn()}
          selectedIndex={0}
        />
      )
      expect(screen.getByText('Notes')).toBeInTheDocument()
      expect(screen.queryByText('Users')).not.toBeInTheDocument()
    })

    it('the resource highlight index continues after the files (flat nav)', () => {
      // 4 files (indices 0-3) then the first resource at index 4.
      render(
        <FilePicker
          files={mockFiles}
          resources={resources}
          filter=""
          onSelect={vi.fn()}
          onSelectResource={vi.fn()}
          onClose={vi.fn()}
          selectedIndex={4}
        />
      )
      const rows = screen.getAllByTestId('file-picker-resource')
      expect(rows[0]!.className).toContain('selected')
    })

    it('with >200 files the resource index continues after the CAPPED rows, not the full list (#6844 review)', () => {
      // 250 files → the DOM renders only 200 file rows (display cap) + the
      // overflow hint, then the resource section. Arrow-down past the last
      // rendered file row lands on the first resource at flat index 200 —
      // NOT at 250 (the uncapped length, which desynced highlight/scroll).
      const manyFiles: FilePickerItem[] = Array.from({ length: 250 }, (_, i) => ({
        path: `src/file-${String(i).padStart(3, '0')}.ts`,
        type: 'file',
        size: 1,
      }))
      render(
        <FilePicker
          files={manyFiles}
          resources={resources}
          filter=""
          onSelect={vi.fn()}
          onSelectResource={vi.fn()}
          onClose={vi.fn()}
          selectedIndex={200}
        />
      )
      const resourceRows = screen.getAllByTestId('file-picker-resource')
      expect(resourceRows[0]!.className).toContain('selected')
      expect(resourceRows[0]!.getAttribute('aria-selected')).toBe('true')
      // Exactly one option is highlighted — no file row shares index 200.
      const selected = document.querySelectorAll('[role="option"][aria-selected="true"]')
      expect(selected.length).toBe(1)
    })
  })
})
