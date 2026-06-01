/**
 * QuestionPrompt — renders a question with clickable option buttons (#1193).
 *
 * Used for AskUserQuestion prompts from Claude. Shows question text
 * with option buttons; disables and highlights after selection.
 * When no options are provided, shows a free-text input (#1245).
 * The "Other" sentinel option (#3746) swaps the button row for a
 * free-text input so the user can always supply a custom answer.
 *
 * After an answer is recorded (#4312), the option block collapses to a
 * one-line "✓ <chosen>" summary with a chevron to re-expand the full
 * disabled-button list for inspection. Claude's prose preamble is
 * rendered by the parent and remains visible at all times.
 *
 * #4604 Chunk B — multi-question forms: when `questions` is supplied
 * with more than one entry AND `allowMultiQuestion` is true (#4735),
 * the component renders an inline form with one selection control per
 * question (radio for single-select, checkboxes for multiSelect) and a
 * single Submit button at the bottom that fires `onSelect(answersMap)`.
 * The N=1 case falls back to the legacy single-question UI so
 * single-question pins keep passing.
 *
 * #4666 / #4735 — when `allowMultiQuestion` is false (TUI sessions whose
 * permission-hook denies multi-question), the component renders a
 * non-interactive deferred notice instead so the user can't submit
 * answers that misroute through `_pendingUserAnswer`. SDK-mode sessions
 * (#4731 native delivery) pass `allowMultiQuestion={true}` to lift the
 * suppression.
 */
import { useId, useState, useRef, useEffect } from 'react'
import { OTHER_OPTION_VALUE, type ChatMessageQuestion } from '@chroxy/store-core'

/**
 * #4735 — per-question answer payload emitted by the multi-question form.
 * Values are either a string (single-select chosen value, free-form
 * "Other" text) or a string[] (multi-select chosen values). The wire
 * schema (`UserQuestionResponseSchema`) and server consumers
 * (`PermissionManager.respondToQuestion`, `ClaudeTuiSession`) accept
 * both shapes; pre-#4735 builds used to JSON-stringify the array into a
 * single string for back-compat, but the native form is preferred.
 */
export type MultiQuestionAnswersMap = Record<string, string | string[]>

/**
 * #4651 — payload shape emitted when the user picks "Other" on a single-
 * question AskUserQuestion and types freeform text. The store reads this
 * shape to send a two-stage `user_question_response` (server writes the
 * Other digit to claude TUI, waits for the text-input prompt swap, then
 * writes the freeform text + Enter).
 */
export interface OtherFreeformAnswer {
  otherLabel: string
  freeformText: string
}

export interface QuestionPromptProps {
  question: string
  options: { label: string; value: string }[]
  answered?: string
  /**
   * #4604 Chunk B — full per-question payload for multi-question forms.
   * Always populated by store-core handleUserQuestion (questions[0]
   * mirrors the top-level `question` + `options`). When length > 1 the
   * component renders the multi-question form instead of the legacy
   * single-question UI.
   */
  questions?: ChatMessageQuestion[]
  /**
   * #4735 / #4731 — opt-in flag for SDK-mode sessions to render the
   * interactive `MultiQuestionForm` instead of the #4666 deferred notice.
   * TUI / CLI sessions (`provider === 'claude-tui'` / `claude-cli`) leave
   * this false because the permission-hook (#4648) denies multi-question
   * tool_uses there — see `packages/server/hooks/permission-hook.sh`.
   * SDK / BYOK / Codex sessions pass `true` because the in-process
   * `canUseTool` permission flow (`packages/server/src/sdk-session.js:30`)
   * accepts per-question `answers` maps natively (#4731). Defaults to
   * false so existing callers (and tests) keep their #4666 deferred-
   * notice behaviour unless they explicitly opt in.
   */
  allowMultiQuestion?: boolean
  /**
   * Fires with one of three shapes:
   * - `string` — legacy single-question / free-text-only path (back-compat).
   * - `MultiQuestionAnswersMap` (`Record<string, string | string[]>`) —
   *   multi-question form (#4604 Chunk B / #4735), keyed by
   *   `question.question` with multi-select values as native `string[]`
   *   arrays of chosen labels (#4621 / #4735).
   * - `OtherFreeformAnswer` — single-question "Other" with freeform text
   *   (#4651), carrying both the Other option's label (for digit lookup
   *   on the server) and the typed text.
   */
  onSelect: (answer: string | MultiQuestionAnswersMap | OtherFreeformAnswer) => void
}

