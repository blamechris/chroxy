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
})
