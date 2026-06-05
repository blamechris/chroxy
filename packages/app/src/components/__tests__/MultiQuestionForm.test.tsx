/**
 * MultiQuestionForm — #4973
 *
 * React Native multi-question AskUserQuestion form. Mobile sibling of the
 * dashboard's `MultiQuestionForm` (`packages/dashboard/src/components/
 * QuestionPrompt.tsx`). These tests pin the component's core behaviour:
 *
 *   1. Renders all N questions with the dashboard-parity testIDs
 *      (`question-prompt-multi`, `question-multi-option-<idx>-<value>`,
 *      `question-multi-submit`).
 *   2. Single-select is a radio (latest choice replaces the previous).
 *   3. Multi-select is a checkbox (taps toggle into / out of an array).
 *   4. Submit is gated until every single-select question has a choice;
 *      multi-select may be left empty.
 *   5. The submit payload is the per-question answers map keyed by
 *      question text, with single-select values as strings and
 *      multi-select values as native `string[]` (the widened wire shape
 *      #4761 / #4735 — no JSON encoding).
 *   6. Submit fires at most once (one-shot guard, #3753 parity).
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import type { ChatMessageQuestion } from '@chroxy/store-core';
import { MultiQuestionForm } from '../chat/MultiQuestionForm';
import type { MultiQuestionAnswersMap } from '../chat/MultiQuestionForm';

function mixedQuestions(): ChatMessageQuestion[] {
  return [
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
  ];
}

function render(questions: ChatMessageQuestion[], onSubmit: jest.Mock) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<MultiQuestionForm questions={questions} onSubmit={onSubmit} />);
  });
  return tree;
}

function tap(tree: renderer.ReactTestRenderer, testID: string) {
  act(() => {
    tree.root.findByProps({ testID }).props.onPress();
  });
}

describe('MultiQuestionForm (#4973)', () => {
  it('renders the container, every option, and the submit button with parity testIDs', () => {
    const tree = render(mixedQuestions(), jest.fn());
    // react-test-renderer surfaces a testID on both the composite and the
    // host node, so assert presence (>= 1) rather than an exact count.
    const has = (testID: string) =>
      expect(tree.root.findAllByProps({ testID }).length).toBeGreaterThanOrEqual(1);
    has('question-prompt-multi');
    has('question-multi-submit');
    // Per-question option testIDs: `question-multi-option-<idx>-<value>`.
    has('question-multi-option-0-approve');
    has('question-multi-option-1-app');
    has('question-multi-option-1-server');
    has('question-multi-option-2-auto-rollback');
    // Each question's text renders.
    has('question-multi-text-0');
    has('question-multi-text-2');
  });

  it('disables submit until every single-select question is answered (multi-select may be empty)', () => {
    const onSubmit = jest.fn();
    const tree = render(mixedQuestions(), onSubmit);
    const submit = () => tree.root.findByProps({ testID: 'question-multi-submit' });
    // Initially disabled — Q1 and Q3 (single-select) have no choice.
    expect(submit().props.accessibilityState.disabled).toBe(true);
    tap(tree, 'question-multi-option-0-approve');
    expect(submit().props.accessibilityState.disabled).toBe(true); // Q3 still unanswered
    tap(tree, 'question-multi-option-2-auto-rollback');
    // Both single-selects answered; Q2 multi-select left empty is fine.
    expect(submit().props.accessibilityState.disabled).toBe(false);
  });

  it('single-select is a radio — the latest tap replaces the previous choice', () => {
    const onSubmit = jest.fn();
    const tree = render(mixedQuestions(), onSubmit);
    tap(tree, 'question-multi-option-0-approve');
    tap(tree, 'question-multi-option-0-deny'); // replaces 'approve'
    tap(tree, 'question-multi-option-2-auto-rollback');
    tap(tree, 'question-multi-submit');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const map: MultiQuestionAnswersMap = onSubmit.mock.calls[0][0];
    expect(map['Q1 — deploy to production?']).toBe('deny');
  });

  it('multi-select toggles values into a native string[] (second tap removes)', () => {
    const onSubmit = jest.fn();
    const tree = render(mixedQuestions(), onSubmit);
    tap(tree, 'question-multi-option-0-approve');
    tap(tree, 'question-multi-option-2-auto-rollback');
    // Q2 multi-select: add app + server + dashboard, then remove dashboard.
    tap(tree, 'question-multi-option-1-app');
    tap(tree, 'question-multi-option-1-server');
    tap(tree, 'question-multi-option-1-dashboard');
    tap(tree, 'question-multi-option-1-dashboard'); // toggle off
    tap(tree, 'question-multi-submit');
    const map: MultiQuestionAnswersMap = onSubmit.mock.calls[0][0];
    const verify = map['Q2 — which areas to verify?'];
    expect(Array.isArray(verify)).toBe(true);
    expect(verify).toEqual(['app', 'server']);
  });

  it('emits the full answers map keyed by question text on submit', () => {
    const onSubmit = jest.fn();
    const tree = render(mixedQuestions(), onSubmit);
    tap(tree, 'question-multi-option-0-approve');
    tap(tree, 'question-multi-option-1-app');
    tap(tree, 'question-multi-option-1-server');
    tap(tree, 'question-multi-option-2-manual-rollback');
    tap(tree, 'question-multi-submit');
    expect(onSubmit).toHaveBeenCalledWith({
      'Q1 — deploy to production?': 'approve',
      'Q2 — which areas to verify?': ['app', 'server'],
      'Q3 — rollback strategy?': 'manual-rollback',
    });
  });

  it('an unanswered multi-select question emits an empty array', () => {
    const onSubmit = jest.fn();
    const tree = render(mixedQuestions(), onSubmit);
    tap(tree, 'question-multi-option-0-approve');
    tap(tree, 'question-multi-option-2-auto-rollback');
    tap(tree, 'question-multi-submit');
    const map: MultiQuestionAnswersMap = onSubmit.mock.calls[0][0];
    expect(map['Q2 — which areas to verify?']).toEqual([]);
  });

  it('does not submit while a single-select question is unanswered', () => {
    const onSubmit = jest.fn();
    const tree = render(mixedQuestions(), onSubmit);
    tap(tree, 'question-multi-option-0-approve'); // Q3 still unanswered
    tap(tree, 'question-multi-submit');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('fires onSubmit at most once even on a rapid double-tap (#3753 one-shot guard)', () => {
    const onSubmit = jest.fn();
    const tree = render(mixedQuestions(), onSubmit);
    tap(tree, 'question-multi-option-0-approve');
    tap(tree, 'question-multi-option-2-auto-rollback');
    tap(tree, 'question-multi-submit');
    tap(tree, 'question-multi-submit');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
