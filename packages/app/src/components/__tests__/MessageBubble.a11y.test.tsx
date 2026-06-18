/**
 * MessageBubble accessibility / touch-target — #5634
 *
 * The permission Approve/Deny option buttons are the single most
 * security-sensitive tap in the app (approving e.g. `Bash(rm …)`). They
 * must expose proper VoiceOver semantics so a screen-reader user knows
 * exactly what they are approving, and reflect their disabled/selected
 * state. This suite asserts:
 *
 *   1. Option buttons carry `accessibilityRole="button"`, an
 *      `accessibilityLabel` that combines the option label with the tool
 *      context, and an `accessibilityState` wired to the real
 *      disabled/chosen variables in scope.
 *   2. Answering the prompt flips `accessibilityState.disabled` true on all
 *      options and `selected` true on the chosen one.
 *   3. The freeform Other Send/Cancel buttons carry role + label, and Send
 *      reflects the empty-input disabled state.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { OTHER_OPTION_VALUE } from '@chroxy/store-core';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';

// #5699 — answer controls now gate on a live connection. These tests exercise
// the normal (connected) behaviour, so establish that precondition; the
// disconnected gate has its own dedicated test below.
beforeEach(() => {
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
});

function makePrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'q-1',
    type: 'prompt',
    content: 'Run this command?',
    timestamp: Date.now(),
    toolUseId: 'toolu_a11y',
    requestId: 'req-a11y',
    tool: 'Bash(rm -rf build)',
    options: [
      { label: 'Approve', value: 'approve' },
      { label: 'Deny', value: 'deny' },
      { label: 'Other', value: OTHER_OPTION_VALUE },
    ],
    ...overrides,
  } as ChatMessage;
}

function render(message: ChatMessage, onSelectOption: jest.Mock = jest.fn()) {
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
        onSelectOption={onSelectOption}
      />,
    );
  });
  return tree;
}

describe('MessageBubble accessibility (#5634)', () => {
  it('gives option buttons role, tool-aware label, and unanswered state', () => {
    const tree = render(makePrompt());
    const approve = tree.root.findByProps({ testID: 'approval-button-approve' });
    expect(approve.props.accessibilityRole).toBe('button');
    // Label combines the option label with the tool context so a
    // screen-reader user hears what they are approving.
    expect(approve.props.accessibilityLabel).toBe('Approve, Bash(rm -rf build)');
    // Unanswered → not disabled, not selected.
    expect(approve.props.accessibilityState).toEqual({ disabled: false, selected: false });
  });

  it('falls back to the bare option label when there is no tool context', () => {
    const tree = render(makePrompt({ tool: undefined }));
    const approve = tree.root.findByProps({ testID: 'approval-button-approve' });
    expect(approve.props.accessibilityLabel).toBe('Approve');
  });

  it('flips accessibilityState to disabled+selected once answered', () => {
    // Drop requestId so the bubble keeps rendering the option buttons (a
    // permission prompt with a requestId collapses to a pill once answered;
    // user_question prompts keep the disabled+chosen buttons visible — that is
    // the path that exercises the accessibilityState wiring).
    const tree = render(makePrompt({ answered: 'approve', requestId: undefined }));
    const approve = tree.root.findByProps({ testID: 'approval-button-approve' });
    const deny = tree.root.findByProps({ testID: 'approval-button-deny' });
    // The chosen option is disabled AND selected.
    expect(approve.props.accessibilityState).toEqual({ disabled: true, selected: true });
    // The non-chosen option is disabled but not selected.
    expect(deny.props.accessibilityState).toEqual({ disabled: true, selected: false });
  });

  it('gives the Other Send/Cancel buttons role + label and disabled Send when empty', () => {
    const tree = render(makePrompt());
    const otherBtn = tree.root.findByProps({ testID: `approval-button-${OTHER_OPTION_VALUE}` });
    act(() => {
      otherBtn.props.onPress?.();
    });
    const send = tree.root.findByProps({ testID: 'approval-freetext-send' });
    expect(send.props.accessibilityRole).toBe('button');
    expect(send.props.accessibilityLabel).toBe('Send response, Bash(rm -rf build)');
    // Empty input → Send is disabled.
    expect(send.props.accessibilityState).toEqual({ disabled: true });

    // Cancel carries the same button role and an explicit label so a
    // screen-reader user can back out of the freeform response.
    const cancel = tree.root.findByProps({ testID: 'approval-freetext-cancel' });
    expect(cancel.props.accessibilityRole).toBe('button');
    expect(cancel.props.accessibilityLabel).toBe('Cancel response');

    // After typing, Send is no longer disabled.
    const inputs = tree.root.findAllByProps({ testID: 'approval-freetext-input' });
    act(() => {
      inputs[0].props.onChangeText?.('do something else');
    });
    const sendAfter = tree.root.findByProps({ testID: 'approval-freetext-send' });
    expect(sendAfter.props.accessibilityState).toEqual({ disabled: false });
  });

  it('disables answer buttons and shows a reconnect hint while disconnected (#5699)', () => {
    useConnectionLifecycleStore.setState({ connectionPhase: 'disconnected' });
    const onSelectOption = jest.fn();
    const tree = render(makePrompt(), onSelectOption);

    // The option buttons are present but disabled (the answer can't reach the
    // server's expired pending request) — not a tappable no-op.
    const approve = tree.root.findByProps({ testID: 'approval-button-approve' });
    expect(approve.props.accessibilityState).toEqual({ disabled: true, selected: false });
    expect(approve.props.disabled).toBe(true);

    // A clear "reconnect to respond" hint replaces the silent dead tap.
    // (>=1: react-test-renderer matches both the element node and its host.)
    expect(tree.root.findAllByProps({ testID: 'prompt-disconnected-hint' }).length).toBeGreaterThanOrEqual(1);

    // Even a forced press routes nowhere — the store would refuse it anyway, but
    // the disabled control means the handler isn't invoked.
    expect(onSelectOption).not.toHaveBeenCalled();
  });
});