export function QuestionPrompt({ question, options, answered, questions, allowMultiQuestion, onSelect }: QuestionPromptProps) {
  const isMultiQuestion = Array.isArray(questions) && questions.length > 1

  // #4666 / #4735 / #4731 — TUI / CLI sessions: permission-hook denies any
  // AskUserQuestion with `questions[]` length > 1 because the TUI keystroke
  // driver can't reliably answer combined forms. The dashboard still
  // receives the tool_use event (broadcast is independent of the deny),
  // so we render a non-interactive notice to prevent misrouted answers
  // via `_pendingUserAnswer`. SDK-mode sessions (#4731) flip
  // `allowMultiQuestion` on and render the live `MultiQuestionForm` so
  // per-question answers reach the SDK's canUseTool callback natively
  // (`PermissionManager.respondToQuestion`,
  // `packages/server/src/permission-manager.js`).
  if (isMultiQuestion && answered == null) {
    if (allowMultiQuestion) {
      return <MultiQuestionForm questions={questions} onSelect={onSelect} />
    }
    return <MultiQuestionDeferredNotice count={questions.length} />
  }

  return (
    <SingleQuestionPrompt
      question={question}
      options={options}
      answered={answered}
      onSelect={onSelect}
    />
  )
}

/**
 * #4666 — non-interactive placeholder shown when the TUI emitted a
 * multi-question AskUserQuestion. The permission-hook will deny the
 * combined form and force Claude to re-emit one question at a time;
 * those single-question retries render with the normal interactive UI.
 */
function MultiQuestionDeferredNotice({ count }: { count: number }) {
  return (
    <div
      className="question-prompt question-prompt--deferred"
      data-testid="multi-question-deferred-notice"
      role="status"
    >
      <div className="question-text">
        Claude tried to ask {count} questions at once. Waiting for it to retry one at a time…
      </div>
    </div>
  )
}

/**
 * #4604 Chunk B — N-question form. Each question gets its own selection
 * control (radio for single-select, checkboxes for multiSelect); the
 * single Submit button at the bottom fires `onSelect(answersMap)` with
 * one entry per question. Multi-select values are emitted as native
 * `string[]` (#4621) — the wire schema accepts `string | string[]`
 * directly, so no JSON encoding is required and the server's TUI driver
 * receives the chosen labels without a round-trip through JSON.parse.
 *
 * #4735 — multi-select values are emitted as native `string[]` arrays
 * via the widened wire shape (`Record<string, string | string[]>`).
 * Pre-#4735 builds JSON-stringified the array into a single string for
 * back-compat; the server still accepts both shapes
 * (`ClaudeTuiSession.resolveQuestionDigits` parses JSON or comma-joined
 * strings, `PermissionManager.respondToQuestion` passes the value
 * through unchanged so the SDK receives the array on its canUseTool
 * callback).
 *
 * #4666 / #4735 — gated behind `allowMultiQuestion` in `QuestionPrompt`
 * so TUI sessions fall back to the deferred notice (the TUI keystroke
 * driver can't reliably answer combined multi-question forms). SDK /
 * BYOK / Codex sessions render this form directly because the SDK's
 * canUseTool delivery accepts per-question answers natively (#4731).
 */
export interface MultiQuestionFormProps {
  questions: ChatMessageQuestion[]
  onSelect: (answersMap: MultiQuestionAnswersMap) => void
}

