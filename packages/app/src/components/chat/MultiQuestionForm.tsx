/**
 * MultiQuestionForm — React Native multi-question AskUserQuestion form
 * (#4973). Mobile sibling of the dashboard's `MultiQuestionForm`
 * (`packages/dashboard/src/components/QuestionPrompt.tsx`).
 *
 * Renders one selection control per question in a multi-question
 * AskUserQuestion payload: a single-select radio row for single-select
 * questions and a checkbox row for multi-select questions (`multiSelect:
 * true`). A single Submit button at the bottom fires
 * `onSubmit(answersMap)` with one entry per question, keyed by question
 * text. Multi-select values are emitted as native `string[]` arrays of
 * chosen option values (#4621 / #4735) — the wire schema
 * (`UserQuestionResponseSchema`) and the store-layer
 * `sendUserQuestionResponse` (widened in #4761 / PR #4859) accept the
 * `Record<string, string | string[]>` shape directly, so no JSON
 * encoding is required.
 *
 * #4735 / #4731 — the parent (`MessageBubble`) only renders this form
 * for SDK-mode sessions (`allowMultiQuestion === true`). TUI / CLI
 * sessions render the legacy single-question Q[0] UI because the
 * permission-hook (#4648) denies combined multi-question tool_uses
 * there; the dashboard mirrors this gate via `allowMultiQuestionForm`.
 *
 * testIDs (parity with the dashboard #4762 acceptance criteria):
 *   - `question-prompt-multi` (container)
 *   - `question-multi-option-<questionIndex>-<optionValue>` (each option)
 *   - `question-multi-submit` (submit button)
 */
import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import {
  // #5800 — the multi-question form state machine now lives in store-core,
  // shared with the dashboard's MultiQuestionForm.
  buildAnswersMap,
  computeCanSubmit,
  setSingleSelect,
  toggleMultiSelect,
  type ChatMessageQuestion,
  type MultiQuestionAnswersMap as SharedMultiQuestionAnswersMap,
} from '@chroxy/store-core';
import { COLORS } from '../../constants/colors';

/**
 * #4735 — per-question answer payload emitted by the multi-question form.
 * Values are either a string (single-select chosen value) or a string[]
 * (multi-select chosen values). Mirrors the dashboard's
 * `MultiQuestionAnswersMap`.
 *
 * #5800 — the canonical declaration now lives in `@chroxy/store-core`;
 * re-exported here under the same name so existing importers are unchanged.
 */
export type MultiQuestionAnswersMap = SharedMultiQuestionAnswersMap;

export interface MultiQuestionFormProps {
  questions: ChatMessageQuestion[];
  onSubmit: (answersMap: MultiQuestionAnswersMap) => void;
  /**
   * #5699 — when true (the caller passes `disabled={!connected}`), the Submit
   * button is disabled: a disconnected answer can't reach the server's
   * already-expired pending request, so the control must not look actionable.
   */
  disabled?: boolean;
}

