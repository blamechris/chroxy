/**
 * SlashCommandPicker tests (#1281)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SlashCommandPicker } from './SlashCommandPicker'

afterEach(cleanup)

const mockCommands = [
  { name: 'commit', description: 'Create a git commit', source: 'project' as const },
  { name: 'review-pr', description: 'Review a pull request', source: 'project' as const },
  { name: 'learn', description: 'Capture learnings from session', source: 'user' as const },
  { name: 'fix-ci', description: 'Fix CI failures', source: 'user' as const },
]

describe('SlashCommandPicker', () => {
  it('renders list of commands', () => {
    render(
      <SlashCommandPicker
        commands={mockCommands}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('/commit')).toBeInTheDocument()
    expect(screen.getByText('/review-pr')).toBeInTheDocument()
    expect(screen.getByText('/learn')).toBeInTheDocument()
    expect(screen.getByText('/fix-ci')).toBeInTheDocument()
  })

  it('shows command descriptions', () => {
    render(
      <SlashCommandPicker
        commands={mockCommands}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Create a git commit')).toBeInTheDocument()
    expect(screen.getByText('Review a pull request')).toBeInTheDocument()
  })

  it('filters commands by name', () => {
    render(
      <SlashCommandPicker
        commands={mockCommands}
        filter="com"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('/commit')).toBeInTheDocument()
    expect(screen.queryByText('/review-pr')).not.toBeInTheDocument()
    expect(screen.queryByText('/learn')).not.toBeInTheDocument()
  })

  it('filters commands by description', () => {
    render(
      <SlashCommandPicker
        commands={mockCommands}
        filter="pull"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('/review-pr')).toBeInTheDocument()
    expect(screen.queryByText('/commit')).not.toBeInTheDocument()
  })

  it('calls onSelect with command name on click', () => {
    const onSelect = vi.fn()
    render(
      <SlashCommandPicker
        commands={mockCommands}
        filter=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('/commit'))
    expect(onSelect).toHaveBeenCalledWith('commit')
  })

  it('shows empty state when no commands match', () => {
    render(
      <SlashCommandPicker
        commands={mockCommands}
        filter="zzzzz"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(/no commands found/i)).toBeInTheDocument()
  })

  it('shows empty state when commands array is empty', () => {
    render(
      <SlashCommandPicker
        commands={[]}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(/no commands/i)).toBeInTheDocument()
  })

  it('highlights selected index', () => {
    render(
      <SlashCommandPicker
        commands={mockCommands}
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

  it('shows source badge for user commands', () => {
    render(
      <SlashCommandPicker
        commands={mockCommands}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    const badges = screen.getAllByText('user')
    expect(badges.length).toBeGreaterThan(0)
  })

  it('has accessible listbox role', () => {
    render(
      <SlashCommandPicker
        commands={mockCommands}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})
