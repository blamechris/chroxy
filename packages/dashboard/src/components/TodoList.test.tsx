/**
 * TodoList tests (#4139).
 *
 * Covers the parser (parseTodoList) and the renderer (TodoList).
 * The parser is the security-relevant layer — it must not throw on
 * malformed input and must signal null so the caller falls back to
 * plain text. The renderer is a thin layer over the parsed shape.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { TodoList, parseTodoList } from './TodoList'

afterEach(cleanup)

describe('parseTodoList', () => {
  it('parses the canonical executor output', () => {
    const text = [
      'Todo list (3 items): 1 in progress, 1 pending, 1 completed',
      '  [x] Wrote helper (t1)',
      '  [~] Running tests (t2)',
      '  [ ] Address review (t3)',
    ].join('\n')
    const parsed = parseTodoList(text)
    expect(parsed).not.toBeNull()
    expect(parsed?.header).toMatch(/Todo list \(3 items\)/)
    expect(parsed?.items).toHaveLength(3)
    expect(parsed?.items[0]).toEqual({ id: 't1', status: 'completed', content: 'Wrote helper' })
    expect(parsed?.items[1]).toEqual({ id: 't2', status: 'in_progress', content: 'Running tests' })
    expect(parsed?.items[2]).toEqual({ id: 't3', status: 'pending', content: 'Address review' })
  })

  it('parses content containing parentheses (greedy id capture)', () => {
    // Pre-fix non-greedy regex would have grabbed "(timeout" as the id.
    const text = [
      'Todo list (1 items): 0 in progress, 1 pending, 0 completed',
      '  [ ] Run tests (timeout 30s) (t1)',
    ].join('\n')
    const parsed = parseTodoList(text)
    expect(parsed?.items[0]).toEqual({
      id: 't1',
      status: 'pending',
      content: 'Run tests (timeout 30s)',
    })
  })

  it('captures the truncation marker when present', () => {
    const text = [
      'Todo list (150 items): 0 in progress, 150 pending, 0 completed',
      '  [ ] item one (t1)',
      '  … (showing first 100 of 150; full list retained server-side)',
    ].join('\n')
    const parsed = parseTodoList(text)
    expect(parsed?.items).toHaveLength(1)
    expect(parsed?.truncationMarker).toMatch(/showing first 100 of 150/)
  })

  it('returns null when the header does not match (caller falls back to text)', () => {
    expect(parseTodoList('this is just some other tool output')).toBeNull()
    expect(parseTodoList('')).toBeNull()
  })

  it('returns null for non-string input without throwing', () => {
    // The wider type is `string` but in JS callers can wedge through —
    // verify the type guard catches it.
    expect(parseTodoList(undefined as unknown as string)).toBeNull()
    expect(parseTodoList(null as unknown as string)).toBeNull()
  })

  it('skips malformed lines but keeps well-formed ones (graceful degradation)', () => {
    const text = [
      'Todo list (2 items): 0 in progress, 2 pending, 0 completed',
      '  [ ] valid line (t1)',
      '  not a todo line',
      '  [?] unknown marker (t2)',
      '  [ ] another valid (t3)',
    ].join('\n')
    const parsed = parseTodoList(text)
    expect(parsed?.items).toHaveLength(2)
    expect(parsed?.items.map((i) => i.id)).toEqual(['t1', 't3'])
  })
})

describe('TodoList renderer', () => {
  const sample = [
    'Todo list (3 items): 1 in progress, 1 pending, 1 completed',
    '  [x] Wrote helper (t1)',
    '  [~] Running tests (t2)',
    '  [ ] Address review (t3)',
  ].join('\n')

  it('renders header + every item with the right status class', () => {
    render(<TodoList text={sample} />)
    expect(screen.getByTestId('todo-list-header').textContent).toMatch(/3 items/)
    expect(screen.getByTestId('todo-list-item-t1').className).toContain('todo-list-item--completed')
    expect(screen.getByTestId('todo-list-item-t2').className).toContain('todo-list-item--in_progress')
    expect(screen.getByTestId('todo-list-item-t3').className).toContain('todo-list-item--pending')
  })

  it('marker has a status aria-label so screen readers know in_progress vs pending', () => {
    const { container } = render(<TodoList text={sample} />)
    const markers = container.querySelectorAll('.todo-list-marker')
    expect(markers[0]?.getAttribute('aria-label')).toBe('completed')
    expect(markers[1]?.getAttribute('aria-label')).toBe('in progress')
    expect(markers[2]?.getAttribute('aria-label')).toBe('pending')
  })

  it('renders nothing and calls onParseFail when the input is not a TodoWrite result', () => {
    const onParseFail = vi.fn()
    const { container } = render(
      <TodoList text="bash output: command not found" onParseFail={onParseFail} />,
    )
    expect(container.querySelector('.todo-list')).toBeNull()
    expect(onParseFail).toHaveBeenCalledTimes(1)
  })

  it('renders the truncation marker when present', () => {
    const text = [
      'Todo list (150 items): 0 in progress, 150 pending, 0 completed',
      '  [ ] only shown (t1)',
      '  … (showing first 100 of 150; full list retained server-side)',
    ].join('\n')
    render(<TodoList text={text} />)
    expect(screen.getByTestId('todo-list-truncated').textContent).toMatch(/showing first 100/)
  })

  it('renders an empty-state message when the list parses but has no items', () => {
    // Header parses but no [x]/[~]/[ ] lines follow — possible if every
    // line malforms or the model passes an empty list.
    const text = 'Todo list (0 items): 0 in progress, 0 pending, 0 completed'
    render(<TodoList text={text} />)
    expect(screen.getByText('No items.')).toBeInTheDocument()
  })
})
