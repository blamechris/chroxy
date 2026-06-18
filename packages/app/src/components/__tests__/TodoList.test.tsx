/**
 * Tests for the mobile TodoList parser + renderer (#4180).
 *
 * Mirrors the dashboard test coverage in
 * `packages/dashboard/src/components/TodoList.test.tsx`: the parser is the
 * security-relevant layer (must not throw on malformed input, returns
 * null to signal fallback), the renderer is a thin layer over the
 * parsed shape.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { TodoList, parseTodoList } from '../chat/TodoList';

function renderTodoList(text: string): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(<TodoList text={text} />);
  });
  return root;
}

describe('parseTodoList', () => {
  it('parses the canonical executor output', () => {
    const text = [
      'Todo list (3 items): 1 in progress, 1 pending, 1 completed',
      '  [x] Wrote helper (t1)',
      '  [~] Running tests (t2)',
      '  [ ] Address review (t3)',
    ].join('\n');
    const parsed = parseTodoList(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.header).toMatch(/Todo list \(3 items\)/);
    expect(parsed?.items).toHaveLength(3);
    expect(parsed?.items[0]).toEqual({ id: 't1', status: 'completed', content: 'Wrote helper' });
    expect(parsed?.items[1]).toEqual({ id: 't2', status: 'in_progress', content: 'Running tests' });
    expect(parsed?.items[2]).toEqual({ id: 't3', status: 'pending', content: 'Address review' });
  });

  it('parses content containing parentheses (greedy id capture)', () => {
    // The greedy `.+` ensures "Run tests (timeout 30s)" parses cleanly —
    // the LAST parens capture the id, not the first.
    const text = [
      'Todo list (1 items): 0 in progress, 1 pending, 0 completed',
      '  [ ] Run tests (timeout 30s) (t1)',
    ].join('\n');
    const parsed = parseTodoList(text);
    expect(parsed?.items[0]).toEqual({
      id: 't1',
      status: 'pending',
      content: 'Run tests (timeout 30s)',
    });
  });

  it('captures the truncation marker when present', () => {
    const text = [
      'Todo list (150 items): 0 in progress, 150 pending, 0 completed',
      '  [ ] item one (t1)',
      '  … (showing first 100 of 150; full list retained server-side)',
    ].join('\n');
    const parsed = parseTodoList(text);
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.truncationMarker).toMatch(/showing first 100 of 150/);
  });

  it('returns null when the header does not match (caller falls back to text)', () => {
    expect(parseTodoList('this is just some other tool output')).toBeNull();
    expect(parseTodoList('')).toBeNull();
  });

  it('returns null for non-string input without throwing', () => {
    expect(parseTodoList(undefined as unknown as string)).toBeNull();
    expect(parseTodoList(null as unknown as string)).toBeNull();
  });

  it('skips malformed lines but keeps well-formed ones (graceful degradation)', () => {
    const text = [
      'Todo list (2 items): 0 in progress, 2 pending, 0 completed',
      '  [ ] valid line (t1)',
      '  not a todo line',
      '  [?] unknown marker (t2)',
      '  [ ] another valid (t3)',
    ].join('\n');
    const parsed = parseTodoList(text);
    expect(parsed?.items).toHaveLength(2);
    expect(parsed?.items.map((i) => i.id)).toEqual(['t1', 't3']);
  });
});

describe('TodoList renderer', () => {
  const sample = [
    'Todo list (3 items): 1 in progress, 1 pending, 1 completed',
    '  [x] Wrote helper (t1)',
    '  [~] Running tests (t2)',
    '  [ ] Address review (t3)',
  ].join('\n');

  function findByTestId(root: renderer.ReactTestRenderer, id: string) {
    return root.root.findAllByProps({ testID: id });
  }

  it('renders header + every item with the right testID', () => {
    const root = renderTodoList(sample);
    expect(findByTestId(root, 'todo-list-header')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-item-t1')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-item-t2')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-item-t3')[0]).toBeTruthy();
  });

  it('renders the header content verbatim', () => {
    const root = renderTodoList(sample);
    const header = findByTestId(root, 'todo-list-header')[0];
    expect(header.props.children).toMatch(/3 items/);
  });

  it('marker has a status accessibilityLabel for screen readers', () => {
    const root = renderTodoList(sample);
    // Each marker is a Text with an accessibilityLabel — collect them.
    const texts = root.root.findAllByType(Text);
    const labels = texts
      .map((t) => t.props.accessibilityLabel)
      .filter((l): l is string => typeof l === 'string');
    expect(labels).toContain('completed');
    expect(labels).toContain('in progress');
    expect(labels).toContain('pending');
  });

  it('renders nothing when the input is not a TodoWrite result', () => {
    let root!: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<TodoList text="bash output: command not found" />);
    });
    // Root component returns null → ReactTestRenderer's toJSON() is null.
    expect(root.toJSON()).toBeNull();
  });

  it('renders the truncation marker when present', () => {
    const text = [
      'Todo list (150 items): 0 in progress, 150 pending, 0 completed',
      '  [ ] only shown (t1)',
      '  … (showing first 100 of 150; full list retained server-side)',
    ].join('\n');
    const root = renderTodoList(text);
    const trunc = findByTestId(root, 'todo-list-truncated')[0];
    expect(trunc).toBeTruthy();
    expect(trunc.props.children).toMatch(/showing first 100/);
  });

  it('renders an empty-state message when the list parses but has no items', () => {
    const root = renderTodoList('Todo list (0 items): 0 in progress, 0 pending, 0 completed');
    const texts = root.root.findAllByType(Text);
    const allChildren = texts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string');
    expect(allChildren).toContain('No items.');
  });
});
