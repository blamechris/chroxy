/**
 * ActivityIndicator in-flight tool naming on mobile (#4321 — #4308 mobile parity).
 *
 * Mirrors packages/dashboard/src/components/ActivityIndicator.inflight.test.tsx
 * to lock in the derive-from-messages approach on the mobile app: the
 * indicator walks the active session's `messages[]` backwards to find the
 * most-recent `tool_use` with no result, and surfaces that tool's name +
 * elapsed time. When every tool has resolved (waiting on assistant text
 * between tool runs) the indicator falls back to the original
 * "Working… last activity" label.
 *
 * Pattern matches the sibling ActivityIndicator.test.tsx — react-test-renderer
 * + act, Zustand stores driven via setState (not mocked).
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { ActivityIndicator } from '../ActivityIndicator';
import { useConnectionStore } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { createEmptySessionState } from '../../store/utils';
import type { ChatMessage } from '../../store/connection';

const SESSION_ID = 's-test';
const TIMEOUT_30MIN = 30 * 60_000;

function collectVisibleText(root: ReactTestInstance): string {
  return root.findAllByType(Text).map((node) => {
    const c = node.props.children;
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (Array.isArray(c)) {
      return c.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('');
    }
    return '';
  }).join(' ');
}

function setStore(opts: { isIdle?: boolean; lastClientActivityAt?: number | null; messages: ChatMessage[] }) {
  const base = createEmptySessionState();
  useConnectionStore.setState({
    activeSessionId: SESSION_ID,
    sessionStates: {
      [SESSION_ID]: {
        ...base,
        isIdle: opts.isIdle ?? false,
        lastClientActivityAt: opts.lastClientActivityAt ?? Date.now() - 3_000,
        messages: opts.messages,
      },
    },
  });
}

describe('ActivityIndicator — in-flight tool naming (#4321 / #4308)', () => {
  let activeTree: renderer.ReactTestRenderer | null = null;

  function render(): renderer.ReactTestRenderer {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<ActivityIndicator />); });
    activeTree = tree;
    return tree;
  }

  beforeEach(() => {
    useConnectionStore.setState({ activeSessionId: null, sessionStates: {} });
    useConnectionLifecycleStore.setState({ serverResultTimeoutMs: TIMEOUT_30MIN });
  });

  afterEach(() => {
    if (activeTree) {
      act(() => { activeTree!.unmount(); });
      activeTree = null;
    }
    jest.useRealTimers();
  });

  it('names the most-recent tool_use without a result and shows elapsed time', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      lastClientActivityAt: now - 3_000,
      messages: [
        // Earlier resolved tool — should NOT be picked.
        { id: 'm1', type: 'tool_use', tool: 'Read', timestamp: now - 60_000, toolResult: 'contents', content: '', toolUseId: 'tu-1' },
        // Most-recent unresolved tool — this is what the indicator names.
        { id: 'm2', type: 'tool_use', tool: 'Bash', timestamp: now - 5_000, content: '', toolUseId: 'tu-2' },
      ],
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toMatch(/Running\s+Bash/);
    expect(text).toMatch(/5s$|5s\s/);
    expect(text).not.toMatch(/Working… last activity/);
  });

  it('falls back to the original "Working… last activity" label when no tool is in flight', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      lastClientActivityAt: now - 5_000,
      messages: [
        { id: 'm1', type: 'tool_use', tool: 'Bash', timestamp: now - 20_000, toolResult: 'done', content: '', toolUseId: 'tu-1' },
      ],
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toMatch(/Working… last activity/);
    expect(text).not.toMatch(/Running/);
  });

  it('treats an empty-string toolResult as resolved (no in-flight indicator)', () => {
    // A tool that finished with no output (toolResult === '') must NOT
    // be picked as in-flight. Same predicate the ToolBubble pulse uses.
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      lastClientActivityAt: now - 5_000,
      messages: [
        { id: 'm1', type: 'tool_use', tool: 'Bash', timestamp: now - 5_000, toolResult: '', content: '', toolUseId: 'tu-1' },
      ],
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).not.toMatch(/Running/);
  });

  it('treats toolResultImages-only resolution as resolved (no in-flight indicator)', () => {
    // Some tools resolve with images and no toolResult string. Match
    // the dashboard `hasResult` predicate so these aren't shown as
    // in-flight.
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      lastClientActivityAt: now - 5_000,
      messages: [
        {
          id: 'm1',
          type: 'tool_use',
          tool: 'Bash',
          timestamp: now - 5_000,
          content: '',
          toolUseId: 'tu-1',
          toolResultImages: [{ data: 'x', mediaType: 'image/png' }],
        },
      ],
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).not.toMatch(/Running/);
  });

  it('renders nothing when the session is idle (no indicator even with an unresolved tool)', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      isIdle: true,
      lastClientActivityAt: now - 1_000,
      messages: [
        { id: 'm1', type: 'tool_use', tool: 'Bash', timestamp: now - 1_000, content: '', toolUseId: 'tu-1' },
      ],
    });
    const tree = render();
    expect(tree.toJSON()).toBeNull();
  });

  it('formats MCP-style tool names via the shared formatter (mobile parity with dashboard)', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      lastClientActivityAt: now - 3_000,
      messages: [
        { id: 'm1', type: 'tool_use', tool: 'mcp__github__list_repos', timestamp: now - 5_000, content: '', toolUseId: 'tu-1' },
      ],
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    // formatToolName converts `mcp__github__list_repos` → `Github: List Repos`.
    expect(text).toMatch(/Running\s+Github: List Repos/);
  });
});
