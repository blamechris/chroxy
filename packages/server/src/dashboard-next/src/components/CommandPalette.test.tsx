import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CommandPalette, type Command } from './CommandPalette'

afterEach(cleanup)

const mockCommands: Command[] = [
  { id: 'new-session', name: 'New Session', category: 'Session', shortcut: 'Cmd+N', action: vi.fn() },
  { id: 'switch-chat', name: 'Switch to Chat', category: 'View', action: vi.fn() },
  { id: 'switch-terminal', name: 'Switch to Terminal', category: 'View', action: vi.fn() },
  { id: 'change-model', name: 'Change Model', category: 'Settings', action: vi.fn() },
  { id: 'toggle-theme', name: 'Toggle Theme', category: 'Settings', action: vi.fn() },
]

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    render(<CommandPalette commands={mockCommands} isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument()
  })

  it('renders command list when open', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByTestId('command-palette')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('displays commands grouped by category', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('Session')).toBeInTheDocument()
    expect(screen.getByText('View')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('shows all command names', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('New Session')).toBeInTheDocument()
    expect(screen.getByText('Switch to Chat')).toBeInTheDocument()
    expect(screen.getByText('Toggle Theme')).toBeInTheDocument()
  })

  it('shows keyboard shortcuts when provided', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('Cmd+N')).toBeInTheDocument()
  })

  it('filters commands by search query', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'switch' } })
    expect(screen.getByText('Switch to Chat')).toBeInTheDocument()
    expect(screen.getByText('Switch to Terminal')).toBeInTheDocument()
    expect(screen.queryByText('New Session')).not.toBeInTheDocument()
    expect(screen.queryByText('Toggle Theme')).not.toBeInTheDocument()
  })

  it('filters case-insensitively', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'MODEL' } })
    expect(screen.getByText('Change Model')).toBeInTheDocument()
    expect(screen.queryByText('New Session')).not.toBeInTheDocument()
  })

  it('navigates with arrow keys', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox')
    // First item selected by default
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    // Arrow down moves selection
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('wraps selection at boundaries', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox')
    // Arrow up from first item wraps to last
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    const options = screen.getAllByRole('option')
    expect(options[options.length - 1]).toHaveAttribute('aria-selected', 'true')
  })

  it('executes command on Enter', () => {
    const onClose = vi.fn()
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={onClose} />)
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockCommands[0]!.action).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={onClose} />)
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('executes command on click', () => {
    const onClose = vi.fn()
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={onClose} />)
    fireEvent.click(screen.getByText('Toggle Theme'))
    const toggleTheme = mockCommands.find(c => c.id === 'toggle-theme')!
    expect(toggleTheme.action).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on backdrop click', () => {
    const onClose = vi.fn()
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={onClose} />)
    const backdrop = screen.getByTestId('command-palette-backdrop')
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows empty state when no commands match', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'xyznonexistent' } })
    expect(screen.getByText('No matching commands')).toBeInTheDocument()
  })

  it('uses listbox role for accessibility', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('focuses search input on open', () => {
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByRole('combobox')).toHaveFocus()
  })

  it('sorts commands within categories by MRU order', () => {
    const mruList = ['toggle-theme', 'switch-terminal']
    render(<CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} mruList={mruList} />)
    // Within Settings category: toggle-theme (MRU) should come before change-model
    const options = screen.getAllByRole('option')
    const names = options.map(opt => opt.textContent?.replace(/Cmd\+\w+/, '').trim())
    const settingsStart = names.indexOf('Toggle Theme')
    const changeModelIdx = names.indexOf('Change Model')
    expect(settingsStart).toBeLessThan(changeModelIdx!)
    // Within View category: switch-terminal (MRU) should come before switch-chat
    const terminalIdx = names.indexOf('Switch to Terminal')
    const chatIdx = names.indexOf('Switch to Chat')
    expect(terminalIdx).toBeLessThan(chatIdx!)
  })

  it('integration: execute command → reopen → MRU reorders', () => {
    // Simulate full flow: open palette with no MRU, execute command, reopen with updated MRU
    const mruList: string[] = []
    const onClose = vi.fn()

    // First render: no MRU, default order (Change Model before Toggle Theme)
    const { unmount } = render(
      <CommandPalette commands={mockCommands} isOpen={true} onClose={onClose} mruList={mruList} />,
    )
    let options = screen.getAllByRole('option')
    let names = options.map(opt => opt.textContent?.replace(/Cmd\+\w+/, '').trim())
    expect(names.indexOf('Change Model')).toBeLessThan(names.indexOf('Toggle Theme')!)

    // Execute "Toggle Theme" — this records it as MRU
    fireEvent.click(screen.getByText('Toggle Theme'))
    mruList.unshift('toggle-theme')
    unmount()

    // Reopen palette with updated MRU
    render(
      <CommandPalette commands={mockCommands} isOpen={true} onClose={vi.fn()} mruList={[...mruList]} />,
    )
    options = screen.getAllByRole('option')
    names = options.map(opt => opt.textContent?.replace(/Cmd\+\w+/, '').trim())
    // Toggle Theme should now appear before Change Model in Settings
    expect(names.indexOf('Toggle Theme')).toBeLessThan(names.indexOf('Change Model')!)
  })
})
