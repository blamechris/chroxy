/**
 * #7326 -- the mobile Chat feed shows a chip on a turn that was cut off, refused
 * or stopped, and nothing extra on one that finished.
 *
 * Rendered through the real ChatView (the shared buildChatViewMessages pipeline
 * + the app's own row branch) and the real store-core marker builder, so removing
 * either the pipeline's pass-through for the marker row or ChatView's branch for
 * it turns this red rather than leaving a transcript that looks complete.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, FlatList, Text } from 'react-native';
import { appendTurnOutcomeMarker } from '@chroxy/store-core';

jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: { sendInput: () => void; activeSessionId: string | null }) => unknown) =>
    selector({ sendInput: () => {}, activeSessionId: null }),
}));

import { ChatView } from '../ChatView';
import { selectChatMessages } from '../../screens/selectChatMessages';
import { isHiddenInCompactMode } from '@chroxy/store-core';
import type { ChatMessage } from '../../store/types';
import type { ConnectionState } from '../../store/types';
import type { DisplayGroup } from '@chroxy/store-core';
import { _testMessageHandler, resetAllHandlerState, setStore } from '../../store/message-handler';
import { createEmptySessionState } from '../../store/utils';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';

beforeAll(() => {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const noop = () => {};
const reply = (id: string, content: string): ChatMessage =>
  ({ id, type: 'response', content, timestamp: 1000 }) as ChatMessage;

function renderFeed(messages: ChatMessage[]) {
  const ref = React.createRef<FlatList>();
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ChatView
        messages={messages}
        scrollViewRef={ref as unknown as React.RefObject<FlatList<unknown> | null>}
        claudeReady
        onSelectOption={noop}
        isCliMode={false}
        selectedIds={new Set<string>()}
        isSelecting={false}
        isSelectingRef={{ current: false } as React.MutableRefObject<boolean>}
        onToggleSelection={noop}
        streamingMessageId={null}
        isPlanPending={false}
        planAllowedPrompts={[]}
        onApprovePlan={noop}
        onFocusInput={noop}
      />,
    );
  });
  return tree;
}

const chips = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll((n) => n.props?.testID === 'turn-outcome-marker' && typeof n.type === 'string');

const labels = (tree: renderer.ReactTestRenderer) =>
  tree.root
    .findAll((n) => n.props?.testID === 'turn-outcome-marker-label' && n.type === Text)
    .map((n) => n.props.children);

describe('ChatView turn-outcome chip (#7326)', () => {
  it.each([
    ['truncated', 'Reply cut off'],
    ['refused', 'The model declined'],
    ['stopped', 'Stopped'],
  ] as const)('shows the "%s" chip after the turn it describes', (outcome, label) => {
    const messages = appendTurnOutcomeMarker([reply('r1', 'half an answer')], { outcome, timestamp: 1 });
    const tree = renderFeed(selectChatMessages(messages, { chatFilterCompact: false, isHiddenInCompactMode }));
    expect(chips(tree).length).toBeGreaterThan(0);
    expect(labels(tree)).toEqual([label]);
    act(() => tree.unmount());
  });

  it('shows no chip for a turn that finished (no marker message is ever built)', () => {
    const messages = appendTurnOutcomeMarker([reply('r1', 'all done')], null);
    const tree = renderFeed(messages);
    expect(chips(tree)).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('keeps the chip with compact mode on (it is not a tool or thinking row)', () => {
    const messages = appendTurnOutcomeMarker([reply('r1', 'x')], { outcome: 'refused', timestamp: 1 });
    const tree = renderFeed(selectChatMessages(messages, { chatFilterCompact: true, isHiddenInCompactMode }));
    expect(labels(tree)).toEqual(['The model declined']);
    act(() => tree.unmount());
  });
});

describe('ChatView final replay list keys (#8240)', () => {
  afterEach(() => {
    resetAllHandlerState();
    _testMessageHandler.clearContext();
  });

  it.each([false, true])('keeps one authoritative compaction row after every actual handler frame (compact=%s)', chatFilterCompact => {
    resetAllHandlerState();
    const cachedMarker: ChatMessage = {
      id: 'compact-1', type: 'system', content: 'cached compaction', timestamp: 2,
      compactMetadata: { trigger: 'auto', preTokens: 100, postTokens: 10, durationMs: 1 },
    };
    let state = {
      activeSessionId: 's1', myClientId: 'me',
      sessions: [{ sessionId: 's1', name: 'S1' }],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [
          { id: 'input-1', type: 'user_input', content: 'prompt', timestamp: 1 },
          cachedMarker,
          reply('response-1', 'cached reply'),
        ] },
      },
    } as unknown as ConnectionState;
    setStore({
      getState: () => state,
      setState: (updater: Partial<ConnectionState> | ((previous: ConnectionState) => Partial<ConnectionState>)) => {
        state = { ...state, ...(typeof updater === 'function' ? updater(state) : updater) };
      },
    } as never);
    _testMessageHandler.setContext(createMockConnectionContext());

    const frame = (message: Record<string, unknown>) => {
      _testMessageHandler.handle(message);
      const tree = renderFeed(selectChatMessages(state.sessionStates.s1.messages, { chatFilterCompact, isHiddenInCompactMode }));
      try {
        const list = tree.root.findByType(FlatList);
        const groups = list.props.data as DisplayGroup[];
        const keys = groups.map((group, index) => list.props.keyExtractor(group, index));
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.filter(key => key === 'compact-1')).toHaveLength(1);
        return { groups, keys };
      } finally {
        act(() => tree.unmount());
      }
    };

    frame({ type: 'history_replay_start', sessionId: 's1', fullHistory: true });
    frame({ type: 'message', messageType: 'user_input', sessionId: 's1', messageId: 'input-1', content: 'prompt', timestamp: 1, historySeq: 1 });
    const replayed = frame({
      type: 'message', messageType: 'system', sessionId: 's1', messageId: 'compact-1',
      subtype: 'compact_boundary',
      content: 'authoritative compaction', timestamp: 2, historySeq: 2,
      compactMetadata: { trigger: 'manual', preTokens: 200, postTokens: 20, durationMs: 2 },
    });
    // Reconciliation storage still contains BOTH copies, but the real FlatList
    // has one row and uses the authoritative metadata from the appended tail.
    expect(state.sessionStates.s1.messages.filter(message => message.id === 'compact-1')).toHaveLength(2);
    expect(state.sessionStates.s1.messages[1]).toBe(cachedMarker);
    const marker = replayed.groups.find(group => group.type === 'single' && group.message.id === 'compact-1');
    expect(marker?.type === 'single' ? marker.message : null).toMatchObject({
      content: 'authoritative compaction', compactMetadata: { trigger: 'manual', preTokens: 200 },
    });
    frame({ type: 'message', messageType: 'response', sessionId: 's1', messageId: 'response-1', content: 'authoritative reply', timestamp: 3, historySeq: 3 });
    const ended = frame({ type: 'history_replay_end', sessionId: 's1', latestSeq: 3 });
    expect(ended.keys).toEqual(['input-1', 'compact-1', 'response-1']);
    expect(state.sessionStates.s1.messages).toHaveLength(3);
  });
});
