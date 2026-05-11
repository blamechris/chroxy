/**
 * ToolGroup component tests (#3747).
 *
 * Covers the collapsible block that wraps a contiguous run of tool calls:
 * header summary + tool-type breakdown, default-state rules (collapsed when
 * done, expanded while active), keyboard accessibility, and the
 * thinking-message presentation.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ChatMessage } from '@chroxy/store-core'
import { ToolGroup } from './ToolGroup'

afterEach(cleanup)

function tool(id: string, name: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'tool_use',
    content: '',
    timestamp: 0,
    tool: name,
    ...extra,
  }
}

function thinking(id: string): ChatMessage {
  return { id, type: 'thinking', content: '', timestamp: 0 }
}

describe('ToolGroup', () => {
  it('renders the summary with tool-type breakdown', () => {
    const messages = [
      tool('1', 'Bash'),
      tool('2', 'Bash'),
      tool('3', 'Read'),
    ]
    render(<ToolGroup messages={messages} isActive={false} />)
    expect(screen.getByText(/3 tools used/)).toBeInTheDocument()
    expect(screen.getByText(/2 Bash, 1 Read/)).toBeInTheDocument()
  })

  it('uses singular "tool" when there is one tool', () => {
    render(<ToolGroup messages={[tool('1', 'Bash')]} isActive={false} />)
    expect(screen.getByText(/1 tool used/)).toBeInTheDocument()
    expect(screen.queryByText(/1 tools/)).not.toBeInTheDocument()
  })

  it('shows "Working..." while active', () => {
    render(<ToolGroup messages={[tool('1', 'Bash')]} isActive={true} />)
    expect(screen.getByText(/Working\.\.\./)).toBeInTheDocument()
  })

  it('starts expanded when active', () => {
    const messages = [tool('1', 'Bash'), tool('2', 'Read')]
    render(<ToolGroup messages={messages} isActive={true} />)
    expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('tool-group-list')).toBeInTheDocument()
  })

  it('starts collapsed when not active', () => {
    render(<ToolGroup messages={[tool('1', 'Bash')]} isActive={false} />)
    expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('tool-group-list')).not.toBeInTheDocument()
  })

  it('expands on click and shows one entry per tool', () => {
    const messages = [
      tool('1', 'Bash', { toolInput: { command: 'ls' } }),
      tool('2', 'Read', { toolInput: { file_path: '/etc/hosts' } }),
    ]
    render(<ToolGroup messages={messages} isActive={false} />)
    fireEvent.click(screen.getByTestId('tool-group'))
    expect(screen.getByTestId('tool-group-list')).toBeInTheDocument()
    expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('Bash')
    expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('ls')
    expect(screen.getByTestId('tool-group-entry-2')).toHaveTextContent('Read')
    expect(screen.getByTestId('tool-group-entry-2')).toHaveTextContent('/etc/hosts')
  })

  it('toggles on Enter and Space, ignoring repeated Space', () => {
    render(<ToolGroup messages={[tool('1', 'Bash')]} isActive={false} />)
    const group = screen.getByTestId('tool-group')
    fireEvent.keyDown(group, { key: 'Enter' })
    expect(group).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(group, { key: ' ' })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(group, { key: ' ', repeat: true })
    expect(group).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders a check marker when the tool has a result, otherwise a chevron', () => {
    const messages = [
      tool('1', 'Bash', { toolResult: 'output' }),
      tool('2', 'Read'),
    ]
    render(<ToolGroup messages={messages} isActive={true} />)
    expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('✓')
    expect(screen.getByTestId('tool-group-entry-2')).toHaveTextContent('›')
  })

  it('counts an empty toolResult as complete (server may emit "")', () => {
    const messages = [
      tool('1', 'Bash', { toolResult: '' }),
      tool('2', 'Read'),
    ]
    render(<ToolGroup messages={messages} isActive={true} />)
    expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('✓')
    expect(screen.getByTestId('tool-group-entry-2')).toHaveTextContent('›')
  })

  it('counts toolResultImages as complete even when toolResult is missing', () => {
    const messages = [
      tool('1', 'Bash', { toolResultImages: [{ data: 'x', mediaType: 'image/png' }] }),
      tool('2', 'Read'),
    ]
    render(<ToolGroup messages={messages} isActive={true} />)
    expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('✓')
    expect(screen.getByTestId('tool-group-entry-2')).toHaveTextContent('›')
  })

  it('uses the shared formatter so MCP-prefixed names match the header label', () => {
    const messages = [
      tool('1', 'mcp__github__list_repos'),
      tool('2', 'mcp__github__list_repos'),
    ]
    render(<ToolGroup messages={messages} isActive={true} />)
    expect(screen.getByText(/2 Github: List Repos/)).toBeInTheDocument()
    expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('Github: List Repos')
  })

  it('includes serverName in entry labels for non-MCP-prefixed tools', () => {
    const messages = [
      tool('1', 'Read', { serverName: 'fs' }),
      tool('2', 'Read', { serverName: 'fs' }),
    ]
    render(<ToolGroup messages={messages} isActive={true} />)
    expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('fs Read')
  })

  it('shows a Thinking entry for thinking messages, no tool/result marker', () => {
    const messages = [thinking('t1'), tool('1', 'Bash')]
    render(<ToolGroup messages={messages} isActive={true} />)
    expect(screen.getByTestId('tool-group-entry-t1')).toHaveTextContent('Thinking')
  })

  it('falls back to a bare count when there are no tool messages', () => {
    render(<ToolGroup messages={[thinking('t1')]} isActive={false} />)
    expect(screen.getByText(/0 tools used/)).toBeInTheDocument()
    // No breakdown is appended when there are no tools.
    expect(screen.queryByText(/—/)).not.toBeInTheDocument()
  })

  it('shows a pulse indicator only while active', () => {
    const { rerender } = render(<ToolGroup messages={[tool('1', 'Bash')]} isActive={true} />)
    expect(document.querySelector('.tool-group-pulse')).toBeInTheDocument()
    rerender(<ToolGroup messages={[tool('1', 'Bash')]} isActive={false} />)
    expect(document.querySelector('.tool-group-pulse')).not.toBeInTheDocument()
  })

  it('auto-collapses when the run transitions from active to done', () => {
    const messages = [tool('1', 'Bash')]
    const { rerender } = render(<ToolGroup messages={messages} isActive={true} />)
    expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
    rerender(<ToolGroup messages={messages} isActive={false} />)
    expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'false')
  })

  it('auto-expands when a new run becomes active', () => {
    const messages = [tool('1', 'Bash')]
    const { rerender } = render(<ToolGroup messages={messages} isActive={false} />)
    expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'false')
    rerender(<ToolGroup messages={messages} isActive={true} />)
    expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
  })
})