export function MultiQuestionForm({ questions, onSelect }: MultiQuestionFormProps) {
  // State per question: single-select holds the chosen value string,
  // multi-select holds an array of chosen value strings. Indexed by
  // question position so duplicate question texts don't collide.
  const [singleSelectByIdx, setSingleSelectByIdx] = useState<Record<number, string>>({})
  const [multiSelectByIdx, setMultiSelectByIdx] = useState<Record<number, string[]>>({})
  const submittedRef = useRef(false)
  // #4624 — stable id prefix for aria-labelledby. Each question text gets
  // `${labelIdPrefix}-${idx}` so duplicate question texts don't collide
  // and screen readers can announce the group label.
  const labelIdPrefix = useId()

  const handleRadioChange = (idx: number, value: string) => {
    setSingleSelectByIdx((prev) => ({ ...prev, [idx]: value }))
  }

  const handleCheckboxToggle = (idx: number, value: string) => {
    setMultiSelectByIdx((prev) => {
      const curr = prev[idx] || []
      const next = curr.includes(value)
        ? curr.filter((v) => v !== value)
        : [...curr, value]
      return { ...prev, [idx]: next }
    })
  }

  const handleSubmit = () => {
    if (submittedRef.current) return
    submittedRef.current = true
    const answersMap: MultiQuestionAnswersMap = {}
    questions.forEach((q, idx) => {
      if (q.multiSelect) {
        // #4621 / #4735 — emit multi-select as a native `string[]` via
        // the widened wire shape. Pre-#4621 dashboards JSON.stringified
        // the array so the schema (`Record<string,string>`) accepted
        // it; the server side already handled both forms (the TUI
        // driver parses JSON or comma-joined strings; the SDK path
        // passes the value through unchanged). Sending arrays natively
        // gives the SDK canUseTool callback the structured shape it
        // expects without a JSON.parse hop.
        answersMap[q.question] = multiSelectByIdx[idx] || []
      } else {
        const chosen = singleSelectByIdx[idx]
        if (chosen != null) answersMap[q.question] = chosen
      }
    })
    onSelect(answersMap)
  }

  // Submit enabled only when every single-select question has a choice
  // (multi-select is allowed to be empty — claude SDK accepts zero
  // selections for multi-select).
  const canSubmit = questions.every((q, idx) => {
    if (q.multiSelect) return true
    return singleSelectByIdx[idx] != null
  })

  return (
    <div className="question-prompt question-prompt--multi" data-testid="question-prompt-multi">
      {questions.map((q, idx) => {
        const isMultiSelect = q.multiSelect === true
        const labelId = `${labelIdPrefix}-q-${idx}`
        return (
        <div key={`q-${idx}`} className="question-prompt-multi-row" data-testid={`question-multi-row-${idx}`}>
          <div className="question-text" id={labelId}>{q.question}</div>
          <div
            className={`question-options${isMultiSelect ? ' question-options--multi' : ''}`}
            role={isMultiSelect ? 'group' : 'radiogroup'}
            aria-labelledby={labelId}
            {...(isMultiSelect ? {} : { 'aria-required': true })}
          >
            {q.options.map((opt) => {
              const inputId = `q-${idx}-${opt.value}`
              const inputName = `q-${idx}`
              const isMulti = q.multiSelect === true
              const isChecked = isMulti
                ? (multiSelectByIdx[idx] || []).includes(opt.value)
                : singleSelectByIdx[idx] === opt.value
              return (
                <label
                  key={opt.value}
                  htmlFor={inputId}
                  className={`question-option question-option--${isMulti ? 'checkbox' : 'radio'}${isChecked ? ' chosen' : ''}`}
                  data-testid={`question-multi-option-${idx}-${opt.value}`}
                >
                  <input
                    id={inputId}
                    type={isMulti ? 'checkbox' : 'radio'}
                    name={inputName}
                    checked={isChecked}
                    onChange={() => isMulti ? handleCheckboxToggle(idx, opt.value) : handleRadioChange(idx, opt.value)}
                  />
                  <span>{opt.label}</span>
                </label>
              )
            })}
          </div>
        </div>
        )
      })}
      <button
        type="button"
        className="question-multi-submit"
        data-testid="question-multi-submit"
        disabled={!canSubmit}
        aria-disabled={!canSubmit}
        onClick={handleSubmit}
      >
        Submit
      </button>
    </div>
  )
}

interface SingleQuestionPromptProps {
  question: string
  options: { label: string; value: string }[]
  answered?: string
  onSelect: (value: string | OtherFreeformAnswer) => void
}

