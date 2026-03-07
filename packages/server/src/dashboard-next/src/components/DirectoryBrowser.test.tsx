/**
 * DirectoryBrowser — file system browser for new session directory selection (#1434)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DirectoryBrowser } from './DirectoryBrowser'
import type { DirectoryEntry } from '../store/types'

afterEach(cleanup)

const MOCK_ENTRIES: DirectoryEntry[] = [
  { name: 'projects', isDirectory: true },
  { name: 'documents', isDirectory: true },
  { name: '.config', isDirectory: true },
  { name: 'readme.txt', isDirectory: false },
]

describe('DirectoryBrowser', () => {
  it('renders with initial path and breadcrumb', () => {
    render(
      <DirectoryBrowser

        entries={MOCK_ENTRIES}
        currentPath="/home/user"
        loading={false}
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText(/home/)).toBeInTheDocument()
    expect(screen.getByText(/user/)).toBeInTheDocument()
  })

  it('shows only directories (not files)', () => {
    render(
      <DirectoryBrowser

        entries={MOCK_ENTRIES}
        currentPath="/home/user"
        loading={false}
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('projects')).toBeInTheDocument()
    expect(screen.getByText('documents')).toBeInTheDocument()
    expect(screen.queryByText('readme.txt')).not.toBeInTheDocument()
  })

  it('calls onNavigate when a directory entry is clicked', () => {
    const onNavigate = vi.fn()
    render(
      <DirectoryBrowser

        entries={MOCK_ENTRIES}
        currentPath="/home/user"
        loading={false}
        onNavigate={onNavigate}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('projects'))
    expect(onNavigate).toHaveBeenCalledWith('/home/user/projects')
  })

  it('calls onSelect with current path when Select clicked', () => {
    const onSelect = vi.fn()
    render(
      <DirectoryBrowser

        entries={MOCK_ENTRIES}
        currentPath="/home/user"
        loading={false}
        onNavigate={vi.fn()}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /select/i }))
    expect(onSelect).toHaveBeenCalledWith('/home/user')
  })

  it('calls onCancel when Cancel clicked', () => {
    const onCancel = vi.fn()
    render(
      <DirectoryBrowser

        entries={MOCK_ENTRIES}
        currentPath="/home/user"
        loading={false}
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('shows loading state', () => {
    render(
      <DirectoryBrowser

        entries={[]}
        currentPath="/home/user"
        loading={true}
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('navigates to parent via breadcrumb click', () => {
    const onNavigate = vi.fn()
    render(
      <DirectoryBrowser

        entries={MOCK_ENTRIES}
        currentPath="/home/user/projects"
        loading={false}
        onNavigate={onNavigate}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    // Click 'user' breadcrumb segment to navigate up
    fireEvent.click(screen.getByText('user'))
    expect(onNavigate).toHaveBeenCalledWith('/home/user')
  })

  it('navigates to root via root breadcrumb', () => {
    const onNavigate = vi.fn()
    render(
      <DirectoryBrowser

        entries={MOCK_ENTRIES}
        currentPath="/home/user"
        loading={false}
        onNavigate={onNavigate}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    // Click root breadcrumb button (the only "/" that is a button)
    const rootBtn = screen.getAllByText('/').find(el => el.tagName === 'BUTTON')
    expect(rootBtn).toBeTruthy()
    fireEvent.click(rootBtn!)
    expect(onNavigate).toHaveBeenCalledWith('/')
  })

  it('shows empty state when no directories', () => {
    render(
      <DirectoryBrowser

        entries={[{ name: 'file.txt', isDirectory: false }]}
        currentPath="/empty"
        loading={false}
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText(/no subdirectories/i)).toBeInTheDocument()
  })

  it('has accessible navigation role', () => {
    render(
      <DirectoryBrowser

        entries={MOCK_ENTRIES}
        currentPath="/home"
        loading={false}
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByRole('navigation', { name: /breadcrumb/i })).toBeInTheDocument()
  })

  it('has accessible list role for entries', () => {
    render(
      <DirectoryBrowser

        entries={MOCK_ENTRIES}
        currentPath="/home"
        loading={false}
        onNavigate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByRole('list')).toBeInTheDocument()
  })
})
