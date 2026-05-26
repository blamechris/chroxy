/**
 * ToolBubble component tests (#1168)
 *
 * Tests keyboard accessibility, ARIA attributes, and expand/collapse behavior.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ToolBubble } from './ToolBubble'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ToolBubble', () => {
  const baseProps = {
    toolName: 'Read',
    toolUseId: 'tool-1',
    input: '/path/to/file',
    result: 'file contents here',
  }

  it('renders tool name and input summary', () => {
    render(<ToolBubble {...baseProps} />)
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByTestId('tool-input-summary')).toHaveTextContent('/path/to/file')
  })

  it('uses a button element for the toggle', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    expect(toggle).toBeInTheDocument()
  })

  it('has aria-expanded reflecting collapsed state', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('expands on click and sets aria-expanded to true', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('file contents here')).toBeInTheDocument()
  })

  it('collapses on second click', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('file contents here')).not.toBeInTheDocument()
  })

  it('expands on Enter key', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.keyDown(toggle, { key: 'Enter' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('file contents here')).toBeInTheDocument()
  })

  it('expands on Space key', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.keyDown(toggle, { key: ' ' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('ignores repeated Space key events', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.keyDown(toggle, { key: ' ' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Held key (repeat) should not toggle back
    fireEvent.keyDown(toggle, { key: ' ', repeat: true })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('sets aria-controls only when result panel is visible', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    // Collapsed: no aria-controls (panel not in DOM)
    expect(toggle).not.toHaveAttribute('aria-controls')
    // Expanded: aria-controls references the panel
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-controls', 'tool-result-tool-1')
  })

  it('result panel has matching id', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    fireEvent.click(toggle)
    const resultPanel = screen.getByText('file contents here').closest('.tool-result')
    expect(resultPanel).toHaveAttribute('id', 'tool-result-tool-1')
  })

  it('is focusable via tab', () => {
    render(<ToolBubble {...baseProps} />)
    const toggle = screen.getByRole('button')
    expect(toggle).toHaveAttribute('tabindex', '0')
  })

  it('does not show result when no result prop', () => {
    render(<ToolBubble toolName="Write" toolUseId="tool-2" />)
    expect(screen.getByText('Write')).toBeInTheDocument()
    expect(screen.queryByTestId('tool-input-summary')).not.toBeInTheDocument()
  })

  it('truncates long input summaries', () => {
    const longInput = 'a'.repeat(200)
    render(<ToolBubble toolName="Read" toolUseId="tool-3" input={longInput} />)
    const summary = screen.getByTestId('tool-input-summary')
    expect(summary.textContent!.length).toBeLessThanOrEqual(100)
  })

  describe('formatToolName', () => {
    it('formats snake_case tool names to Title Case', () => {
      render(<ToolBubble toolName="edit_file" toolUseId="tool-fmt-1" />)
      expect(screen.getByText('Edit File')).toBeInTheDocument()
    })

    it('formats multi-word snake_case names', () => {
      render(<ToolBubble toolName="list_directory" toolUseId="tool-fmt-2" />)
      expect(screen.getByText('List Directory')).toBeInTheDocument()
    })

    it('passes through already-formatted names unchanged', () => {
      render(<ToolBubble toolName="Read" toolUseId="tool-fmt-3" />)
      expect(screen.getByText('Read')).toBeInTheDocument()
    })

    it('formats names with three or more words', () => {
      render(<ToolBubble toolName="web_search_results" toolUseId="tool-fmt-4" />)
      expect(screen.getByText('Web Search Results')).toBeInTheDocument()
    })

    it('formats MCP tool names (mcp__<server>__<tool_name>)', () => {
      render(<ToolBubble toolName="mcp__fs__read_file" toolUseId="tool-fmt-mcp-1" />)
      expect(screen.getByText('Fs: Read File')).toBeInTheDocument()
    })
  })

  // ---------------------------------------------------------------------------
  // #4081: tool_input_delta streaming preview
  // ---------------------------------------------------------------------------
  describe('inputPartial streaming preview (#4081)', () => {
    it('renders inputPartial verbatim in the result area when expanded and result is absent', () => {
      // Mid-stream: partial JSON that JSON.parse cannot accept yet.
      // Must render as a code block (NOT as an error) so users see the
      // Bash `command` field forming.
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-partial"
          inputPartial='{"command":"rm -rf /tmp/'
        />,
      )
      const toggle = screen.getByRole('button')
      fireEvent.click(toggle)
      const preview = screen.getByTestId('tool-input-partial-tu-partial')
      expect(preview).toHaveTextContent('{"command":"rm -rf /tmp/')
      expect(preview).toHaveAttribute('data-parsed', 'false')
    })

    it('pretty-prints inputPartial as JSON when the buffer is parseable', () => {
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-parsed"
          inputPartial='{"command":"ls -la"}'
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      const preview = screen.getByTestId('tool-input-partial-tu-parsed')
      expect(preview).toHaveAttribute('data-parsed', 'true')
      // Pretty-printed with 2-space indent: the `command` key is on its own line.
      expect(preview.textContent).toContain('"command": "ls -la"')
    })

    it('switches to the standard result view once result arrives', () => {
      // Same toolUseId, partial buffer present, but a result has landed.
      // The partial preview must NOT render — the result view takes over.
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-resolved"
          inputPartial='{"command":"ls"}'
          result="file1.ts file2.ts"
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      expect(screen.queryByTestId('tool-input-partial-tu-resolved')).not.toBeInTheDocument()
      expect(screen.getByText('file1.ts file2.ts')).toBeInTheDocument()
    })

    it('shows a partial summary in the collapsed bubble (Bash early-abort UX)', () => {
      // The collapsed bubble must surface the assembling `command` so the
      // user can early-abort BEFORE expanding — this is the #4063 UX hook.
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-summary"
          inputPartial='{"command":"rm -rf /tmp/foo"}'
        />,
      )
      expect(screen.getByTestId('tool-input-summary')).toHaveTextContent('rm -rf /tmp/foo')
    })

    it('shows the verbatim partial tail in the summary when JSON is unparseable', () => {
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-summary-raw"
          inputPartial='{"command":"rm -rf '
        />,
      )
      // Unparseable partial: summary falls back to the raw buffer so the
      // collapsed bubble still shows what's forming.
      expect(screen.getByTestId('tool-input-summary')).toHaveTextContent('{"command":"rm -rf')
    })

    it('does not render a partial preview when collapsed', () => {
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-collapsed"
          inputPartial='{"command":"ls"}'
        />,
      )
      // Collapsed by default — only the summary renders, never the partial-preview block.
      expect(screen.queryByTestId('tool-input-partial-tu-collapsed')).not.toBeInTheDocument()
    })

    it('prefers structured `input` summary over inputPartial when both are present', () => {
      // Final input arrived (e.g. via legacy non-streaming providers).
      // The structured summary wins; the partial buffer is informational.
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-both"
          input={{ command: 'final-cmd' }}
          inputPartial='{"command":"streaming-stale"}'
        />,
      )
      expect(screen.getByTestId('tool-input-summary')).toHaveTextContent('final-cmd')
    })

    // -------------------------------------------------------------------------
    // #4242: amortise JSON.parse — the structural gate must short-circuit
    // before the parse runs for mid-stream chunks. Pin both call sites
    // (collapsed-summary path AND expanded partial-preview path).
    // -------------------------------------------------------------------------
    it('does not call JSON.parse for a mid-stream inputPartial (collapsed)', () => {
      const parseSpy = vi.spyOn(JSON, 'parse')
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-perf-collapsed"
          inputPartial='{"command":"rm -rf /tmp/'
        />,
      )
      // Mid-stream buffer cannot end in `}` — the gate must reject before
      // JSON.parse is called by the collapsed-summary path.
      expect(parseSpy).not.toHaveBeenCalled()
    })

    it('does not call JSON.parse for a mid-stream inputPartial (expanded preview)', () => {
      const parseSpy = vi.spyOn(JSON, 'parse')
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-perf-expanded"
          inputPartial='{"command":"rm -rf /tmp/'
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      // Both code paths (getPartialSummary + partialPreview) must skip
      // the parse on the mid-stream buffer.
      expect(parseSpy).not.toHaveBeenCalled()
      // Verbatim fallback still renders.
      const preview = screen.getByTestId('tool-input-partial-tu-perf-expanded')
      expect(preview).toHaveAttribute('data-parsed', 'false')
    })
  })

  // #4308 — header pulse marker distinguishes an in-flight tool from a
  // completed one. Pre-fix the collapsed header rendered identically in
  // both states; the only signal was implicit (expanding to see whether
  // a result panel rendered).
  describe('in-flight pulse marker (#4308)', () => {
    it('renders the pulse dot when no result has arrived', () => {
      render(<ToolBubble toolName="Bash" toolUseId="tu-1" input="ls /tmp" />)
      expect(screen.getByTestId('tool-bubble-pulse-tu-1')).toBeInTheDocument()
    })

    it('omits the pulse dot once a result has arrived', () => {
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-2"
          input="ls /tmp"
          result="total 0"
        />,
      )
      expect(screen.queryByTestId('tool-bubble-pulse-tu-2')).toBeNull()
    })

    it('omits the pulse dot for an empty-string result (tool finished, no output)', () => {
      // toolResult: '' is a legitimate finished state — the tool ran and
      // produced no output. Must not look in-flight.
      render(
        <ToolBubble toolName="Bash" toolUseId="tu-3" input="true" result="" />,
      )
      expect(screen.queryByTestId('tool-bubble-pulse-tu-3')).toBeNull()
    })
  })
})
