/**
 * #8461 -- the session card previews the reply, not the "Reply cut off" chip that
 * follows it. Rendered through the real SessionOverview (store mocked), so a card
 * that stops using `lastPreviewMessage` turns this red.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

type StoreState = Record<string, unknown>;
let mockState: StoreState = {};
jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: StoreState) => unknown) => selector(mockState),
}));

import { SessionOverview } from '../SessionOverview';
import type { ChatMessage } from '../../store/types';

const msg = (over: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>): ChatMessage =>
  ({ content: '', timestamp: 1, ...over }) as ChatMessage;

function renderOverview(messages: ChatMessage[]): string[] {
  mockState = {
    sessions: [{ sessionId: 's1', name: 'Work', isBusy: false, createdAt: 1, model: null }],
    activeSessionId: 's1',
    sessionStates: { s1: { messages, health: 'healthy', isIdle: true, activeAgents: [], isPlanPending: false } },
    sessionNotifications: [],
    switchSession: () => {},
    destroySession: () => {},
    renameSession: () => {},
    totalCost: null,
    costBudget: null,
  };
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<SessionOverview onClose={() => {}} />);
  });
  const texts = tree.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
  act(() => tree.unmount());
  return texts;
}

describe('SessionOverview card preview and turn-outcome chips (#8461)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const reply = msg({ id: 'r1', type: 'response', content: 'half an answer' });
  const chip = msg({ id: 'o1', type: 'system', content: 'Reply cut off', turnOutcome: 'truncated' } as Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>);

  it('previews the reply when the last message is a chip', () => {
    const texts = renderOverview([reply, chip]);
    expect(texts.some((t) => t.includes('half an answer'))).toBe(true);
    expect(texts.some((t) => t.includes('Reply cut off'))).toBe(false);
  });

  it('control: previews an ordinary last message as before', () => {
    const texts = renderOverview([reply]);
    expect(texts.some((t) => t.includes('half an answer'))).toBe(true);
  });
});
