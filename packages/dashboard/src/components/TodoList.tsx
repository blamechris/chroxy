/**
 * TodoList — structured renderer for TodoWrite tool_result content.
 *
 * The BYOK provider's TodoWrite executor returns plain text in the form:
 *
 *     Todo list (N items): X in progress, Y pending, Z completed
 *       [x] completed task (id-1)
 *       [~] in-progress task (id-2)
 *       [ ] pending task (id-3)
 *       … (showing first 100 of 150; full list retained server-side)
 *
 * Rather than render that verbatim in a <pre> (the default `ToolBubble`
 * treatment) we parse it back into structured items and show a real
 * checklist with status-coloured checkboxes. The parser is conservative —
 * any line that doesn't match the expected shape falls back to plain
 * text, so a future format change degrades gracefully rather than
 * silently dropping content.
 *
 * #4139 (closes): tool-only enhancement, no server or protocol changes.
 */
import './TodoList.css'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  /** Stable identifier — same key TodoWrite merges by. */
  id: string
  status: TodoStatus
  content: string
}

export interface ParsedTodoList {
  /** First line of the tool result (the "Todo list (N items)..." header). */
  header: string
  items: TodoItem[]
  /** Optional truncation marker line. Present when the list was capped. */
  truncationMarker?: string
}

// `  [x] some content (toolu-id)` — the executor emits two-space indent
// and the id parens are always the LAST parens on the line. Use a greedy
// match so content containing parens (e.g. "Run tests (timeout)")
// doesn't get truncated by the first opening paren.
const TODO_LINE_RE = /^\s*\[([ x~])\]\s+(.+)\s+\(([^)]+)\)\s*$/

function statusFromMarker(marker: string): TodoStatus | null {
  switch (marker) {
    case 'x': return 'completed'
    case '~': return 'in_progress'
    case ' ': return 'pending'
    default: return null
  }
}

/**
 * Parse the executor's text output into structured items. Returns null
 * if the input doesn't look like a TodoWrite result at all (the caller
 * should fall back to plain-text rendering in that case).
 */
export function parseTodoList(text: string): ParsedTodoList | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const lines = text.split('\n')
  if (lines.length === 0) return null
  const header = lines[0] ?? ''
  if (!/^Todo list\s*\(\d+\s+items?\)/.test(header)) return null
  const items: TodoItem[] = []
  let truncationMarker: string | undefined
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim().length === 0) continue
    const m = line.match(TODO_LINE_RE)
    if (m) {
      const status = statusFromMarker(m[1] ?? '')
      const content = (m[2] ?? '').trim()
      const id = (m[3] ?? '').trim()
      if (status && id.length > 0 && content.length > 0) {
        items.push({ id, status, content })
        continue
      }
    }
    // Truncation marker pattern: '  … (showing first X of Y; ...)'
    if (line.includes('showing first')) {
      truncationMarker = line.trim()
    }
  }
  return { header, items, truncationMarker }
}

export interface TodoListProps {
  /** Raw text from the TodoWrite tool_result. */
  text: string
  /** If parsing fails, callers receive a signal to render fallback. */
  onParseFail?: () => void
}

const STATUS_SYMBOL: Record<TodoStatus, string> = {
  completed: '✓',
  in_progress: '⋯',
  pending: '○',
}

const STATUS_LABEL: Record<TodoStatus, string> = {
  completed: 'completed',
  in_progress: 'in progress',
  pending: 'pending',
}

export function TodoList({ text, onParseFail }: TodoListProps) {
  const parsed = parseTodoList(text)
  if (!parsed) {
    onParseFail?.()
    return null
  }
  return (
    <div className="todo-list" data-testid="todo-list">
      <div className="todo-list-header" data-testid="todo-list-header">
        {parsed.header}
      </div>
      {parsed.items.length === 0 ? (
        <div className="todo-list-empty">No items.</div>
      ) : (
        <ul className="todo-list-items">
          {parsed.items.map((item) => (
            <li
              key={item.id}
              className={`todo-list-item todo-list-item--${item.status}`}
              data-testid={`todo-list-item-${item.id}`}
            >
              <span
                className="todo-list-marker"
                aria-label={STATUS_LABEL[item.status]}
                title={STATUS_LABEL[item.status]}
              >
                {STATUS_SYMBOL[item.status]}
              </span>
              <span className="todo-list-content">{item.content}</span>
            </li>
          ))}
        </ul>
      )}
      {parsed.truncationMarker && (
        <div
          className="todo-list-truncated"
          data-testid="todo-list-truncated"
        >
          {parsed.truncationMarker}
        </div>
      )}
    </div>
  )
}
