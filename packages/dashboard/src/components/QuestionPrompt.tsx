/**
 * QuestionPrompt — renders a question with clickable option buttons (#1193).
 *
 * Used for AskUserQuestion prompts from Claude. Shows question text
 * with option buttons; disables and highlights after selection.
 * When no options are provided, shows a free-text input (#1245).
 * The "Other" sentinel option (#3746) swaps the button row for a
 * free-text input so the user can always supply a custom answer.
 */
import { useState, useRef } from 'react'
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
  const submittedRef = useRef(false)

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

  return (
    <div className="question-prompt" data-testid="question-prompt">
      <div className="question-text">{question}</div>
      {showOptions && (
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
        <div className="question-answered">{answered}</div>
      )}
    </div>
  )
}
