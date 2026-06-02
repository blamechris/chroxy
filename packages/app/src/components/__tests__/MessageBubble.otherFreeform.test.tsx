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

function render(message: ChatMessage, onSelectOption: jest.Mock) {
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

describe('MessageBubble Other / freeform answer (#4755)', () => {
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
    );
  });
});