export function MultiQuestionForm({ questions, onSubmit, disabled = false }: MultiQuestionFormProps) {
  // Local selection state is indexed by question POSITION so that while
  // the form is open, two questions with identical text track their
  // choices independently (single-select holds the chosen value string,
  // multi-select holds an array of chosen value strings). NOTE: the
  // emitted `answersMap` (see `handleSubmit`) is keyed by `q.question`
  // text — this is the wire shape `UserQuestionResponseSchema` /
  // `PermissionManager.respondToQuestion` consume, and it matches the
  // dashboard's `MultiQuestionForm`. If a payload ever carried two
  // questions with the exact same text, the later one would overwrite the
  // earlier in the emitted map; that's an inherent constraint of the
  // question-text-keyed wire contract (shared with the dashboard), not a
  // mobile-only limitation.
  const [singleSelectByIdx, setSingleSelectByIdx] = useState<Record<number, string>>({});
  const [multiSelectByIdx, setMultiSelectByIdx] = useState<Record<number, string[]>>({});
  // #3753 parity — one-shot send guard so a rapid double-tap on Submit
  // (before the store round-trip flips `message.answered`) only fires
  // one `user_question_response`.
  const submittedRef = useRef(false);

  // #5800 — selection state + canSubmit derivation + answersMap-builder now
  // live in `@chroxy/store-core` (shared with the dashboard's
  // MultiQuestionForm). Markup, testIDs, and the emitted answersMap shape are
  // unchanged; only the logic moved.
  const handleRadioSelect = (idx: number, value: string) => {
    setSingleSelectByIdx((prev) => setSingleSelect(prev, idx, value));
  };

  const handleCheckboxToggle = (idx: number, value: string) => {
    setMultiSelectByIdx((prev) => toggleMultiSelect(prev, idx, value));
  };

  const canSubmit = computeCanSubmit(questions, { singleSelectByIdx, multiSelectByIdx });

  const handleSubmit = () => {
    if (submittedRef.current || !canSubmit || disabled) return;
    submittedRef.current = true;
    onSubmit(buildAnswersMap(questions, { singleSelectByIdx, multiSelectByIdx }));
  };

  return (
    <View style={styles.container} testID="question-prompt-multi">
      {questions.map((q, idx) => {
        const isMultiSelect = q.multiSelect === true;
        const selectedSingle = singleSelectByIdx[idx];
        const selectedMulti = multiSelectByIdx[idx] ?? [];
        return (
          <View key={`q-${idx}`} style={styles.questionRow} testID={`question-multi-row-${idx}`}>
            <Text
              style={styles.questionText}
              // #4973 — per-question text anchor for Maestro / unit tests
              // to assert each question rendered. Deliberately NOT
              // `approval-question-<idx>` (that testID is owned by the
              // bubble HEADER label in MessageBubble, and reusing it here
              // would create a duplicate testID for Q[0]).
              testID={`question-multi-text-${idx}`}
            >
              {q.question}
            </Text>
            <View
              style={styles.optionsRow}
              accessibilityRole={isMultiSelect ? 'none' : 'radiogroup'}
            >
              {q.options.map((opt) => {
                const isChosen = isMultiSelect
                  ? selectedMulti.includes(opt.value)
                  : selectedSingle === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    testID={`question-multi-option-${idx}-${opt.value}`}
                    accessibilityRole={isMultiSelect ? 'checkbox' : 'radio'}
                    accessibilityState={{ checked: isChosen, selected: isChosen }}
                    accessibilityLabel={opt.label}
                    style={[styles.optionButton, isChosen && styles.optionButtonChosen]}
                    onPress={() =>
                      isMultiSelect
                        ? handleCheckboxToggle(idx, opt.value)
                        : handleRadioSelect(idx, opt.value)
                    }
                  >
                    <Text style={[styles.optionText, isChosen && styles.optionTextChosen]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        );
      })}
      <TouchableOpacity
        testID="question-multi-submit"
        accessibilityRole="button"
        accessibilityLabel="Submit answers"
        accessibilityState={{ disabled: !canSubmit || disabled }}
        disabled={!canSubmit || disabled}
        style={[styles.submitButton, (!canSubmit || disabled) && styles.submitButtonDisabled]}
        onPress={handleSubmit}
      >
        <Text style={styles.submitButtonText}>Submit</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 10,
    gap: 14,
  },
  questionRow: {
    gap: 8,
  },
  questionText: {
    color: COLORS.textChatMessage,
    fontSize: 15,
    fontWeight: '600',
  },
  optionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionButton: {
    backgroundColor: COLORS.accentOrangeMedium,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentOrangeBorderStrong,
  },
  optionButtonChosen: {
    backgroundColor: COLORS.accentOrange,
    borderColor: COLORS.accentOrange,
  },
  optionText: {
    color: COLORS.accentOrange,
    fontSize: 14,
    fontWeight: '600',
  },
  optionTextChosen: {
    color: '#fff',
  },
  submitButton: {
    alignSelf: 'flex-start',
    backgroundColor: COLORS.accentOrange,
    paddingHorizontal: 20,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
  },
  submitButtonDisabled: {
    opacity: 0.4,
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
