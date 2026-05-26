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
 */
import { useState, useRef, useEffect } from 'react'
import { OTHER_OPTION_VALUE } from '@chroxy/store-core'

export interface QuestionPromptProps {
  question: string
  options: { label: string; value: string }[]
  answered?: string
  onSelect: (value: string) => void
}

export function QuestionPrompt({ question, options, answered, onSelect }: QuestionPromptProps) {
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
