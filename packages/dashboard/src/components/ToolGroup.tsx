/**
 * ToolGroup — collapsible block summarising a contiguous run of tool calls
 * (#3747). Mirrors the mobile app's ActivityGroup so both clients render
 * the same shape: a one-line header with total + tool-type breakdown
 * (e.g. "12 tools used — 10 Bash, 2 Read"), expanding to a list of
 * individual entries.
 *
 * Default state: collapsed when the run is done, expanded while it is
 * still active so users see progress as tools fire.
 */
import { useState, useEffect, useRef } from 'react'
import type { ChatMessage } from '@chroxy/store-core'
import { summarizeToolCounts, formatToolBreakdown } from '@chroxy/store-core'

export interface ToolGroupProps {
  messages: ChatMessage[]
  isActive: boolean
}

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

function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : ''
}

function getInputSummary(input: ChatMessage['toolInput']): string {
  if (!input) return ''
  if (typeof input === 'string') return String(input).slice(0, 100)
  const summary =
    (input.command as string) ||
    (input.file_path as string) ||
    (input.path as string) ||
    (input.description as string) ||
    ''
  if (typeof summary !== 'string') return JSON.stringify(summary).slice(0, 100)
  return summary.slice(0, 100)
}

function ToolGroupEntry({ message }: { message: ChatMessage }) {
  if (message.type === 'thinking') {
    return (
      <div className="tool-group-entry tool-group-entry--thinking" data-testid={`tool-group-entry-${message.id}`}>
        <span className="tool-group-entry-name">Thinking</span>
      </div>
    )
  }
  const toolName = formatToolName(message.tool ?? 'Tool')
  const summary = getInputSummary(message.toolInput)
  const hasResult = !!message.toolResult
  return (
    <div className="tool-group-entry" data-testid={`tool-group-entry-${message.id}`}>
      <span className="tool-group-entry-marker" aria-hidden="true">
        {hasResult ? '✓' : '›'}
      </span>
      <span className="tool-group-entry-name">{toolName}</span>
      {summary && <span className="tool-group-entry-input">{summary}</span>}
    </div>
  )
}

export function ToolGroup({ messages, isActive }: ToolGroupProps) {
  // Auto-collapse on completion: expand while active, collapse when the
  // run ends. Subsequent expand state lives in component state so a user
  // who toggled stays toggled until the run lifecycle flips again.
  const [expanded, setExpanded] = useState(isActive)
  const wasActiveRef = useRef(isActive)
  useEffect(() => {
    if (wasActiveRef.current && !isActive) setExpanded(false)
    if (!wasActiveRef.current && isActive) setExpanded(true)
    wasActiveRef.current = isActive
  }, [isActive])

  const toolCount = messages.filter((m) => m.type === 'tool_use').length
  const breakdown = formatToolBreakdown(summarizeToolCounts(messages))
  const baseSummary = isActive
    ? `Working... (${toolCount} tool${toolCount !== 1 ? 's' : ''})`
    : `${toolCount} tool${toolCount !== 1 ? 's' : ''} used`
  const summary = breakdown ? `${baseSummary} — ${breakdown}` : baseSummary

  const toggle = () => setExpanded((prev) => !prev)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || (e.key === ' ' && !e.repeat)) {
      e.preventDefault()
      toggle()
    }
  }

  return (
    <div
      className={`tool-group${expanded ? ' expanded' : ''}${isActive ? ' active' : ''}`}
      data-testid="tool-group"
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={toggle}
      onKeyDown={handleKeyDown}
    >
      <div className="tool-group-header">
        {isActive && <span className="tool-group-pulse" aria-hidden="true" />}
        <span className="tool-group-summary">{summary}</span>
        <span className="tool-group-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div className="tool-group-list" data-testid="tool-group-list">
          {messages.map((m) => (
            <ToolGroupEntry key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  )
}
