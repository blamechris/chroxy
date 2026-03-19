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

const capitalize = (word: string) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : '')

function formatToolName(name: string): string {
  const MCP_PREFIX = 'mcp__'
  if (name.startsWith(MCP_PREFIX)) {
    const withoutPrefix = name.slice(MCP_PREFIX.length)
    const sep = withoutPrefix.indexOf('__')
    if (sep > 0) {
      const server = withoutPrefix.slice(0, sep).split('_').filter(Boolean).map(capitalize).join(' ')
      const tool = withoutPrefix.slice(sep + 2).split('_').filter(Boolean).map(capitalize).join(' ')
      return tool ? `${server}: ${tool}` : server
    }
  }
  return name.split('_').filter(Boolean).map(capitalize).join(' ')
}

export function ToolBubble({ toolName, toolUseId, input, result }: ToolBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const summary = getInputSummary(input)
  const resultId = `tool-result-${toolUseId}`

  const toggle = () => setExpanded(prev => !prev)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      toggle()
    } else if (e.key === ' ' && !e.repeat) {
      e.preventDefault()
      toggle()
    }
  }

  return (
    <div
      className={`tool-bubble${expanded ? ' expanded' : ''}`}
      data-testid={`tool-bubble-${toolUseId}`}
      data-tool-id={toolUseId}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-controls={expanded && result ? resultId : undefined}
      onClick={toggle}
      onKeyDown={handleKeyDown}
    >
      <span className="tool-name">{formatToolName(toolName)}</span>
      {summary && (
        <span className="tool-input" data-testid="tool-input-summary" style={{ color: '#666' }}>
          {summary}
        </span>
      )}
      {expanded && result && (
        <div className="tool-result" id={resultId}>
          <pre>{result}</pre>
        </div>
      )}
    </div>
  )
}
