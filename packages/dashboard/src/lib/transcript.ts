/**
 * Transcript formatter — turns ChatMessage[] into a plain-text or
 * Markdown transcript suitable for pasting into bug reports / PR
 * descriptions / chat. Mirrors the Android app's `[You] / [Claude] /
 * [Tool: ...] / [Tool result] ...` shape so cross-platform diffs are
 * directly comparable (#3073).
 */
import type { ChatMessage } from '../store/types'

export interface TranscriptOptions {
  /** Truncate tool results past this length. Default 200. */
  toolResultPreviewChars?: number
  /** Markdown variant: code-fence tool inputs/results, preserve fenced response blocks. */
  markdown?: boolean
}

const DEFAULT_PREVIEW = 200

function summarizeToolInput(msg: ChatMessage, markdown: boolean): string {
  if (msg.toolInput && typeof msg.toolInput === 'object') {
    const json = JSON.stringify(msg.toolInput)
    if (markdown) return '\n```json\n' + json + '\n```'
    return ` ${json}`
  }
  if (msg.content) {
    return markdown ? '\n```\n' + msg.content + '\n```' : ` ${msg.content}`
  }
  return ''
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max).trimEnd() + '…', truncated: true }
}

/**
 * Build a transcript string from a list of chat messages. System events
 * (status updates, tunnel banners) are filtered. Permission prompts are
 * surfaced with their decision so audit trails remain readable.
 */
export function formatTranscript(messages: ChatMessage[], opts: TranscriptOptions = {}): string {
  const previewChars = opts.toolResultPreviewChars ?? DEFAULT_PREVIEW
  const md = !!opts.markdown
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.type === 'system' || msg.type === 'thinking') continue

    switch (msg.type) {
      case 'user_input':
        lines.push(`[You] ${msg.content}`.trimEnd())
        break

      case 'response':
        if (msg.content && msg.content.trim().length > 0) {
          lines.push(`[Claude] ${msg.content}`.trimEnd())
        }
        break

      case 'tool_use': {
        const toolLabel = msg.tool ?? 'tool'
        lines.push(`[Tool: ${toolLabel}]${summarizeToolInput(msg, md)}`.trimEnd())
        if (msg.toolResult && msg.toolResult.length > 0) {
          const { text, truncated } = truncate(msg.toolResult, previewChars)
          const suffix = truncated || msg.toolResultTruncated ? ' (truncated)' : ''
          if (md) {
            lines.push(`[Tool result]${suffix}\n\`\`\`\n${text}\n\`\`\``)
          } else {
            lines.push(`[Tool result]${suffix} ${text}`.trimEnd())
          }
        }
        break
      }

      case 'prompt': {
        const tool = msg.tool ?? 'tool'
        const decision = msg.answered ? ` → ${msg.answered}` : ' (no response)'
        lines.push(`[Permission: ${tool}]${decision}`)
        break
      }

      case 'error':
        lines.push(`[Error] ${msg.content}`.trimEnd())
        break
    }
  }

  return lines.join('\n\n')
}
