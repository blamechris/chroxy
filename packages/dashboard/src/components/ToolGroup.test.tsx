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
import * as fs from 'fs'
import * as path from 'path'
import type { ChatMessage } from '@chroxy/store-core'
import { ToolGroup } from './ToolGroup'

const componentsCss = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')

afterEach(cleanup)

describe('expanded shell/tool output containment (#6620)', () => {
  // Strip /* comments */ so we assert on DECLARATIONS, not explanatory prose
  // that happens to mention the same property names.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
  const ruleFor = (selector: string) =>
    stripComments(componentsCss.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0] ?? '')

  it('keeps the detail <pre> inside the card: the load-bearing overflow-wrap + wrap + scroll-of-last-resort', () => {
    const rule = ruleFor('.tool-group-entry-detail-content')
    // `overflow-wrap: anywhere` is the actual fix — it shrinks a long unbreakable
    // token's min-content so it can't push the panel past the card.
    expect(rule).toMatch(/overflow-wrap:\s*anywhere\s*;/)
    expect(rule).toMatch(/white-space:\s*pre-wrap\s*;/)
    // Width-constrained, with a horizontal scrollbar only as the last resort.
    expect(rule).toMatch(/max-width:\s*100%\s*;/)
    expect(rule).toMatch(/overflow:\s*auto\s*;/)
  })

  it('adds defensive min-width:0 to the detail flex chain (house-style, harmless in this column subtree)', () => {
    expect(ruleFor('.tool-group-entry-detail')).toMatch(/min-width:\s*0\s*;/)
    expect(ruleFor('.tool-group-entry-detail-section')).toMatch(/min-width:\s*0\s*;/)
  })
})

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
    // #4282 — the toggle target is the header <button>, not the outer
    // (now plain) container.
    fireEvent.click(screen.getByTestId('tool-group-header'))
    expect(screen.getByTestId('tool-group-list')).toBeInTheDocument()
    expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('Bash')
    expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('ls')
    expect(screen.getByTestId('tool-group-entry-2')).toHaveTextContent('Read')
    expect(screen.getByTestId('tool-group-entry-2')).toHaveTextContent('/etc/hosts')
  })

  // #4282 — keyboard activation is now handled natively by the header
  // <button> rather than a hand-rolled onKeyDown on a role="button"
  // <div>. JSDOM doesn't simulate the UA's keyboard-to-click translation
  // for a native <button>, so we exercise the toggle via the equivalent
  // click event that the UA would dispatch on Enter/Space release. The
  // "ignore repeated Space" concern from the role-div era is also
  // delegated to the platform: browsers only fire `click` on Space keyup,
  // so a held-down Space never auto-repeats the toggle.
  it('toggles via the header button (keyboard activation handled natively)', () => {
    render(<ToolGroup messages={[tool('1', 'Bash')]} isActive={false} />)
    const group = screen.getByTestId('tool-group')
    const header = screen.getByTestId('tool-group-header')
    expect(header.tagName).toBe('BUTTON')
    fireEvent.click(header)
    expect(group).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(header)
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

  it('renders an error marker (✕) + error attribute for a failed tool_result (#6712)', () => {
    const messages = [
      tool('1', 'db/query', { toolResult: 'connection refused', toolResultIsError: true }),
      tool('2', 'Bash', { toolResult: 'ok' }),
    ]
    render(<ToolGroup messages={messages} isActive={true} />)
    const errored = screen.getByTestId('tool-group-entry-1')
    expect(errored).toHaveTextContent('✕')
    expect(errored).toHaveAttribute('data-error', 'true')
    expect(errored).toHaveClass('tool-group-entry--error')
    // A successful result is unaffected — still the check marker, no error attr.
    const ok = screen.getByTestId('tool-group-entry-2')
    expect(ok).toHaveTextContent('✓')
    expect(ok).not.toHaveAttribute('data-error')
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

    // #4314 — same-commit flip. If a single store update both ends the
    // stream (isActive: true -> false) AND shifts the tail away from this
    // group (isTail: true -> false) — e.g. a `response` message arrives in
    // the same batch as `stream_end` — the on-completion collapse must
    // still respect the *prior* tail status. Reading isTail via a ref
    // updated on every render snapshots the post-flip value (false), so
    // without a guard the group collapses immediately — the same UX bug
    // #4309 was meant to fix, just on a faster turn.
    it('does not collapse when isActive and isTail flip false in the same render', () => {
      const messages = [tool('1', 'Bash'), tool('2', 'Read')]
      const { rerender } = render(
        <ToolGroup messages={messages} isActive={true} isTail={true} />,
      )
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
      // Both flips land in a single render — the response and stream_end
      // arrived in the same batched store update.
      rerender(<ToolGroup messages={messages} isActive={false} isTail={false} />)
      expect(screen.getByTestId('tool-group')).toHaveAttribute('aria-expanded', 'true')
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

    it('suppresses the raw AskUserQuestion input — the QuestionPrompt card owns the display (#4667 / #5770)', () => {
      // History: #4278 originally rendered AskUserQuestion's raw input in the
      // group as a stopgap so the user could at least read the question. That
      // is now obsolete — #4667 designated the structured QuestionPrompt card
      // (driven by the parallel `user_question` event) as the ONLY render
      // path, and #5770 found the group's detail panel was leaking the raw
      // `{"questions":[...` JSON beside the card on the claude-tui provider
      // (an AskUserQuestion sharing a turn with another tool takes the group
      // path, not the singleton ToolBubble). Both surfaces must suppress.
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
      // The raw question text + options must NOT leak anywhere in the group.
      expect(detail).not.toHaveTextContent('Which release strategy?')
      expect(detail).not.toHaveTextContent('Patch')
      expect(detail).not.toHaveTextContent('Minor')
      // The entry collapses to a quiet placeholder: tool name only, "(no input)".
      expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('AskUserQuestion')
      expect(detail).toHaveTextContent('(no input)')
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

    // #4341 — in-flight streaming tools (e.g. Agent / Task) accumulate
    // chunks into `toolInputPartial` but `toolInput` stays empty until
    // the final delta arrives. Pre-fix the expanded detail showed
    // "(no input)" even though the buffer was filling — same UX gap
    // ToolBubble closed for the collapsed-summary path in #4081.
    describe('streaming input (#4341)', () => {
      it('renders toolInputPartial verbatim while toolInput is undefined', () => {
        const messages = [
          tool('1', 'Task', { toolInputPartial: '{"description":"Investigate' }),
        ]
        render(<ToolGroup messages={messages} isActive={true} />)
        fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
        const detail = screen.getByTestId('tool-group-entry-detail-1')
        expect(detail).toHaveTextContent('{"description":"Investigate')
        expect(detail).not.toHaveTextContent('(no input)')
        // Marks the panel as streaming so styling can hint "still
        // arriving" — same affordance ToolBubble uses via data-parsed.
        expect(detail).toHaveAttribute('data-streaming', 'true')
      })

      it('pretty-prints toolInputPartial when the buffer is already complete JSON', () => {
        const messages = [
          tool('1', 'Task', { toolInputPartial: '{"command":"ls"}' }),
        ]
        render(<ToolGroup messages={messages} isActive={true} />)
        fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
        const detail = screen.getByTestId('tool-group-entry-detail-1')
        // Pretty-printed (two-space indent) when the partial happens
        // to be a complete JSON document — matches ToolBubble's
        // `tryParseCompleteJson` path.
        expect(detail).toHaveTextContent('"command": "ls"')
      })

      it('prefers structured toolInput when present, ignoring toolInputPartial', () => {
        // Once the final input lands, the structured render takes over —
        // the partial buffer becomes informational only and must not
        // override the canonical structured panel.
        const messages = [
          tool('1', 'Task', {
            toolInput: { command: 'ls -la' },
            toolInputPartial: '{"command":"ls', // stale half-buffer
          }),
        ]
        render(<ToolGroup messages={messages} isActive={true} />)
        fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
        const detail = screen.getByTestId('tool-group-entry-detail-1')
        expect(detail).toHaveTextContent('"command": "ls -la"')
        // The streaming attribute is only for the partial-only path.
        expect(detail).not.toHaveAttribute('data-streaming', 'true')
      })

      it('still shows "(no input)" when both toolInput and toolInputPartial are absent', () => {
        // Regression guard for the existing placeholder behavior — a
        // truly inputless tool still shows the placeholder.
        const messages = [tool('1', 'Bash')]
        render(<ToolGroup messages={messages} isActive={true} />)
        fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
        const detail = screen.getByTestId('tool-group-entry-detail-1')
        expect(detail).toHaveTextContent('(no input)')
      })

      it('still shows "(no input)" when toolInputPartial is an empty string', () => {
        // Empty-string partials must not flip the panel into the
        // streaming path — only content counts.
        const messages = [tool('1', 'Bash', { toolInputPartial: '' })]
        render(<ToolGroup messages={messages} isActive={true} />)
        fireEvent.click(screen.getByTestId('tool-group-entry-row-1'))
        const detail = screen.getByTestId('tool-group-entry-detail-1')
        expect(detail).toHaveTextContent('(no input)')
        expect(detail).not.toHaveAttribute('data-streaming', 'true')
      })
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

  // #4259 — input summary derivation must route through the shared
  // `@chroxy/store-core` helper (single source of truth for the
  // command → file_path → path → description priority), so a tweak to
  // the priority order or fallback semantics in store-core propagates
  // here automatically. These checks pin the observable behaviour of
  // the shared helper at the dashboard surface — they fail if a future
  // contributor reintroduces a local copy whose semantics drift.
  describe('input summary uses shared getInputSummary (#4259)', () => {
    it('prefers command over file_path/path/description', () => {
      const messages = [
        tool('1', 'Bash', {
          toolInput: {
            command: 'ls -la',
            file_path: '/etc/hosts',
            path: '/tmp',
            description: 'list',
          },
        }),
      ]
      render(<ToolGroup messages={messages} isActive={true} />)
      const entry = screen.getByTestId('tool-group-entry-1')
      expect(entry).toHaveTextContent('ls -la')
      expect(entry).not.toHaveTextContent('/etc/hosts')
      expect(entry).not.toHaveTextContent('/tmp')
      expect(entry).not.toHaveTextContent('list')
    })

    it('falls through to file_path, then path, then description', () => {
      const messages = [
        tool('1', 'Read', { toolInput: { file_path: '/etc/hosts' } }),
        tool('2', 'Glob', { toolInput: { path: '/tmp' } }),
        tool('3', 'Task', { toolInput: { description: 'investigate' } }),
      ]
      render(<ToolGroup messages={messages} isActive={true} />)
      expect(screen.getByTestId('tool-group-entry-1')).toHaveTextContent('/etc/hosts')
      expect(screen.getByTestId('tool-group-entry-2')).toHaveTextContent('/tmp')
      expect(screen.getByTestId('tool-group-entry-3')).toHaveTextContent('investigate')
    })

    it('truncates a long string-shaped command to 100 chars', () => {
      const long = 'x'.repeat(200)
      const messages = [tool('1', 'Bash', { toolInput: { command: long } })]
      render(<ToolGroup messages={messages} isActive={true} />)
      const input = screen
        .getByTestId('tool-group-entry-1')
        .querySelector('.tool-group-entry-input')
      expect(input?.textContent).toHaveLength(100)
    })
  })

  // #4282 — pre-fix, the outer .tool-group div carried role="button" +
  // tabIndex=0 AND every .tool-group-entry-row also carried role="button"
  // + tabIndex=0. WAI-ARIA disallows nesting interactive elements: NVDA /
  // VoiceOver behaviour with a button-inside-a-button is undefined and AT
  // may surface only the outer button, or read both and confuse the user.
  // The fix moves the group's toggle onto a real <button> header that is
  // a SIBLING of the entry rows rather than an ancestor — so no
  // interactive element is nested inside another interactive element.
  describe('no nested interactive elements (#4282)', () => {
    it('the outer .tool-group container is not interactive', () => {
      const messages = [tool('1', 'Bash', { toolInput: { command: 'ls' } })]
      render(<ToolGroup messages={messages} isActive={true} />)
      const group = screen.getByTestId('tool-group')
      // Plain <div>, not a <button>, and no role="button" / tabindex.
      expect(group.tagName).toBe('DIV')
      expect(group).not.toHaveAttribute('role', 'button')
      expect(group).not.toHaveAttribute('tabindex')
    })

    it('the header is a real <button>, sibling of the entry list', () => {
      const messages = [tool('1', 'Bash', { toolInput: { command: 'ls' } })]
      render(<ToolGroup messages={messages} isActive={true} />)
      const header = screen.getByTestId('tool-group-header')
      const list = screen.getByTestId('tool-group-list')
      expect(header.tagName).toBe('BUTTON')
      // Same parent => the header and the entry list are siblings, not
      // ancestor/descendant.
      expect(header.parentElement).toBe(list.parentElement)
      // The entry list must not contain the header (and vice versa).
      expect(list.contains(header)).toBe(false)
      expect(header.contains(list)).toBe(false)
    })

    it('no interactive element is nested inside another interactive element', () => {
      // Exercise the worst-case shape: an expanded group with multiple
      // tool entries, each row interactive. Pre-fix every row sat inside
      // the outer role="button" container — a nested-interactive
      // violation per entry.
      const messages = [
        tool('1', 'Bash', { toolInput: { command: 'ls' } }),
        tool('2', 'Read', { toolInput: { file_path: '/etc/hosts' } }),
        tool('3', 'Write', { toolInput: { file_path: '/tmp/x' } }),
      ]
      render(<ToolGroup messages={messages} isActive={true} />)
      const interactives = Array.from(
        document.querySelectorAll(
          'button, [role="button"], a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      )
      // Sanity check — we should have found the header button + one row
      // per tool entry (3 rows).
      expect(interactives.length).toBeGreaterThanOrEqual(4)
      for (const a of interactives) {
        for (const b of interactives) {
          if (a === b) continue
          // No interactive element may be contained by another
          // interactive element.
          expect(a.contains(b)).toBe(false)
        }
      }
    })
  })
})
