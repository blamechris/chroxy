/**
 * MessageBubble Other / freeform answer integration — #4755
 *
 * Mobile parity with the dashboard's #4651 freeform Other support.
 * Asserts that when the user picks the synthesized "Other" option on a
 * single-question AskUserQuestion prompt, MessageBubble:
 *
 *   1. Swaps the option buttons for a freeform `TextInput` + Send button.
 *   2. On Send / Enter, emits `{otherLabel, freeformText}` (not the typed
 *      string) so SessionScreen can forward the structured shape to
 *      `sendUserQuestionResponse` — which serializes the two-stage TUI
 *      wire payload (`answer: <otherLabel>, freeformText: <typed>`).
 *   3. Preserves the legacy string `onSelectOption` payload for regular
 *      option taps (no behaviour change there).
 *
 * Without the freeform shape the typed text would be written directly at
 * claude TUI's digit-select menu, where the first char would jump-nav
 * the menu (#4288 footgun) and wedge or mis-resolve the answer.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { OTHER_OPTION_VALUE } from '@chroxy/store-core';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { useConnectionStore } from '../../store/connection';
import { createEmptySessionState } from '../../store/utils';

// #5699 — the freeform Send + Enter (onSubmitEditing) paths gate on a live
// connection. These tests exercise the connected submit, so set that.
beforeEach(() => {
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
});

function makePromptWithOther(): ChatMessage {
  return {
    id: 'q-1',
    type: 'prompt',
    content: 'Pick one',
    timestamp: Date.now(),
    toolUseId: 'toolu_other_freeform',
    tool: 'AskUserQuestion',
    options: [
      { label: 'Option A', value: 'a' },
      { label: 'Option B', value: 'b' },
      // Synthesized sentinel — #3746 inserts this so users can always
      // type a custom answer alongside the model-supplied options.
      { label: 'Other', value: OTHER_OPTION_VALUE },
    ],
  } as ChatMessage;
}

function render(message: ChatMessage, onSelectOption: jest.Mock, questionGated = false) {
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
        questionGated={questionGated}
      />,
    );
  });
  return tree;
}

describe('MessageBubble Other / freeform answer (#4755)', () => {
  it.each([
    { label: 'a permission card', requestId: 'perm-1', toolUseId: 'ask-codex-test', gated: false },
    { label: 'a question awaiting consent', requestId: undefined, toolUseId: 'ask-codex-test', gated: true },
    { label: 'a question missing its route', requestId: undefined, toolUseId: undefined, gated: false },
  ])('withholds zero-option free text for $label', ({ requestId, toolUseId, gated }) => {
    const onSelectOption = jest.fn();
    const question = 'Name this layout';
    const tree = render({
      id: 'zero-option', type: 'prompt', content: question, timestamp: 1,
      requestId, toolUseId, options: [], questions: [{ question, options: [] }],
    }, onSelectOption, gated);
    try {
      expect(tree.root.findAllByProps({ testID: 'approval-freetext-input' })).toHaveLength(0);
      expect(tree.root.findAllByProps({ testID: 'approval-freetext-send' })).toHaveLength(0);
      expect(onSelectOption).not.toHaveBeenCalled();
    } finally {
      act(() => tree.unmount());
    }
  });

  it('submits a native zero-option answer as a question response with its exact id and displays the recorded text', () => {
    const toolUseId = 'ask-codex-free-text';
    const question = 'Name this layout';
    const message: ChatMessage = {
      id: 'native-free-text', type: 'prompt', content: question, timestamp: 1,
      toolUseId, options: [], questions: [{ question, options: [] }],
    };
    const prior = useConnectionStore.getState();
    const sent: unknown[] = [];
    useConnectionStore.setState({
      socket: { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) } as unknown as WebSocket,
      activeSessionId: 'native-session',
      sessionStates: { 'native-session': { ...createEmptySessionState(), messages: [message] } },
    });
    const answer = 'Compact list';
    const onSelectOption = jest.fn((value: string, messageId: string, requestId: undefined, id: string) => {
      expect(requestId).toBeUndefined();
      const state = useConnectionStore.getState();
      expect(state.sendUserQuestionResponse(value, id)).toBe('sent');
      state.markPromptAnswered(messageId, value);
    });
    let tree: renderer.ReactTestRenderer | undefined;
    let answeredTree: renderer.ReactTestRenderer | undefined;
    try {
      tree = render(message, onSelectOption);
      const input = tree.root.findAllByProps({ testID: 'approval-freetext-input' })[0];
      expect(input).toBeDefined();
      expect(tree.root.findAllByProps({ testID: 'approval-freetext-cancel' })).toHaveLength(0);
      act(() => input.props.onChangeText(`  ${answer}  `));
      const send = tree.root.findByProps({ testID: 'approval-freetext-send' });
      expect(send.props.disabled).toBe(false);
      act(() => send.props.onPress());
      expect(onSelectOption).toHaveBeenCalledTimes(1);
      expect(onSelectOption).toHaveBeenCalledWith(answer, message.id, undefined, toolUseId);
      expect(sent).toEqual([{ type: 'user_question_response', answer, toolUseId }]);
      const answered = useConnectionStore.getState().sessionStates['native-session'].messages[0];
      expect(answered.answered).toBe(answer);
      answeredTree = render(answered, onSelectOption);
      expect(JSON.stringify(answeredTree.toJSON())).toContain(answer);
      expect(answeredTree.root.findAllByProps({ testID: 'approval-freetext-input' })).toHaveLength(0);
    } finally {
      act(() => { tree?.unmount(); answeredTree?.unmount(); });
      useConnectionStore.setState(prior);
    }
  });

  it.each(['closed', 'throwing'] as const)(
    'retries a definite %s socket failure on the same mounted free-text question and sends once',
    (failure) => {
      const prior = useConnectionStore.getState();
      const priorLifecycle = useConnectionLifecycleStore.getState();
      const toolUseId = 'ask-codex-retry';
      const question = 'Name this layout';
      const message: ChatMessage = {
        id: 'native-retry', type: 'prompt', content: question, timestamp: 1,
        toolUseId, options: [], questions: [{ question, options: [] }],
      };
      const failedSend = jest.fn(() => { throw new Error('socket closing'); });
      const disconnected = { readyState: failure === 'closed' ? WebSocket.CLOSED : WebSocket.OPEN, send: failedSend };
      const sent: unknown[] = [];
      const live = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(JSON.parse(data)) };
      useConnectionStore.setState({
        socket: disconnected as unknown as WebSocket,
        activeSessionId: 'native-session',
        sessionStates: { 'native-session': { ...createEmptySessionState(), messages: [message] } },
      });
      const onSelectOption = jest.fn((answer: string, messageId: string, requestId: undefined, id: string) => {
        expect(requestId).toBeUndefined();
        const state = useConnectionStore.getState();
        const result = state.sendUserQuestionResponse(answer, id);
        if (result === 'sent') state.markPromptAnswered(messageId, answer);
        return result !== false;
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const tree = render(message, onSelectOption);
      const input = () => tree.root.findAllByProps({ testID: 'approval-freetext-input' })[0];
      const send = () => tree.root.findByProps({ testID: 'approval-freetext-send' });
      const answer = 'Compact list';
      try {
        act(() => input().props.onChangeText(answer));
        act(() => failure === 'closed' ? send().props.onPress() : input().props.onSubmitEditing());
        expect(onSelectOption).toHaveReturnedWith(false);
        expect(failedSend).toHaveBeenCalledTimes(failure === 'closed' ? 0 : 1);
        expect(useConnectionStore.getState().sessionStates['native-session'].messages[0].answered).toBeUndefined();

        act(() => useConnectionLifecycleStore.setState({ connectionPhase: 'reconnecting' }));
        expect(send().props.disabled).toBe(true);
        act(() => {
          useConnectionStore.setState({ socket: live as unknown as WebSocket });
          useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
        });
        expect(input().props.value).toBe(answer);
        act(() => send().props.onPress());
        expect(sent).toEqual([{ type: 'user_question_response', answer, toolUseId }]);
        expect(useConnectionStore.getState().sessionStates['native-session'].messages[0].answered).toBe(answer);

        // The mounted bubble has not received the new answered prop yet.
        act(() => {
          send().props.onPress();
          input().props.onSubmitEditing();
        });
        expect(onSelectOption).toHaveBeenCalledTimes(2);
        expect(sent).toHaveLength(1);
      } finally {
        act(() => tree.unmount());
        useConnectionStore.setState(prior);
        useConnectionLifecycleStore.setState(priorLifecycle);
        warn.mockRestore();
      }
    },
  );

  it('keeps the one-shot latch for a legacy void callback', () => {
    const message = { ...makePromptWithOther(), options: [] };
    const onSelectOption = jest.fn();
    const tree = render(message, onSelectOption);
    try {
      const input = tree.root.findAllByProps({ testID: 'approval-freetext-input' })[0];
      act(() => input.props.onChangeText('Compact list'));
      const send = tree.root.findByProps({ testID: 'approval-freetext-send' });
      act(() => {
        send.props.onPress();
        send.props.onPress();
      });
      expect(onSelectOption).toHaveBeenCalledTimes(1);
    } finally {
      act(() => tree.unmount());
    }
  });

  it('shows the freeform input when the user picks the Other option', () => {
    // Step 1 of the freeform flow: tapping Other must hide the option
    // buttons and surface the text input keyed by `approval-freetext-input`.
    const onSelectOption = jest.fn();
    const tree = render(makePromptWithOther(), onSelectOption);
    // Before tapping Other, no freeform input exists.
    expect(tree.root.findAllByProps({ testID: 'approval-freetext-input' })).toHaveLength(0);
    const otherBtn = tree.root.findByProps({ testID: `approval-button-${OTHER_OPTION_VALUE}` });
    act(() => {
      otherBtn.props.onPress?.();
    });
    // After tapping Other, the freeform input renders (RN's TextInput
    // forwards `testID` onto both the composite + the underlying host
    // node, so `findAllByProps` returns 2 entries — assert presence with
    // `>= 1`). onSelectOption has NOT been called yet (we're waiting for
    // the user to type + send).
    expect(
      tree.root.findAllByProps({ testID: 'approval-freetext-input' }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it('emits {otherLabel, freeformText} when Send is tapped from Other mode', () => {
    // The wire-payload shape change is the whole point of #4755 — assert
    // the object payload so SessionScreen / connection.ts wire layer
    // can serialize `{answer: <otherLabel>, freeformText}` on the wire.
    const onSelectOption = jest.fn();
    const tree = render(makePromptWithOther(), onSelectOption);
    const otherBtn = tree.root.findByProps({ testID: `approval-button-${OTHER_OPTION_VALUE}` });
    act(() => {
      otherBtn.props.onPress?.();
    });
    // findAllByProps + first entry: see Enter-key test for why.
    const inputs = tree.root.findAllByProps({ testID: 'approval-freetext-input' });
    act(() => {
      inputs[0].props.onChangeText?.('my custom answer');
    });
    const sendBtn = tree.root.findByProps({ testID: 'approval-freetext-send' });
    act(() => {
      sendBtn.props.onPress?.();
    });
    expect(onSelectOption).toHaveBeenCalledTimes(1);
    expect(onSelectOption).toHaveBeenCalledWith(
      { otherLabel: 'Other', freeformText: 'my custom answer' },
      'q-1',
      undefined,
      'toolu_other_freeform',
    );
  });

  it('emits {otherLabel, freeformText} when Enter (onSubmitEditing) is fired from Other mode', () => {
    // The onSubmitEditing path (return key on the keyboard) must emit
    // the same shape as the Send button — otherwise Enter on iOS / hardware
    // keyboards would silently regress to the legacy string write path.
    const onSelectOption = jest.fn();
    const tree = render(makePromptWithOther(), onSelectOption);
    const otherBtn = tree.root.findByProps({ testID: `approval-button-${OTHER_OPTION_VALUE}` });
    act(() => {
      otherBtn.props.onPress?.();
    });
    // findAllByProps + first match: the underlying TextInput host node
    // mirrors the composite's testID, so both findByProps would throw
    // ambiguously — use the composite (first entry) which carries the
    // freshly-rendered onChangeText / onSubmitEditing handlers.
    const inputs = tree.root.findAllByProps({ testID: 'approval-freetext-input' });
    act(() => {
      inputs[0].props.onChangeText?.('enter-sent answer');
    });
    // State update must commit before onSubmitEditing fires, otherwise
    // the closure reads stale `otherText` (=== '') and the submit
    // bails on the empty-string guard. Mirrors the Send-button test
    // pattern — both invocations live in their own act() block.
    const inputsAfter = tree.root.findAllByProps({ testID: 'approval-freetext-input' });
    act(() => {
      inputsAfter[0].props.onSubmitEditing?.();
    });
    expect(onSelectOption).toHaveBeenCalledWith(
      { otherLabel: 'Other', freeformText: 'enter-sent answer' },
      'q-1',
      undefined,
      'toolu_other_freeform',
    );
  });

  it('preserves a custom Other-option label in the emitted payload', () => {
    // If the model supplies a custom label for the OTHER_OPTION_VALUE
    // sentinel (rare — mostly the synthesized `'Other'` case) the
    // payload must echo that label so the server's digit-lookup resolves
    // to the right TUI hotkey.
    const onSelectOption = jest.fn();
    const customMsg = {
      ...makePromptWithOther(),
      options: [
        { label: 'Option A', value: 'a' },
        { label: 'Something else', value: OTHER_OPTION_VALUE },
      ],
    } as ChatMessage;
    const tree = render(customMsg, onSelectOption);
    const otherBtn = tree.root.findByProps({ testID: `approval-button-${OTHER_OPTION_VALUE}` });
    act(() => {
      otherBtn.props.onPress?.();
    });
    const inputs = tree.root.findAllByProps({ testID: 'approval-freetext-input' });
    act(() => {
      inputs[0].props.onChangeText?.('typed');
    });
    const sendBtn = tree.root.findByProps({ testID: 'approval-freetext-send' });
    act(() => {
      sendBtn.props.onPress?.();
    });
    expect(onSelectOption).toHaveBeenCalledWith(
      { otherLabel: 'Something else', freeformText: 'typed' },
      'q-1',
      undefined,
      'toolu_other_freeform',
    );
  });

  it('still emits a plain string when a regular option is tapped (no behaviour change)', () => {
    // Belt-and-braces back-compat assertion. The freeform shape is
    // reserved for the Other path; regular option taps must keep the
    // legacy string payload so SessionScreen / connection.ts continue
    // through their existing string-only code paths.
    const onSelectOption = jest.fn();
    const tree = render(makePromptWithOther(), onSelectOption);
    const optionABtn = tree.root.findByProps({ testID: 'approval-button-a' });
    act(() => {
      optionABtn.props.onPress?.();
    });
    expect(onSelectOption).toHaveBeenCalledTimes(1);
    expect(onSelectOption).toHaveBeenCalledWith(
      'a',
      'q-1',
      undefined,
      'toolu_other_freeform',
      // #6543 (feature B): the option-button path now forwards `editedInput` —
      // `null` here (this prompt isn't a Write/Edit pre-write-diff review).
      null,
    );
  });
});
