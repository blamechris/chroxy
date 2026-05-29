/**
 * ActivityIndicator pending-background-shell surfacing on mobile (#4422).
 *
 * Mobile parity for the dashboard ActivityIndicator pending-shells surface
 * landed in #4419 (dashboard tests live at
 * `packages/dashboard/src/components/ActivityIndicator.pendingShells.test.tsx`).
 *
 * The store-core slice already populates
 * `sessionStates[id].pendingBackgroundShells` via `handleBackgroundWorkChanged`
 * and the `session_list` seed (#4416 / #4307). This test locks in the
 * mobile renderer half: when an idle session is still waiting on background
 * work, the chip surfaces "Waiting on background work" with the command
 * text rather than disappearing entirely. During an active turn the existing
 * "Running <tool>" label dominates — pending shells are SECONDARY.
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

type PendingShellsTestState = {
  isIdle: boolean;
  lastClientActivityAt: number | null;
  messages?: ChatMessage[];
  pendingBackgroundShells?: { shellId: string; command: string; startedAt: number }[];
  activeTools?: { toolUseId: string; tool: string; startedAt: number }[];
};

function setStore(opts: PendingShellsTestState) {
  const base = createEmptySessionState();
  useConnectionStore.setState({
    activeSessionId: SESSION_ID,
    sessionStates: {
      [SESSION_ID]: {
        ...base,
        isIdle: opts.isIdle,
        lastClientActivityAt: opts.lastClientActivityAt,
        messages: opts.messages ?? [],
        pendingBackgroundShells: opts.pendingBackgroundShells ?? [],
        activeTools: opts.activeTools ?? [],
      },
    },
  });
}

describe('ActivityIndicator — pending background shells on mobile (#4422)', () => {
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

  it('renders "Waiting on background work" with the command text when idle and one shell is pending', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      isIdle: true,
      lastClientActivityAt: now - 2_000,
      pendingBackgroundShells: [
        { shellId: 'brk57kt6pm', command: 'npm run build', startedAt: now - 10_000 },
      ],
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Waiting on background work');
    expect(text).toContain('npm run build');
  });

  it('uses the most-recently-started shell when multiple are pending', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      isIdle: true,
      lastClientActivityAt: now - 2_000,
      pendingBackgroundShells: [
        { shellId: 'oldid01', command: 'sleep 60', startedAt: now - 30_000 },
        { shellId: 'newid02', command: 'npm test', startedAt: now - 5_000 },
      ],
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Waiting on background work');
    expect(text).toContain('npm test');
    expect(text).not.toContain('sleep 60');
  });

  it('falls back to the shellId when the command text is empty', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      isIdle: true,
      lastClientActivityAt: now - 2_000,
      pendingBackgroundShells: [
        { shellId: 'brk57kt6pm', command: '', startedAt: now - 4_000 },
      ],
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Waiting on background work');
    expect(text).toContain('brk57kt6pm');
  });

  it('does not shadow the "Running <tool>" label during an active turn (regression)', () => {
    // _isBusy=true (isIdle=false) with both an in-flight tool AND a pending
    // background shell: the existing tool label must win. Pending shells are
    // SECONDARY during a live turn — they only surface when the turn ends.
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      isIdle: false,
      lastClientActivityAt: now - 2_000,
      activeTools: [
        { toolUseId: 'tu-1', tool: 'WebFetch', startedAt: now - 3_000 },
      ],
      pendingBackgroundShells: [
        { shellId: 'brk57kt6pm', command: 'npm run build', startedAt: now - 10_000 },
      ],
      messages: [
        // The mobile indicator derives the in-flight name from the messages
        // walk (no `activeTools` slot is consulted) — seed a tool_use with no
        // result so it surfaces "Running WebFetch".
        {
          id: 'm-1',
          role: 'assistant',
          type: 'tool_use',
          tool: 'WebFetch',
          content: '',
          timestamp: now - 3_000,
        } as ChatMessage,
      ],
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toMatch(/Running\s+WebFetch/);
    expect(text).not.toContain('Waiting on background work');
  });

  it('renders nothing when idle with no pending background shells (regression)', () => {
    // Pre-#4422 behaviour: idle session renders nothing. Pin this so the new
    // surface only activates when shells are actually pending.
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setStore({
      isIdle: true,
      lastClientActivityAt: now - 1_000,
      pendingBackgroundShells: [],
    });
    const tree = render();
    expect(tree.toJSON()).toBeNull();
  });
});
