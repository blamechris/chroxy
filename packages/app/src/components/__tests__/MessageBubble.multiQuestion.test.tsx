/**
 * MessageBubble multi-question integration — #4973
 *
 * Pins how MessageBubble wires the React Native `MultiQuestionForm`:
 *
 *   1. Renders the interactive form (`question-prompt-multi`) only when
 *      the payload has > 1 question AND the session is SDK-mode
 *      (`allowMultiQuestion`). TUI / CLI sessions fall back to the legacy
 *      single-question Q[0] UI (`approval-button-<value>`).
 *   2. Submitting the form forwards the per-question answers map (keyed by
 *      question text, multi-select as `string[]`) to
 *      `onSubmitMultiQuestion` with the message id + toolUseId.
 *   3. Once answered, the form is replaced by the post-answer summary chip
 *      (`question-multi-summary`) showing the comma-joined option LABELS
 *      per question (mapped back from `answeredAnswers`).
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/connection';

function multiQuestionPrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'mq-1',
    type: 'prompt',
    content: 'Q1 — deploy to production?',
    timestamp: Date.now(),
    toolUseId: 'toolu_multi',
    tool: 'AskUserQuestion',
    options: [
      { label: 'approve', value: 'approve' },
      { label: 'deny', value: 'deny' },
    ],
    questions: [
      {
        question: 'Q1 — deploy to production?',
        options: [
          { label: 'approve', value: 'approve' },
          { label: 'deny', value: 'deny' },
        ],
      },
      {
        question: 'Q2 — which areas to verify?',
        multiSelect: true,
        options: [
          { label: 'app', value: 'app' },
          { label: 'server', value: 'server' },
          { label: 'dashboard', value: 'dashboard' },
        ],
      },
      {
        question: 'Q3 — rollback strategy?',
        options: [
          { label: 'auto-rollback', value: 'auto-rollback' },
          { label: 'manual-rollback', value: 'manual-rollback' },
        ],
      },
    ],
    ...overrides,
  } as ChatMessage;
}

function render(
  message: ChatMessage,
  props: {
    allowMultiQuestion?: boolean;
    allowSingleMultiSelect?: boolean;
    onSubmitMultiQuestion?: jest.Mock;
    onSelectOption?: jest.Mock;
  } = {},
) {
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
        onSelectOption={props.onSelectOption ?? jest.fn()}
        onSubmitMultiQuestion={props.onSubmitMultiQuestion}
        allowMultiQuestion={props.allowMultiQuestion}
        allowSingleMultiSelect={props.allowSingleMultiSelect}
      />,
    );
  });
  return tree;
}

// #5776 — a single-question multiSelect.
function singleMultiSelectPrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'sm-1',
    type: 'prompt',
    content: 'Pick toppings',
    timestamp: Date.now(),
    toolUseId: 'toolu_single_multi',
    tool: 'AskUserQuestion',
    options: [
      { label: 'Cheese', value: 'Cheese' },
      { label: 'Onion', value: 'Onion' },
      { label: 'Pepper', value: 'Pepper' },
    ],
    questions: [
      {
        question: 'Pick toppings',
        multiSelect: true,
        options: [
          { label: 'Cheese', value: 'Cheese' },
          { label: 'Onion', value: 'Onion' },
          { label: 'Pepper', value: 'Pepper' },
        ],
      },
    ],
    ...overrides,
  } as ChatMessage;
}

// react-test-renderer surfaces a testID on both the composite and the
// host node, so a single rendered element matches `findAllByProps` more
// than once. Use presence (>= 1) for "is rendered" assertions and grab
// the first match when reading props.
function present(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAllByProps({ testID }).length > 0;
}

function first(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.findAllByProps({ testID })[0];
}

function tap(tree: renderer.ReactTestRenderer, testID: string) {
  act(() => {
    first(tree, testID).props.onPress();
  });
}

describe('MessageBubble multi-question form (#4973)', () => {
  it('renders the interactive form for SDK-mode multi-question prompts', () => {
    const tree = render(multiQuestionPrompt(), { allowMultiQuestion: true });
    expect(present(tree, 'question-prompt-multi')).toBe(true);
    expect(present(tree, 'question-multi-submit')).toBe(true);
  });

  it('falls back to the legacy single-question Q[0] UI when allowMultiQuestion is false', () => {
    const tree = render(multiQuestionPrompt(), { allowMultiQuestion: false });
    // No multi-question form...
    expect(present(tree, 'question-prompt-multi')).toBe(false);
    // ...but the legacy Q[0] option buttons still render.
    expect(present(tree, 'approval-button-approve')).toBe(true);
    expect(present(tree, 'approval-button-deny')).toBe(true);
  });

  it('forwards the answers map + message id + toolUseId on submit', () => {
    const onSubmitMultiQuestion = jest.fn();
    const tree = render(multiQuestionPrompt(), {
      allowMultiQuestion: true,
      onSubmitMultiQuestion,
    });
    tap(tree, 'question-multi-option-0-approve');
    tap(tree, 'question-multi-option-1-app');
    tap(tree, 'question-multi-option-1-server');
    tap(tree, 'question-multi-option-2-auto-rollback');
    tap(tree, 'question-multi-submit');
    expect(onSubmitMultiQuestion).toHaveBeenCalledTimes(1);
    expect(onSubmitMultiQuestion).toHaveBeenCalledWith(
      {
        'Q1 — deploy to production?': 'approve',
        'Q2 — which areas to verify?': ['app', 'server'],
        'Q3 — rollback strategy?': 'auto-rollback',
      },
      'mq-1',
      'toolu_multi',
    );
  });

  it('renders the post-answer summary chip with comma-joined option labels per question', () => {
    // Simulate the answered state: `answered` holds the comma-joined
    // summary; `answeredAnswers` holds the structured map the chip maps
    // back to option labels.
    const answered = multiQuestionPrompt({
      answered: 'Q1 — deploy to production?: approve | Q2 — which areas to verify?: app, server',
      answeredAnswers: {
        'Q1 — deploy to production?': 'approve',
        'Q2 — which areas to verify?': ['app', 'server'],
        'Q3 — rollback strategy?': 'auto-rollback',
      },
    });
    const tree = render(answered, { allowMultiQuestion: true });
    // Interactive form is gone once answered.
    expect(present(tree, 'question-prompt-multi')).toBe(false);
    // Summary chip present.
    expect(present(tree, 'question-multi-summary')).toBe(true);
    // Q2's multi-select labels are comma-joined per the #4716 / #4735
    // readability AC.
    const q2 = first(tree, 'question-multi-summary-1');
    const text = q2.props.children.join('');
    expect(text).toBe('Q2 — which areas to verify?: app, server');
  });

  it('maps chosen values back to their option labels when value !== label', () => {
    const answered = multiQuestionPrompt({
      questions: [
        {
          question: 'Pick a fruit',
          options: [
            { label: 'Apple', value: 'a' },
            { label: 'Banana', value: 'b' },
          ],
        },
        {
          question: 'Pick toppings',
          multiSelect: true,
          options: [
            { label: 'Cherry', value: 'c' },
            { label: 'Date', value: 'd' },
          ],
        },
      ],
      answered: 'summary',
      answeredAnswers: {
        'Pick a fruit': 'b',
        'Pick toppings': ['c', 'd'],
      },
    });
    const tree = render(answered, { allowMultiQuestion: true });
    const fruit = first(tree, 'question-multi-summary-0');
    expect(fruit.props.children.join('')).toBe('Pick a fruit: Banana');
    const toppings = first(tree, 'question-multi-summary-1');
    expect(toppings.props.children.join('')).toBe('Pick toppings: Cherry, Date');
  });

  it('falls back to the flat answered summary when answeredAnswers is missing (answered elsewhere / rehydrated)', () => {
    // No `answeredAnswers` — e.g. the prompt was answered on another
    // client or rehydrated from history before the structured field
    // existed. The chip must still show the flat `answered` summary
    // rather than blank per-question lines.
    const answered = multiQuestionPrompt({
      answered: 'Q1 — deploy to production?: approve | Q2 — which areas to verify?: app, server',
    });
    const tree = render(answered, { allowMultiQuestion: true });
    expect(present(tree, 'question-multi-summary')).toBe(true);
    // No per-question structured rows (those need answeredAnswers).
    expect(present(tree, 'question-multi-summary-0')).toBe(false);
    // The flat summary line shows the comma-joined answer text.
    const flat = first(tree, 'question-multi-summary-flat');
    expect(flat.props.children).toBe(
      'Q1 — deploy to production?: approve | Q2 — which areas to verify?: app, server',
    );
  });
});

describe('MessageBubble single-question multiSelect (#5776)', () => {
  it('renders the checkbox form when allowSingleMultiSelect is true', () => {
    const tree = render(singleMultiSelectPrompt(), { allowSingleMultiSelect: true });
    expect(present(tree, 'question-prompt-multi')).toBe(true);
    expect(present(tree, 'question-multi-submit')).toBe(true);
  });

  it('forwards a string[] answers map on submit', () => {
    const onSubmitMultiQuestion = jest.fn();
    const tree = render(singleMultiSelectPrompt(), {
      allowSingleMultiSelect: true,
      onSubmitMultiQuestion,
    });
    tap(tree, 'question-multi-option-0-Cheese');
    tap(tree, 'question-multi-option-0-Pepper');
    tap(tree, 'question-multi-submit');
    expect(onSubmitMultiQuestion).toHaveBeenCalledTimes(1);
    expect(onSubmitMultiQuestion).toHaveBeenCalledWith(
      { 'Pick toppings': ['Cheese', 'Pepper'] },
      'sm-1',
      'toolu_single_multi',
    );
  });

  it('falls back to single-select option buttons when allowSingleMultiSelect is false (claude-cli)', () => {
    const tree = render(singleMultiSelectPrompt(), { allowSingleMultiSelect: false });
    expect(present(tree, 'question-prompt-multi')).toBe(false);
    expect(present(tree, 'approval-button-Cheese')).toBe(true);
    expect(present(tree, 'approval-button-Onion')).toBe(true);
  });

  // #5791 review: the React.memo comparator must compare allowSingleMultiSelect,
  // or the bubble keeps stale gating when the prop flips under a LIVE prompt
  // (same message ref) — e.g. claude-tui's multiSelectReinject capability
  // arriving in availableProviders after the prompt mounted. Render with it
  // false, then re-render the SAME message with it true, and assert the form
  // appears (the memo no longer blocks the update).
  it('re-renders the checkbox form when allowSingleMultiSelect flips true under a live prompt (#5791)', () => {
    const message = singleMultiSelectPrompt();
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
          onSelectOption={jest.fn()}
          allowSingleMultiSelect={false}
        />,
      );
    });
    expect(present(tree, 'question-prompt-multi')).toBe(false);
    // Same message ref; only allowSingleMultiSelect changes.
    act(() => {
      tree.update(
        <MessageBubble
          message={message}
          isSelected={false}
          isSelecting={false}
          onLongPress={() => {}}
          onPress={() => {}}
          onOpenDetail={() => {}}
          onSelectOption={jest.fn()}
          allowSingleMultiSelect={true}
        />,
      );
    });
    expect(present(tree, 'question-prompt-multi')).toBe(true);
  });
});
