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

  // #4305 — when a turn ends on a tool run with no follow-up assistant
  // text, the trailing group must stay visible so the Chat tab matches
  // Output-tab chronology. Pre-fix the on-completion auto-collapse
  // silently hid the user's most recent action.
  describe('tail-group behavior (#4305)', () => {
    it('keeps the group expanded after isActive flips to false when isTail', () => {
      const messages = [tool('1', 'Bash'), tool('2', 'Read')]
      const { rerender } = render(
        <ToolGroup messages={messages} isActive={true} isTail={true} />,
      )
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
      rerender(<ToolGroup messages={messages} isActive={false} isTail={true} />)
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
    })

    it('starts expanded even when not active if the group is tail', () => {
      const messages = [tool('1', 'Bash'), tool('2', 'Read')]
      render(<ToolGroup messages={messages} isActive={false} isTail={true} />)
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
    })

    it('does not retroactively collapse when isTail later flips to false', () => {
      // Turn ends on tool run (tail, expanded). Then a response message
      // arrives and the group is no longer tail. Expansion state must
      // not retroactively change — the user might have left it open.
      const messages = [tool('1', 'Bash'), tool('2', 'Read')]
      const { rerender } = render(
        <ToolGroup messages={messages} isActive={false} isTail={true} />,
      )
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
      rerender(<ToolGroup messages={messages} isActive={false} isTail={false} />)
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
    })

    it('still auto-collapses when isActive flips to false and isTail is false', () => {
      // Regression: the existing on-completion collapse must still fire
      // when the group is NOT the tail (i.e., a response follows).
      const messages = [tool('1', 'Bash')]
      const { rerender } = render(
        <ToolGroup messages={messages} isActive={true} isTail={false} />,
      )
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
      rerender(<ToolGroup messages={messages} isActive={false} isTail={false} />)
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'false')
    })
  })

  // #4279: per-entry expansion. Clicking an inner entry must reveal the full
  // toolInput + toolResult for that entry WITHOUT collapsing the whole group
  // — pre-fix the entry click bubbled to the outer `onClick={toggle}` and
  // shut the entire list. Entries also had no place to render `toolResult`,
  // so even if the click hadn't bubbled the user still couldn't see the
  // command output.
  describe('per-entry expansion (#4279)', () => {
    it('clicking an entry does NOT collapse the parent group', () => {
      const messages = [
        tool('1', 'Bash', { toolInput: { command: 'ls' }, toolResult: 'out' }),
      ]
      render(<ToolGroup messages={messages} isActive={true} />)
      const group = screen.getByTestId('tool-group')
      expect(group).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
      // Group stays open. Entry is now in its expanded state.
      expect(group).toHaveAttribute('aria-expanded', 'true')
    })

    it('expanded entry renders toolInput + toolResult; collapsed entry hides them', () => {
      const messages = [
        tool('1', 'Bash', {
          toolInput: { command: 'ls -la /tmp' },
          toolResult: 'total 0\ndrwx------  3 root root',
        }),
      ]
      render(<ToolGroup messages={messages} isActive={true} />)

      // Collapsed by default: detail panel not in the DOM.
      expect(screen.queryByTestId('tool-group-entry-detail-1')).not.toBeInTheDocument()

      // Expand by clicking the entry.
      fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
      const detail = screen.getByTestId('tool-group-entry-detail-1')
      expect(detail).toBeInTheDocument()
      expect(detail).toHaveTextContent('ls -la /tmp')
      expect(detail).toHaveTextContent('total 0')
      // testing-library collapses runs of whitespace before comparing, so we
      // match the collapsed shape — the source value still has the double
      // space, the equality is just normalized.
      expect(detail).toHaveTextContent('drwx------ 3 root root')

      // Click again to collapse.
      fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
      expect(screen.queryByTestId('tool-group-entry-detail-1')).not.toBeInTheDocument()
    })

    it('multiple entries can be expanded simultaneously', () => {
      const messages = [
        tool('1', 'Bash', { toolInput: { command: 'pwd' }, toolResult: '/home' }),
        tool('2', 'Bash', { toolInput: { command: 'whoami' }, toolResult: 'root' }),
      ]
      render(<ToolGroup messages={messages} isActive={true} />)
      fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
      fireEvent.click(screen.getByTestId('tool-group-entry-row-2'))
      expect(screen.getByTestId('tool-group-entry-detail-1')).toHaveTextContent('pwd')
      expect(screen.getByTestId('tool-group-entry-detail-1')).toHaveTextContent('/home')
      expect(screen.getByTestId('tool-group-entry-detail-2')).toHaveTextContent('whoami')
      expect(screen.getByTestId('tool-group-entry-detail-2')).toHaveTextContent('root')
    })

    it('renders the structured AskUserQuestion input verbatim so the user can see the question + options', () => {
      // The bug surfaced via #4278: AskUserQuestion in a TUI session ends
      // up in the tool group with no way to see what was asked. Until the
      // server-side fix lands (#4278), at least the dashboard must let the
      // user expand the entry to read the structured question.
      const messages = [
        tool('1', 'AskUserQuestion', {
          toolInput: {
            questions: [
              {
                question: 'Which release strategy?',
                options: [{ label: 'Patch' }, { label: 'Minor' }],
              },
            ],
          },
        }),
      ]
      render(<ToolGroup messages={messages} isActive={true} />)
      fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
      const detail = screen.getByTestId('tool-group-entry-detail-1')
      expect(detail).toHaveTextContent('Which release strategy?')
      expect(detail).toHaveTextContent('Patch')
      expect(detail).toHaveTextContent('Minor')
    })

    it('Thinking entries are not expandable (no marker, no detail panel even on click)', () => {
      render(<ToolGroup messages={[thinking('t1')]} isActive={true} />)
      const entry = screen.getByTestId('tool-group-entry-t1')
      fireEvent.click(entry)
      expect(screen.queryByTestId('tool-group-entry-detail-t1')).not.toBeInTheDocument()
      // And the parent group is still open — the click neither collapsed
      // it nor produced a detail panel.
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
    })

    // #4284: the Thinking entry is a plain <div> with no role/tabIndex, so
    // it can never receive keyboard focus — any onKeyDown handler attached
    // to it would be dead code. Assert the entry is non-focusable so future
    // refactors don't reintroduce an unreachable keyboard handler without
    // also making the row focusable + announced.
    it('Thinking entry is non-focusable (no tabIndex, no role=button)', () => {
      render(<ToolGroup messages={[thinking('t1')]} isActive={true} />)
      const entry = screen.getByTestId('tool-group-entry-t1')
      expect(entry).not.toHaveAttribute('tabindex')
      expect(entry).not.toHaveAttribute('role', 'button')
    })

    it('keyboard: Enter on a focused row toggles its detail without collapsing the group', () => {
      const messages = [
        tool('1', 'Bash', { toolInput: { command: 'ls' }, toolResult: 'a b c' }),
      ]
      render(<ToolGroup messages={messages} isActive={true} />)
      const row = screen.getByTestId('tool-group-entry-row-1')
      fireEvent.keyDown(row, { key: 'Enter' })
      expect(screen.getByTestId('tool-group-entry-detail-1')).toBeInTheDocument()
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
      fireEvent.keyDown(row, { key: 'Enter' })
      expect(screen.queryByTestId('tool-group-entry-detail-1')).not.toBeInTheDocument()
    })

    it('shows "(no result yet)" placeholder when expanding an entry that has not finished', () => {
      const messages = [tool('1', 'Bash', { toolInput: { command: 'sleep 5' } })]
      render(<ToolGroup messages={messages} isActive={true} />)
      fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
      const detail = screen.getByTestId('tool-group-entry-detail-1')
      expect(detail).toHaveTextContent('sleep 5')
      expect(detail).toHaveTextContent('(no result yet)')
    })

    // #4281: agent-review caught that the previous implementation made the
    // OUTER entry the click target, so a click inside the expanded detail
    // panel (e.g. selecting `<pre>` text to copy a Bash output) bubbled to
    // the outer onClick and collapsed the entry — same shape of bug as the
    // top-level #4279 one level deeper. Fix is row-as-button: only the
    // header row is interactive; the detail panel sits outside the button.
    it('clicking inside the expanded detail panel does NOT collapse the entry', () => {
      const messages = [
        tool('1', 'Bash', { toolInput: { command: 'ls' }, toolResult: 'a\nb\nc' }),
      ]
      render(<ToolGroup messages={messages} isActive={true} />)
      // Expand by clicking the header row, not the outer entry container.
      fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
      const detail = screen.getByTestId('tool-group-entry-detail-1')
      expect(detail).toBeInTheDocument()
      // Now click inside the detail panel as if selecting text. The detail
      // panel must NOT toggle the entry — only the row is the click target.
      fireEvent.click(detail)
      expect(screen.getByTestId('tool-group-entry-detail-1')).toBeInTheDocument()
    })
  })
})
