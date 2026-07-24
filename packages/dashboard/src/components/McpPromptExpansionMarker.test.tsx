/**
 * McpPromptExpansionMarker component tests (#6845).
 *
 * Covers the honesty marker rendered for a server-controlled MCP-prompt
 * expansion: collapsed by default, names the source server + prompt with an
 * explicit "server-controlled" provenance label, and reveals the actual
 * injected text (plus a truncation note) on expand.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { McpPromptExpansionMarker } from './McpPromptExpansionMarker'
import type { McpPromptExpansionMeta } from '../store/types'

afterEach(cleanup)

const baseMeta: McpPromptExpansionMeta = {
  server: 'stub',
  prompt: 'greet',
  text: 'SERVER-AUTHORED CONTENT the user never typed',
  truncated: false,
}

describe('McpPromptExpansionMarker (#6845)', () => {
  it('names the source server + prompt and labels the content server-controlled', () => {
    render(<McpPromptExpansionMarker meta={baseMeta} />)
    const marker = screen.getByTestId('mcp-prompt-expansion-marker')
    expect(marker).toHaveTextContent('Expanded from MCP prompt')
    expect(screen.getByTestId('mcp-prompt-expansion-source')).toHaveTextContent('stub:greet')
    expect(marker).toHaveTextContent('server-controlled')
  })

  it('is collapsed by default (injected text hidden until expanded)', () => {
    render(<McpPromptExpansionMarker meta={baseMeta} />)
    expect(screen.queryByTestId('mcp-prompt-expansion-text')).toBeNull()
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  })

  it('reveals the actual server-controlled injected text on expand', () => {
    render(<McpPromptExpansionMarker meta={baseMeta} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('mcp-prompt-expansion-text')).toHaveTextContent(
      'SERVER-AUTHORED CONTENT the user never typed',
    )
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows a truncation note only when the expansion was capped for display', () => {
    render(<McpPromptExpansionMarker meta={{ ...baseMeta, truncated: true }} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('mcp-prompt-expansion-truncated')).toHaveTextContent(
      'the full expansion was sent to the model',
    )
  })

  it('omits the truncation note when not truncated', () => {
    render(<McpPromptExpansionMarker meta={baseMeta} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByTestId('mcp-prompt-expansion-truncated')).toBeNull()
  })

  // Honesty fix (post-#6845-review, thread 4): the server can ALSO prepend
  // skills text (`BaseSession._buildPrependPrompt`) ahead of the MCP-prompt
  // expansion, so the expansion is only PART of the turn, not the whole thing.
  // The old label ("Sent to the model as your turn") overstated that.
  it('labels the injected text as part of the turn, not the whole turn', () => {
    render(<McpPromptExpansionMarker meta={baseMeta} />)
    fireEvent.click(screen.getByRole('button'))
    const details = screen.getByTestId('mcp-prompt-expansion-details')
    expect(details).toHaveTextContent('Sent to the model as part of your turn')
    expect(details).not.toHaveTextContent('Sent to the model as your turn')
  })

  // Fragile-id fix (post-#6845-review, thread 3): server/prompt names are
  // server-controlled and can contain arbitrary characters. A raw
  // interpolation into the HTML `id` produces an id that breaks
  // `aria-controls` linkage / test selectors for anything but plain alnum
  // names. The id must be sanitized to `[A-Za-z0-9_-]` while the
  // aria-controls linkage between the toggle button and the details panel
  // stays intact.
  it('sanitizes punctuation/whitespace in server/prompt names into a valid, stable HTML id', () => {
    const punctuatedMeta: McpPromptExpansionMeta = {
      ...baseMeta,
      server: 'my server/v2.0 (prod)',
      prompt: 'greet user!!',
    }
    render(<McpPromptExpansionMarker meta={punctuatedMeta} />)
    const toggle = screen.getByRole('button')
    const ariaControlsId = toggle.getAttribute('aria-controls')
    expect(ariaControlsId).toBeTruthy()
    expect(ariaControlsId).toMatch(/^[A-Za-z0-9_-]+$/)

    fireEvent.click(toggle)
    const details = screen.getByTestId('mcp-prompt-expansion-details')
    // The button's aria-controls must still resolve to the rendered details
    // panel's actual id — sanitizing must not break the linkage.
    expect(details.id).toBe(ariaControlsId)
  })
})
