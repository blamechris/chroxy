/**
 * ToolBubble component — collapsible tool use card.
 *
 * Shows tool name + input summary. Clicking expands to show full result.
 */
import { useState } from 'react'

export interface ToolBubbleProps {
  toolName: string
  toolUseId: string
  input?: Record<string, unknown> | string
  result?: string
}

function getInputSummary(input: ToolBubbleProps['input']): string {
  if (!input) return ''
  if (typeof input === 'string') return input.slice(0, 100)
  // Show the most useful field
  const summary = (input.command || input.file_path || input.path || input.description || '') as string
  if (typeof summary !== 'string') return JSON.stringify(summary).slice(0, 100)
  return summary.slice(0, 100)
}

export function ToolBubble({ toolName, toolUseId, input, result }: ToolBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const summary = getInputSummary(input)

  return (
    <div
      className={`tool-bubble${expanded ? ' expanded' : ''}`}
      data-testid={`tool-bubble-${toolUseId}`}
      data-tool-id={toolUseId}
      onClick={() => setExpanded(!expanded)}
    >
      <span className="tool-name">{toolName}</span>
      {summary && (
        <span className="tool-input" data-testid="tool-input-summary" style={{ color: '#666' }}>
          {summary}
        </span>
      )}
      {expanded && result && (
        <div className="tool-result">
          <pre>{result}</pre>
        </div>
      )}
    </div>
  )
}
