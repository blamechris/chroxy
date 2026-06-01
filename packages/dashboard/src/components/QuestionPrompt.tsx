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
 * with more than one entry, the component renders an inline form with
 * one selection control per question (radio for single-select,
 * checkboxes for multiSelect) and a single Submit button at the bottom
 * that fires `onSelect(answersMap)`. The N=1 case falls back to the
 * legacy single-question UI so single-question pins keep passing.
 */
import { useId, useState, useRef, useEffect } from 'react'
import { OTHER_OPTION_VALUE, type ChatMessageQuestion } from '@chroxy/store-core'

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
   * #4731 — opt the active session into the interactive multi-question
   * form. Pre-#4731, the TUI permission-hook (#4648) refuses any
   * multi-question AskUserQuestion so the dashboard suppression at
   * #4666 was always-on. SDK / BYOK sessions never traverse that hook
   * (in-process `canUseTool` short-circuits it — see
   * `packages/server/src/sdk-session.js:30`), so they can safely answer
   * multi-question forms natively. The parent App.tsx looks up the
   * active session's provider and sets `enableMultiQuestion` true for
   * everything except `claude-tui` / `claude-cli`; when omitted or
   * false the legacy deferred-notice render path is kept (back-compat
   * for tests / older callers).
   */
  enableMultiQuestion?: boolean
  /**
   * Fires with either a plain string (single-question / free-text path,
   * back-compat) or a `Record<string,string>` map (multi-question form,
   * keyed by `question.question` with multi-select values
   * JSON-stringified arrays of chosen labels).
   */
  onSelect: (answer: string | Record<string, string>) => void
}

export function QuestionPrompt({ question, options, answered, questions, enableMultiQuestion, onSelect }: QuestionPromptProps) {
  const isMultiQuestion = Array.isArray(questions) && questions.length > 1

  // #4731: SDK-mode sessions get the interactive MultiQuestionForm because
  // their `canUseTool` permission flow accepts a per-question `answers`
  // map natively (`PermissionManager.respondToQuestion`,
  // `packages/server/src/permission-manager.js:336`). The legacy deferred
  // notice (#4666) only applies to TUI / CLI sessions where the
  // permission-hook (`packages/server/hooks/permission-hook.sh`, shipped in
  // #4648 / v0.9.24) unconditionally denies multi-question forms because
  // the PTY keystroke driver can't reliably answer them.
  if (isMultiQuestion && answered == null) {
    if (enableMultiQuestion) {
      return (
        <MultiQuestionForm
          questions={questions}
          onSelect={(answersMap) => onSelect(answersMap)}
        />
      )
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
 * one entry per question (multi-select values are JSON-stringified
 * arrays so the wire shape `Record<string,string>` is preserved — the
 * server's respondToQuestion JSON.parse handles the round trip).
 *
 * #4666 — intentionally retained but not currently rendered by
 * `QuestionPrompt`. The permission-hook denies multi-question
 * AskUserQuestion tool_uses, so showing the interactive form would let
 * the user submit answers that misroute via the single `_pendingUserAnswer`
 * field. Once #4668's `Map<toolUseId, ...>` refactor lands, native
 * multi-question support can be re-enabled by flipping the gate in
 * `QuestionPrompt` back to rendering this component. Exported so that
 * `noUnusedLocals` doesn't strip it while it sits dormant.
 */
export interface MultiQuestionFormProps {
  questions: ChatMessageQuestion[]
  onSelect: (answersMap: Record<string, string>) => void
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
    const answersMap: Record<string, string> = {}
    questions.forEach((q, idx) => {
      if (q.multiSelect) {
        const chosen = multiSelectByIdx[idx] || []
        // JSON-encode multi-select answers so the wire shape
        // (Record<string,string>) is preserved. The server's
        // respondToQuestion JSON.parse splits this back into per-option
        // digits + Tab to commit + advance.
        answersMap[q.question] = JSON.stringify(chosen)
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
  onSelect: (value: string) => void
}

function SingleQuestionPrompt({ question, options, answered, onSelect }: SingleQuestionPromptProps) {
  const [text, setText] = useState('')
  const [otherActive, setOtherActive] = useState(false)
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
    onSelect(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleOptionClick = (value: string) => {
    if (value === OTHER_OPTION_VALUE) {
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
