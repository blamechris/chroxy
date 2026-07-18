/**
 * ToolBubble component tests (#1168)
 *
 * Tests keyboard accessibility, ARIA attributes, and expand/collapse behavior.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ToolResultImage } from '@chroxy/store-core'
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

  it('collapses a long tool result behind a Show-more pill (chat redesign #6391)', () => {
    const longResult = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n')
    render(<ToolBubble {...baseProps} result={longResult} isTail />)
    const resultEl = () => document.getElementById('tool-result-tool-1')!
    const expandBtn = screen.getByTestId('tool-result-expand-tool-1')
    expect(expandBtn).toHaveTextContent('Show 8 more lines')
    // collapsed: head (line1..line12) shown, tail (line13..line20) hidden
    expect(resultEl().textContent).toContain('line12')
    expect(resultEl().textContent).not.toContain('line13')
    fireEvent.click(expandBtn)
    expect(resultEl().textContent).toContain('line20')
    expect(screen.getByTestId('tool-result-collapse-tool-1')).toBeInTheDocument()
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

    // #4339 — the existing MCP test uses an `mcp__`-prefixed name, which
    // exercises the prefix branch of `formatToolName` and IGNORES the
    // second `serverName` arg entirely. These fixtures pin the non-MCP
    // branch — the only path where `serverName` is observable in the
    // rendered header — so a regression that drops `serverName`
    // propagation through ToolBubble fails loudly here.
    it('prefixes a non-MCP tool name with serverName when provided (#4339)', () => {
      render(
        <ToolBubble
          toolName="list_files"
          toolUseId="tool-fmt-server-1"
          serverName="fs"
        />,
      )
      // formatToolName('list_files', 'fs') → 'fs List Files'.
      expect(screen.getByText('fs List Files')).toBeInTheDocument()
    })

    it('renders a non-MCP tool name without prefix when serverName is omitted (#4339 control)', () => {
      // Control fixture for the case above: same tool, no `serverName` → the
      // prefix must NOT appear. Pins the
      // `serverName ? ${serverName} ${formatted} : formatted`
      // conditional so a default-on regression flips this test.
      render(<ToolBubble toolName="list_files" toolUseId="tool-fmt-server-2" />)
      expect(screen.getByText('List Files')).toBeInTheDocument()
      expect(screen.queryByText(/^fs /)).not.toBeInTheDocument()
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

    // #4317: tools that resolve with images-only (computer-use
    // screenshots, browser tools returning base64 PNGs) leave
    // `result === undefined` but populate `resultImages`. Pre-fix the
    // pulse rendered forever; the predicate now mirrors ToolGroup's
    // `hasResult` and ActivityIndicator's in-flight check.
    it('omits the pulse dot when result is images-only (no text result)', () => {
      render(
        <ToolBubble
          toolName="screenshot"
          toolUseId="tu-4"
          input={{ url: 'https://example.com' }}
          resultImages={[{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]}
        />,
      )
      expect(screen.queryByTestId('tool-bubble-pulse-tu-4')).toBeNull()
    })

    it('still renders the pulse dot when resultImages is an empty array (not resolved)', () => {
      // Defensive: an empty array should be treated like no images at
      // all — the tool is still in-flight.
      render(
        <ToolBubble
          toolName="screenshot"
          toolUseId="tu-5"
          input={{ url: 'https://example.com' }}
          resultImages={[]}
        />,
      )
      expect(screen.getByTestId('tool-bubble-pulse-tu-5')).toBeInTheDocument()
    })
  })

  // ---------------------------------------------------------------------------
  // #6755 — tool-result images (computer-use screenshots, browser tools
  // returning base64 PNGs) render as thumbnails in the expanded body, with
  // click-to-zoom into a full-resolution lightbox. Mirrors the mobile
  // ToolDetailModal image grid + ImageViewer.
  // ---------------------------------------------------------------------------
  describe('tool-result image rendering (#6755)', () => {
    // Fixed-length tuple (not a bare array) so indexed access stays typed as
    // `ToolResultImage`, not `ToolResultImage | undefined`, under the
    // dashboard's `noUncheckedIndexedAccess` tsconfig.
    const image1: ToolResultImage = { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' }
    const image2: ToolResultImage = { mediaType: 'image/png', data: 'ZmFrZS1zZWNvbmQtaW1hZ2U=' }
    const images: [ToolResultImage, ToolResultImage] = [image1, image2]

    it('renders a thumbnail for an images-only result (result === undefined)', () => {
      render(
        <ToolBubble
          toolName="screenshot"
          toolUseId="tu-img-1"
          input={{ url: 'https://example.com' }}
          resultImages={[images[0]]}
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      const grid = screen.getByTestId('tool-result-images-tu-img-1')
      expect(grid).toBeInTheDocument()
      const thumbBtn = screen.getByTestId('tool-result-image-tu-img-1-0')
      const img = thumbBtn.querySelector('img')
      expect(img).toHaveAttribute('src', `data:${images[0].mediaType};base64,${images[0].data}`)
      // The thumbnail opens the ImageLightbox modal — announce that to AT
      // (matches the dashboard's modal-trigger pattern).
      expect(thumbBtn).toHaveAttribute('aria-haspopup', 'dialog')
    })

    it('renders one thumbnail per image for a multi-image result (grid)', () => {
      render(
        <ToolBubble
          toolName="screenshot"
          toolUseId="tu-img-2"
          resultImages={images}
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      expect(screen.getByTestId('tool-result-image-tu-img-2-0')).toBeInTheDocument()
      expect(screen.getByTestId('tool-result-image-tu-img-2-1')).toBeInTheDocument()
      // Every thumbnail in the grid is a modal trigger.
      expect(screen.getByTestId('tool-result-image-tu-img-2-0')).toHaveAttribute('aria-haspopup', 'dialog')
      expect(screen.getByTestId('tool-result-image-tu-img-2-1')).toHaveAttribute('aria-haspopup', 'dialog')
    })

    it('does not render an image grid when resultImages is absent', () => {
      render(<ToolBubble toolName="Read" toolUseId="tu-img-3" input="/f" result="contents" />)
      fireEvent.click(screen.getByRole('button'))
      expect(screen.queryByTestId('tool-result-images-tu-img-3')).not.toBeInTheDocument()
    })

    it('renders both the text result and the image grid when a tool resolves with both', () => {
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-img-4"
          input={{ command: 'screenshot.sh' }}
          result="saved to /tmp/out.png"
          resultImages={[images[0]]}
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      expect(screen.getByText('saved to /tmp/out.png')).toBeInTheDocument()
      expect(screen.getByTestId('tool-result-images-tu-img-4')).toBeInTheDocument()
    })

    it('opens the full-resolution lightbox on thumbnail click', () => {
      render(
        <ToolBubble
          toolName="screenshot"
          toolUseId="tu-img-5"
          resultImages={[images[0]]}
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      expect(screen.queryByTestId('image-lightbox-img')).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('tool-result-image-tu-img-5-0'))
      const lightboxImg = screen.getByTestId('image-lightbox-img')
      expect(lightboxImg).toHaveAttribute('src', `data:${images[0].mediaType};base64,${images[0].data}`)
    })

    it('dismisses the lightbox via its close button without collapsing the parent bubble', () => {
      render(
        <ToolBubble
          toolName="screenshot"
          toolUseId="tu-img-6"
          resultImages={[images[0]]}
        />,
      )
      const toggle = screen.getByRole('button')
      fireEvent.click(toggle)
      fireEvent.click(screen.getByTestId('tool-result-image-tu-img-6-0'))
      expect(screen.getByTestId('image-lightbox-img')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Close image' }))
      expect(screen.queryByTestId('image-lightbox-img')).not.toBeInTheDocument()
      // The bubble itself must still be expanded — dismissing the lightbox
      // must not bubble into the outer toggle.
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
    })

    it('dismisses the lightbox on Escape', () => {
      render(
        <ToolBubble
          toolName="screenshot"
          toolUseId="tu-img-7"
          resultImages={[images[0]]}
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      fireEvent.click(screen.getByTestId('tool-result-image-tu-img-7-0'))
      expect(screen.getByTestId('image-lightbox-img')).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByTestId('image-lightbox-img')).not.toBeInTheDocument()
    })

    it('labels the lightbox with position among multiple images', () => {
      render(
        <ToolBubble
          toolName="screenshot"
          toolUseId="tu-img-8"
          resultImages={images}
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      fireEvent.click(screen.getByTestId('tool-result-image-tu-img-8-1'))
      expect(screen.getByText('Image 2 of 2')).toBeInTheDocument()
    })

    it('sets aria-controls when the tool resolved with images only (no text)', () => {
      render(<ToolBubble toolName="screenshot" toolUseId="tu-img-9" resultImages={[images[0]]} />)
      const toggle = screen.getByRole('button')
      expect(toggle).not.toHaveAttribute('aria-controls')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-controls', 'tool-result-tu-img-9')
    })

    it('does not render the images-only panel when resultImages is an empty array', () => {
      render(<ToolBubble toolName="screenshot" toolUseId="tu-img-10" resultImages={[]} />)
      fireEvent.click(screen.getByRole('button'))
      expect(screen.queryByTestId('tool-result-images-tu-img-10')).not.toBeInTheDocument()
    })
  })

  // ---------------------------------------------------------------------------
  // #4313 — tail-bubble behavior. Singleton trailing tool_use rows bypass
  // the ToolGroup path entirely (`chatToolGroupPayloads` only collapses runs
  // of 2+ — App.tsx:894-902), so the #4309 ToolGroup tail mitigation never
  // fires for 1-tool tails. Mirroring the prop on ToolBubble closes that gap.
  // ---------------------------------------------------------------------------
  describe('tail-bubble behavior (#4313)', () => {
    it('mounts expanded when isTail is true (singleton trailing tool with result)', () => {
      render(
        <ToolBubble
          toolName="Read"
          toolUseId="tu-tail-1"
          input="/file"
          result="contents"
          isTail
        />,
      )
      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
      // Result panel renders immediately — no click needed.
      expect(screen.getByText('contents')).toBeInTheDocument()
    })

    it('mounts expanded when isTail is true and tool is still in-flight (no result)', () => {
      // Tail singleton with no result yet — bubble should still mount
      // expanded so the user sees what is running. Mirrors the #4309
      // behavior for groups where the trailing tool may still be active.
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="tu-tail-pending"
          inputPartial='{"command":"ls"}'
          isTail
        />,
      )
      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
      // Partial preview is visible without a click.
      expect(screen.getByTestId('tool-input-partial-tu-tail-pending')).toBeInTheDocument()
    })

    it('mounts collapsed when isTail is false (default behavior)', () => {
      // Regression: non-tail bubbles must still mount collapsed.
      render(
        <ToolBubble
          toolName="Read"
          toolUseId="tu-non-tail"
          input="/file"
          result="contents"
        />,
      )
      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('contents')).not.toBeInTheDocument()
    })

    it('does not retroactively collapse when isTail flips to false later', () => {
      // Turn ends on a singleton tool (tail, expanded). A follow-up
      // response message then arrives and the bubble is no longer tail.
      // The expansion state must NOT retroactively change — the user
      // may have already seen and engaged with the expanded result.
      // Matches the `isTailRef` shape from ToolGroup.tsx:181-187.
      const { rerender } = render(
        <ToolBubble
          toolName="Read"
          toolUseId="tu-tail-flip"
          input="/file"
          result="contents"
          isTail
        />,
      )
      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
      rerender(
        <ToolBubble
          toolName="Read"
          toolUseId="tu-tail-flip"
          input="/file"
          result="contents"
          isTail={false}
        />,
      )
      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    })

    it('user-collapsed tail bubble stays collapsed after a re-render', () => {
      // Tail bubble mounts expanded; user clicks to collapse. The
      // collapsed state must survive subsequent re-renders even while
      // isTail remains true — initial-state-only semantics.
      render(
        <ToolBubble
          toolName="Read"
          toolUseId="tu-tail-toggle"
          input="/file"
          result="contents"
          isTail
        />,
      )
      const toggle = screen.getByRole('button')
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('contents')).not.toBeInTheDocument()
    })
  })

  // ---------------------------------------------------------------------------
  // #4667 — AskUserQuestion bubble must NOT surface its raw `tool_input`
  // JSON during streaming. The dashboard already renders the structured
  // question via the dedicated QuestionPrompt card (driven by the
  // `user_question` event), so any JSON leak from this bubble produces a
  // jarring double-render where users see both `{"questions":[...` and
  // the proper card. The fix suppresses both the collapsed summary and
  // the expanded partial-preview block for `tool_name === 'AskUserQuestion'`.
  // ---------------------------------------------------------------------------
  describe('AskUserQuestion raw input suppression (#4667)', () => {
    it('hides the collapsed summary while a partial AskUserQuestion tool_input streams in', () => {
      // Mid-stream: `tool_input_delta` chunks have piled up an unparseable
      // prefix of the question JSON. The legacy fallback would slice the
      // first 100 chars of the buffer into the collapsed summary span —
      // that is exactly the JSON tail the issue calls out.
      render(
        <ToolBubble
          toolName="AskUserQuestion"
          toolUseId="auq-partial"
          inputPartial={'{"questions":[{"question":"Which testing framework should the project us'}
        />,
      )
      // No summary span (the suppression short-circuits the fallback).
      expect(screen.queryByTestId('tool-input-summary')).not.toBeInTheDocument()
      // And the raw JSON tail never appears anywhere in the bubble.
      const bubble = screen.getByTestId('tool-bubble-auq-partial')
      expect(bubble.textContent).not.toContain('{"questions"')
      expect(bubble.textContent).not.toContain('Which testing framework')
    })

    it('hides the collapsed summary even when the AskUserQuestion JSON parses cleanly', () => {
      // Final delta completed the JSON document — the legacy
      // `getInputSummary` / `getPartialSummary` path would happily
      // extract a string field and surface it. Must still be suppressed:
      // the structured QuestionPrompt card is the canonical render path.
      render(
        <ToolBubble
          toolName="AskUserQuestion"
          toolUseId="auq-complete"
          input={{
            questions: [
              { question: 'Which framework?', options: [{ label: 'Vitest' }, { label: 'Jest' }] },
            ],
          }}
        />,
      )
      expect(screen.queryByTestId('tool-input-summary')).not.toBeInTheDocument()
      // Tool name still renders so the bubble is identifiable.
      // formatToolName leaves PascalCase tool names untouched (split by
      // `_` only), so "AskUserQuestion" stays as-is.
      expect(screen.getByText('AskUserQuestion')).toBeInTheDocument()
    })

    it('does not render the expanded partial-preview block for AskUserQuestion', () => {
      render(
        <ToolBubble
          toolName="AskUserQuestion"
          toolUseId="auq-expanded"
          inputPartial={'{"questions":[{"question":"Which testing framework should the project us'}
        />,
      )
      // Force-expand the bubble — even open, the partial-preview block
      // must not appear (the structured card is rendered elsewhere).
      fireEvent.click(screen.getByRole('button'))
      expect(screen.queryByTestId('tool-input-partial-auq-expanded')).not.toBeInTheDocument()
      const bubble = screen.getByTestId('tool-bubble-auq-expanded')
      expect(bubble.textContent).not.toContain('{"questions"')
    })

    it('still surfaces inputPartial for non-suppressed tools (regression guard)', () => {
      // Control: Bash must keep streaming its `command` field into the
      // collapsed summary so the early-abort UX (#4063) continues to
      // work. A too-broad suppression would silently break this.
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="bash-control"
          inputPartial='{"command":"rm -rf /tmp/foo"}'
        />,
      )
      expect(screen.getByTestId('tool-input-summary')).toHaveTextContent('rm -rf /tmp/foo')
    })

    it('hides the partial-preview block when the tool resolved with empty-string result (#4667 / Copilot)', () => {
      // A tool that finished with `result === ''` (resolved-with-no-output,
      // #4308) was still rendering the streaming `inputPartial` code
      // block when expanded — the legacy `result`-truthy gate treated
      // empty-string as "still in flight." Pulse / ActivityIndicator
      // already use `hasResult` (`result !== undefined`) so the bubble
      // header correctly hid the pulse for these cases, but the
      // expanded preview path was inconsistent. Fixed alongside the
      // #4667 suppression refactor; this test pins the contract.
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="bash-empty-result"
          inputPartial='{"command":"true"}'
          result=""
        />,
      )
      // Empty-string result means hasResult is true → no pulse.
      expect(screen.queryByTestId('tool-bubble-pulse-bash-empty-result')).not.toBeInTheDocument()
      // Force-expand: the streaming preview must NOT render because
      // the tool already resolved (even with no output).
      fireEvent.click(screen.getByRole('button'))
      expect(screen.queryByTestId('tool-input-partial-bash-empty-result')).not.toBeInTheDocument()
    })
  })

  // #4655 — collapsed bubbles must never leak raw `tool_input` JSON for tools
  // whose input shape has none of the hardcoded PRIORITY_FIELDS (ToolSearch,
  // MCP tools, custom user tools, future Anthropic tools). The fix lives in
  // `tool-summary.ts` (generic key:value fallback); these fixtures pin the
  // dashboard render contract end-to-end so the leak surface stays sealed.
  //
  // The canonical bug fixture is ToolSearch — reported live during the
  // v0.9.24 dogfood as
  //   `ToolSearch {"matches":["AskUserQuestion"],"query":"select:AskUser...`
  // (raw JSON head). The fix renders
  //   `ToolSearch query: "select:AskUserQuestion", max_results: 5`
  // instead.
  // ---------------------------------------------------------------------------
  describe('unknown-shape tool_input never leaks raw JSON (#4655)', () => {
    it('renders ToolSearch input as a compact key:value summary instead of raw JSON', () => {
      render(
        <ToolBubble
          toolName="ToolSearch"
          toolUseId="ts-final"
          input={{ query: 'select:AskUserQuestion', max_results: 5 }}
          result="matched 1 tool"
        />,
      )
      const summary = screen.getByTestId('tool-input-summary')
      // Compact, key:value form — generic fallback.
      expect(summary).toHaveTextContent('query: "select:AskUserQuestion", max_results: 5')
      // The canonical leak: a raw JSON object brace must NEVER appear in the
      // collapsed summary for any unknown-shape tool input.
      expect(summary.textContent).not.toContain('{"query"')
      expect(summary.textContent).not.toContain('"matches"')
    })

    it('renders MCP tool input with arbitrary keys as compact key:value summary', () => {
      // MCP tools have per-server schemas — no allowlist can keep up. The
      // generic fallback is the only sustainable answer.
      render(
        <ToolBubble
          toolName="mcp__fs__list_directory"
          toolUseId="mcp-final"
          serverName="fs"
          input={{ url: 'https://example.com', timeout_ms: 5000 }}
          result="[]"
        />,
      )
      const summary = screen.getByTestId('tool-input-summary')
      expect(summary).toHaveTextContent('url: "https://example.com", timeout_ms: 5000')
      expect(summary.textContent).not.toContain('{"url"')
    })

    it('renders generic unknown-shape input (no priority field, no recognised structure)', () => {
      // Catch-all: future tool with totally arbitrary shape. The generic
      // fallback must still produce a useful preview, never raw JSON.
      render(
        <ToolBubble
          toolName="future_tool"
          toolUseId="future-final"
          input={{ foo: 'bar', enabled: true, retries: 3 }}
          result=""
        />,
      )
      const summary = screen.getByTestId('tool-input-summary')
      expect(summary).toHaveTextContent('foo: "bar", enabled: true, retries: 3')
      expect(summary.textContent).not.toContain('{"foo"')
    })

    it('renders ToolSearch inputPartial as compact summary during streaming (parseable)', () => {
      // Streaming finished — the partial buffer is now valid JSON but still
      // lacks a priority field. Pre-fix this fell through to `inputPartial
      // .slice(0, 100)` and leaked raw JSON head into the collapsed bubble.
      render(
        <ToolBubble
          toolName="ToolSearch"
          toolUseId="ts-partial"
          inputPartial='{"query":"select:AskUserQuestion","max_results":5}'
        />,
      )
      const summary = screen.getByTestId('tool-input-summary')
      expect(summary).toHaveTextContent('query: "select:AskUserQuestion", max_results: 5')
      expect(summary.textContent).not.toContain('{"query"')
    })

    it('renders a nested unknown-shape input without leaking nested JSON', () => {
      // Object-shape value at top level — the canonical worst-case leak
      // (Read tool nested input was the #4648 case). Generic fallback
      // collapses nested objects to `{...}` placeholders.
      render(
        <ToolBubble
          toolName="custom_tool"
          toolUseId="custom-nested"
          input={{ options: { recursive: true, follow: false }, name: 'scan' }}
          result="done"
        />,
      )
      const summary = screen.getByTestId('tool-input-summary')
      expect(summary).toHaveTextContent('options: {...}, name: "scan"')
      // The nested object's keys must NOT leak as raw JSON.
      expect(summary.textContent).not.toContain('"recursive"')
      expect(summary.textContent).not.toContain('"follow"')
    })

    it('preserves the verbatim mid-stream fallback for genuinely unparseable inputPartial', () => {
      // Regression guard: the mid-stream Bash early-abort UX (#4063)
      // depends on the verbatim-tail fallback when the buffer can't yet
      // parse. The generic fallback only applies to parsed objects.
      render(
        <ToolBubble
          toolName="ToolSearch"
          toolUseId="ts-midstream"
          inputPartial='{"query":"select:Ask'
        />,
      )
      const summary = screen.getByTestId('tool-input-summary')
      // Mid-stream: still shows the verbatim head so users see the
      // buffer forming.
      expect(summary.textContent).toContain('{"query":"select:Ask')
    })

    it('preserves the existing Bash priority-field summary (regression guard)', () => {
      // Belt-and-braces: a known-shape tool must keep its nice extracted
      // summary even after the generic-fallback path lands.
      render(
        <ToolBubble
          toolName="Bash"
          toolUseId="bash-regression"
          input={{ command: 'rm -rf node_modules' }}
        />,
      )
      const summary = screen.getByTestId('tool-input-summary')
      expect(summary).toHaveTextContent('rm -rf node_modules')
      // No generic key:value rendering for known shapes.
      expect(summary.textContent).not.toContain('command:')
    })
  })
})
