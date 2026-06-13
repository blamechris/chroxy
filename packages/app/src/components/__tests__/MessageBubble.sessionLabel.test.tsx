/**
 * MessageBubble permission-prompt session label — #5674 (epic #5693)
 *
 * When several chats run at once, a permission prompt must say WHICH session is
 * asking, so the operator never approves the wrong agent's action. The
 * dashboard already labels prompts (#5667); this is the mobile parity:
 *
 *   1. `buildPromptSessionLabel` derives a short "name · provider" label from a
 *      prompt's `originSessionId`, and returns undefined when there's nothing to
 *      disambiguate (no origin, unknown session, or a single session).
 *   2. The bubble renders that label (testID `prompt-session-label`) on a live
 *      prompt when 2+ sessions exist, and omits it for a single session.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { MessageBubble, buildPromptSessionLabel } from '../chat/MessageBubble';
import { useConnectionStore } from '../../store/connection';
import type { ChatMessage } from '../../store/types';
import type { SessionInfo } from '../../store/types';

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's-1',
    name: 'chat-A',
    cwd: '/tmp',
    type: 'cli',
    hasTerminal: false,
    model: null,
    permissionMode: null,
    isBusy: false,
    createdAt: 0,
    conversationId: null,
    ...overrides,
  } as SessionInfo;
}

function makePrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'q-1',
    type: 'prompt',
    content: 'Run this command?',
    timestamp: Date.now(),
    toolUseId: 'toolu_label',
    requestId: 'req-label',
    tool: 'Bash(rm -rf build)',
    options: [
      { label: 'Approve', value: 'approve' },
      { label: 'Deny', value: 'deny' },
    ],
    ...overrides,
  } as ChatMessage;
}

// MessageBubble subscribes to useConnectionStore, so every mounted tree must be
// torn down — otherwise an orphan subscriber survives the test and re-renders
// (with an act() warning, or a flaky failure) when a later suite mutates the
// store outside act. Track each tree and unmount in afterEach.
const mountedTrees: renderer.ReactTestRenderer[] = [];

function render(message: ChatMessage) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <MessageBubble
        message={message}
        isSelected={false}
        isSelecting={false}
        onLongPress={() => {}}
        onPress={() => {}}
        onOpenDetail={() => {}}
        onSelectOption={() => {}}
      />,
    );
  });
  mountedTrees.push(tree);
  return tree;
}

describe('buildPromptSessionLabel (#5674)', () => {
  const two = [
    makeSession({ sessionId: 's-1', name: 'chat-A', provider: 'claude' }),
    makeSession({ sessionId: 's-2', name: 'chat-B', provider: 'codex' }),
  ];

  it('returns undefined when there is nothing to disambiguate', () => {
    expect(buildPromptSessionLabel(undefined, two)).toBeUndefined(); // no origin
    expect(buildPromptSessionLabel('s-1', [two[0]])).toBeUndefined(); // single session
    expect(buildPromptSessionLabel('s-unknown', two)).toBeUndefined(); // origin not in list
  });

  it('labels with the owning session name', () => {
    expect(buildPromptSessionLabel('s-2', two)).toBe('chat-B · codex');
  });

  it('omits the provider suffix when absent and falls back to the id for an empty name', () => {
    const sessions = [
      makeSession({ sessionId: 's-1', name: 'chat-A' }),
      makeSession({ sessionId: 's-2', name: '   ', provider: '' }),
    ];
    expect(buildPromptSessionLabel('s-1', sessions)).toBe('chat-A'); // no provider
    expect(buildPromptSessionLabel('s-2', sessions)).toBe('s-2'); // blank name → id
  });
});

describe('MessageBubble session label render (#5674)', () => {
  afterEach(() => {
    act(() => {
      // Unmount every tree BEFORE resetting the store so no orphan subscriber
      // re-renders on the sessions change (avoids cross-suite act() warnings).
      while (mountedTrees.length) mountedTrees.pop()!.unmount();
      useConnectionStore.setState({ sessions: [] });
    });
  });

  it('renders the owning-session label on a live prompt when 2+ sessions exist', () => {
    act(() => {
      useConnectionStore.setState({
        sessions: [
          makeSession({ sessionId: 's-1', name: 'chat-A', provider: 'claude' }),
          makeSession({ sessionId: 's-2', name: 'chat-B', provider: 'codex' }),
        ],
      });
    });
    const tree = render(makePrompt({ originSessionId: 's-2' }));
    const label = tree.root.findByProps({ testID: 'prompt-session-label' });
    expect(label.props.children).toBe('chat-B · codex');
  });

  it('omits the label when only one session exists', () => {
    act(() => {
      useConnectionStore.setState({
        sessions: [makeSession({ sessionId: 's-1', name: 'chat-A' })],
      });
    });
    const tree = render(makePrompt({ originSessionId: 's-1' }));
    expect(tree.root.findAllByProps({ testID: 'prompt-session-label' })).toHaveLength(0);
  });

  it('omits the label once the prompt is answered (no stale "who is asking" on a resolved prompt)', () => {
    act(() => {
      useConnectionStore.setState({
        sessions: [
          makeSession({ sessionId: 's-1', name: 'chat-A' }),
          makeSession({ sessionId: 's-2', name: 'chat-B' }),
        ],
      });
    });
    // An answered AskUserQuestion prompt (no requestId) still reaches the main
    // render path — the !message.answered gate must keep the label off it.
    const tree = render(makePrompt({ originSessionId: 's-2', requestId: undefined, answered: 'approve' }));
    expect(tree.root.findAllByProps({ testID: 'prompt-session-label' })).toHaveLength(0);
  });
});
