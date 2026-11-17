/**
 * #9161: the permission history lists pending and finished prompts. A finished
 * dev_preview entry reads as a record ("Asked to allow once..."); a pending one
 * is still awaiting a decision and keeps the live consent copy.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { PermissionHistoryScreen } from '../PermissionHistoryScreen';
import type { ChatMessage } from '../../store/types';

const input = { target: { host: '127.0.0.1', port: 3100, pid: 1, command: 'x', cwd: '/tmp' }, exposure: 'Public HTTP URL.' };
const mockState: { sessions: unknown[]; sessionStates: Record<string, { messages: ChatMessage[] }> } = {
  sessions: [{ sessionId: 's1', name: 'One' }],
  sessionStates: {},
};
jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

function flat(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(flat).join('');
  if (value && typeof value === 'object' && 'props' in value) return flat((value as { props: { children?: unknown } }).props.children);
  return '';
}
const text = (root: ReactTestInstance) => root.findAllByType(Text).map((n) => flat(n.props.children)).join(' | ');

function expandedText(message: Partial<ChatMessage>): string {
  mockState.sessionStates = { s1: { messages: [{
    id: 'p1', type: 'prompt', requestId: 'r1', tool: 'dev_preview', content: 'dev_preview: open',
    toolInput: input, timestamp: Date.now(), ...message,
  } as ChatMessage] } };
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<PermissionHistoryScreen />); });
  const row = tree.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' &&
    /dev_preview|Dev/i.test(n.props.accessibilityLabel) && typeof n.props.onPress === 'function')[0]!;
  act(() => row.props.onPress());
  const out = text(tree.root);
  act(() => tree.unmount());
  return out;
}

describe('PermissionHistoryScreen dev_preview wording (#9161)', () => {
  it('a pending entry keeps the live consent copy', () => {
    const out = expandedText({ expiresAt: Date.now() + 60_000 });
    expect(out).toContain('Pending');
    expect(out).toMatch(/(^|\| )Allow once for this connection/);
    expect(out).not.toContain('Asked to allow once');
  });

  it.each([
    ['allowed', { answered: 'allow' }],
    ['denied', { answered: 'deny' }],
    ['expired', { expiresAt: Date.now() - 1000 }],
    ['stopped', { permissionOutcome: 'stopped' }],
  ] as const)('a %s entry reads as a record', (_name, extra) => {
    const out = expandedText(extra as Partial<ChatMessage>);
    expect(out).toContain('Asked to allow once for this connection');
    expect(out).not.toMatch(/(^|\| )Allow once for this connection/);
  });
});
