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

  it('renders source group headers (chat redesign #6391)', () => {
    render(
      <SlashCommandPicker
        commands={[
          { name: 'clear', description: 'Clear', source: 'builtin' as const },
          { name: 'commit', description: 'Commit', source: 'project' as const },
          { name: 'learn', description: 'Learn', source: 'user' as const },
        ]}
        filter=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Built-in')).toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(screen.getByText('User')).toBeInTheDocument()
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

  // -------------------------------------------------------------------------
  // #3856 — built-ins must surface alongside user/project skills with a
  // distinguishing badge and pinned-to-top ordering.
  // -------------------------------------------------------------------------
  describe('built-in commands (#3856)', () => {
    const mixedCommands = [
      // Server ranks built-ins first, then project, then user. We pass the
      // commands in that exact order to mirror the real wire payload.
      { name: 'clear', description: 'Clear conversation history', source: 'builtin' as const },
      { name: 'compact', description: 'Compact conversation', source: 'builtin' as const },
      { name: 'model', description: 'Switch model', source: 'builtin' as const },
      { name: 'commit', description: 'Create a git commit', source: 'project' as const },
      { name: 'learn', description: 'Capture learnings', source: 'user' as const },
    ]

    it('renders built-ins alongside user-defined commands', () => {
      render(
        <SlashCommandPicker
          commands={mixedCommands}
          filter=""
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      )
      // Both kinds present.
      expect(screen.getByText('/clear')).toBeInTheDocument()
      expect(screen.getByText('/compact')).toBeInTheDocument()
      expect(screen.getByText('/model')).toBeInTheDocument()
      expect(screen.getByText('/commit')).toBeInTheDocument()
      expect(screen.getByText('/learn')).toBeInTheDocument()
    })

    it('shows a "built-in" badge on provider-baked rows', () => {
      render(
        <SlashCommandPicker
          commands={mixedCommands}
          filter=""
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      )
      // One badge per built-in (3 total). Project rows stay badge-less.
      const badges = screen.getAllByText('built-in')
      expect(badges.length).toBe(3)
    })

    it('renders built-ins above user/project entries in DOM order', () => {
      render(
        <SlashCommandPicker
          commands={mixedCommands}
          filter=""
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      )
      const items = screen.getAllByRole('option')
      expect(items.length).toBe(5)
      // First three options are the built-ins, in the order they were passed.
      expect(items[0]?.textContent).toContain('/clear')
      expect(items[1]?.textContent).toContain('/compact')
      expect(items[2]?.textContent).toContain('/model')
      // Project / user follow.
      expect(items[3]?.textContent).toContain('/commit')
      expect(items[4]?.textContent).toContain('/learn')
    })

    it('filter still narrows across built-ins and user commands', () => {
      render(
        <SlashCommandPicker
          commands={mixedCommands}
          filter="com"
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      )
      // "com" matches /compact (built-in) by name and /commit (project) by name.
      // The picker filters on both name and description, but neither /clear
      // ("Clear conversation history") nor /learn ("Capture learnings")
      // contains "com" anywhere.
      expect(screen.getByText('/compact')).toBeInTheDocument()
      expect(screen.getByText('/commit')).toBeInTheDocument()
      expect(screen.queryByText('/clear')).not.toBeInTheDocument()
      expect(screen.queryByText('/learn')).not.toBeInTheDocument()
    })
  })

  // #6823 — MCP-server prompts render with an "mcp" badge + "MCP" group header.
  describe('MCP prompts', () => {
    const withMcp = [
      { name: 'commit', description: 'Create a git commit', source: 'project' as const },
      { name: 'mcp__stub__greet', description: 'Greet someone', source: 'mcp' as const },
    ]

    it('renders MCP prompt rows with the mcp badge and MCP group header', () => {
      render(
        <SlashCommandPicker commands={withMcp} filter="" onSelect={vi.fn()} onClose={vi.fn()} />
      )
      expect(screen.getByText('/mcp__stub__greet')).toBeInTheDocument()
      expect(screen.getByText('mcp')).toBeInTheDocument()
      expect(screen.getByText('MCP')).toBeInTheDocument()
    })

    it('selecting an MCP prompt fires onSelect with its full namespaced name', () => {
      const onSelect = vi.fn()
      render(
        <SlashCommandPicker commands={withMcp} filter="" onSelect={onSelect} onClose={vi.fn()} />
      )
      fireEvent.click(screen.getByText('/mcp__stub__greet'))
      expect(onSelect).toHaveBeenCalledWith('mcp__stub__greet')
    })
  })
})
