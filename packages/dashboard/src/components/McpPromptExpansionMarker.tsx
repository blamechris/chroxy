/**
 * McpPromptExpansionMarker — #6845
 *
 * Honesty surface for a server-controlled MCP-prompt expansion. When the user
 * sends `/mcp__<server>__<prompt>`, the server (byok-session.js) expands it via
 * the MCP server's `prompts/get` and injects the returned messages as the user
 * turn to the model — but the raw slash command is all the transcript otherwise
 * shows. This collapsible marker surfaces the ACTUAL injected text with explicit
 * provenance so the transcript is honest about what the model received.
 *
 * The expansion is SERVER-CONTROLLED (authored by the MCP server, not typed by
 * the user), so the marker is labeled as such rather than rendered like a user
 * message — a trusted-but-verbose, or later-compromised, MCP server could inject
 * surprising content, and the operator should be able to audit it. Rendered by
 * `useMessageRenderer` for `type: 'system'` messages carrying
 * `mcpPromptExpansion` — same wiring as `CompactionMarker` /
 * `EvaluatorRewriteBanner`, so today it surfaces on the System tab.
 *
 * Collapsed by default (the injected text can be long): the header names the
 * source server + prompt; expanding reveals the (bounded) server-controlled
 * text, with a truncation note when the server capped a larger expansion for
 * display (the FULL text still reached the model).
 */
import { useState } from 'react'
import type { McpPromptExpansionMeta } from '../store/types'

export interface McpPromptExpansionMarkerProps {
  meta: McpPromptExpansionMeta
}

export function McpPromptExpansionMarker({ meta }: McpPromptExpansionMarkerProps) {
  const [expanded, setExpanded] = useState(false)
  const source = `${meta.server}:${meta.prompt}`
  const detailsId = `mcp-prompt-expansion-${meta.server}-${meta.prompt}-details`

  return (
    <div className="mcp-prompt-expansion-marker" data-testid="mcp-prompt-expansion-marker">
      <button
        type="button"
        className="mcp-prompt-expansion-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="mcp-prompt-expansion-icon" aria-hidden="true">⇲</span>
        <span className="mcp-prompt-expansion-summary">
          Expanded from MCP prompt{' '}
          <code className="mcp-prompt-expansion-source" data-testid="mcp-prompt-expansion-source">
            {source}
          </code>
        </span>
        <span className="mcp-prompt-expansion-badge" title="This text was authored by the MCP server, not typed by you">
          server-controlled
        </span>
        <span className="mcp-prompt-expansion-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div id={detailsId} className="mcp-prompt-expansion-details" data-testid="mcp-prompt-expansion-details">
          <div className="mcp-prompt-expansion-label">
            Sent to the model as your turn
          </div>
          <div className="mcp-prompt-expansion-text" data-testid="mcp-prompt-expansion-text">
            {meta.text}
          </div>
          {meta.truncated && (
            <div className="mcp-prompt-expansion-truncated" data-testid="mcp-prompt-expansion-truncated">
              Display truncated — the full expansion was sent to the model.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