function SingleQuestionPrompt({ question, options, answered, onSelect }: SingleQuestionPromptProps) {
  const [text, setText] = useState('')
  const [otherActive, setOtherActive] = useState(false)
  // #4651 — when the user clicks the Other option button, stash the option's
  // label so handleSubmit can emit it back to the server. The server uses
  // the label to resolve Other → 1-indexed digit (claude TUI hotkey) and
  // then writes the digit BEFORE the freeform text so the TUI's text-
  // input prompt is open when the text lands. Default 'Other' covers the
  // synthesized-sentinel case (#3746) where options[*].value ===
  // OTHER_OPTION_VALUE but no real option carries that label.
  const [otherLabel, setOtherLabel] = useState<string>('Other')
  // #4312: post-answer the option block collapses to a one-line summary;
  // user can re-expand to inspect the full disabled-button list. Default
  // collapsed once `answered` is set, including the remote-answered case
  // (markPromptAnsweredByRequestId) since render keys off `answered`.
  const [optionsExpanded, setOptionsExpanded] = useState(false)
  const submittedRef = useRef(false)

  // Reset "Other" UI mode when the prompt becomes answered (#3746 review).
  // Without this, otherActive would stay true after an answer arrives from
  // another client, and the component's render flags (`showOptions` vs
  // `showFreeText`) would depend on lingering local UI state instead of
  // server-authoritative `answered`. Belt-and-suspenders alongside the
  // `answered != null` gate in showOptions.
  useEffect(() => {
    if (answered != null && otherActive) {
      setOtherActive(false)
      setText('')
    }
  }, [answered, otherActive])

  const handleSubmit = () => {
    if (submittedRef.current) return
    const trimmed = text.trim()
    if (!trimmed) return
    submittedRef.current = true
    // #4651 — when the user reached this form by clicking the "Other"
    // option (otherActive), emit the structured payload so the server
    // can drive the two-stage TUI write (Other digit → text-input prompt
    // → freeform text + Enter). When otherActive is false the user is
    // in the zero-options free-text-only path (#1245) — keep emitting
    // a plain string so the server's existing free-text handler
    // continues to work unchanged.
    if (otherActive) {
      onSelect({ otherLabel, freeformText: trimmed })
    } else {
      onSelect(trimmed)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleOptionClick = (value: string) => {
    if (value === OTHER_OPTION_VALUE) {
      // #4651 — capture the label of the option the user actually clicked
      // so the freeform payload carries the right label for the server's
      // digit lookup. Synthetic sentinel options use the label 'Other';
      // model-supplied custom labels (rare) preserve their text.
      const clicked = options.find((o) => o.value === value)
      setOtherLabel(clicked?.label || 'Other')
      setOtherActive(true)
      return
    }
    onSelect(value)
  }

  const answeredMatchesOption =
    answered != null && options.some((o) => o.value === answered)
  const isFreeTextAnswered = answered != null && !answeredMatchesOption
  const showFreeText =
    !answered && (options.length === 0 || otherActive)
  // Show option buttons whenever there are options to render — but hide them
  // when the answer is free-text (avoid the mixed disabled-buttons-plus-answer
  // state) and while the user is in "Other" mode without an answer yet. Once
  // an answer arrives, ignore lingering otherActive so the chosen option still
  // renders (e.g. when another client answers while local Other mode is open).
  const showOptions =
    options.length > 0 && !isFreeTextAnswered &&
    (answered != null || !otherActive)

  // #4312: once answered, default to a collapsed one-line summary. The
  // disabled-button list still renders behind a chevron toggle for users
  // who want to re-inspect the original options.
  const isAnsweredWithOption = answered != null && answeredMatchesOption
  const chosenLabel = isAnsweredWithOption
    ? (options.find((o) => o.value === answered)?.label ?? answered)
    : undefined
  const showCollapsedSummary = isAnsweredWithOption && !optionsExpanded
  const showExpandedOptions = showOptions && (answered == null || optionsExpanded)

  return (
    <div className="question-prompt" data-testid="question-prompt">
      <div className="question-text">{question}</div>
      {showCollapsedSummary && (
        <button
          type="button"
          className="question-answered-summary"
          data-testid="question-answered-summary"
          aria-expanded={false}
          onClick={() => setOptionsExpanded(true)}
        >
          <span className="question-answered-marker" aria-hidden="true">✓</span>
          <span className="question-answered-label">{chosenLabel}</span>
          <span className="question-answered-chevron" aria-hidden="true">▸</span>
        </button>
      )}
      {showExpandedOptions && (
        <>
          {isAnsweredWithOption && (
            <button
              type="button"
              className="question-answered-summary question-answered-summary--expanded"
              data-testid="question-answered-summary"
              aria-expanded={true}
              onClick={() => setOptionsExpanded(false)}
            >
              <span className="question-answered-marker" aria-hidden="true">✓</span>
              <span className="question-answered-label">{chosenLabel}</span>
              <span className="question-answered-chevron" aria-hidden="true">▾</span>
            </button>
          )}
          <div className="question-options">
            {options.map((opt) => (
              <button
                key={opt.value}
                className={`question-option${answered === opt.value ? ' chosen' : ''}`}
                disabled={answered != null}
                onClick={() => handleOptionClick(opt.value)}
                type="button"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
      {showFreeText && (
        <div className="question-freetext">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your response…"
            aria-label="Your response"
            className="question-freetext-input"
            autoFocus={otherActive}
          />
          <button type="button" onClick={handleSubmit} disabled={!text.trim()} className="question-freetext-send">
            Send
          </button>
          {otherActive && (
            <button
              type="button"
              onClick={() => {
                setOtherActive(false)
                setText('')
              }}
              className="question-freetext-cancel"
            >
              Cancel
            </button>
          )}
        </div>
      )}
      {isFreeTextAnswered && (
        <div className="question-answered" data-testid="question-answered-summary">
          <span className="question-answered-marker" aria-hidden="true">✓</span>
          <span className="question-answered-label">{answered}</span>
        </div>
      )}
    </div>
  )
}
