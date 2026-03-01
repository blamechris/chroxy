/**
 * QuestionPrompt — renders a question with clickable option buttons (#1193).
 *
 * Used for AskUserQuestion prompts from Claude. Shows question text
 * with option buttons; disables and highlights after selection.
 * When no options are provided, shows a free-text input (#1245).
 */
import { useState } from 'react'

export interface QuestionPromptProps {
  question: string
  options: { label: string; value: string }[]
  answered?: string
  onSelect: (value: string) => void
}

export function QuestionPrompt({ question, options, answered, onSelect }: QuestionPromptProps) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = () => {
    if (submitted) return
    const trimmed = text.trim()
    if (!trimmed) return
    setSubmitted(true)
    onSelect(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="question-prompt" data-testid="question-prompt">
      <div className="question-text">{question}</div>
      {options.length > 0 && (
        <div className="question-options">
          {options.map((opt) => (
            <button
              key={opt.value}
              className={`question-option${answered === opt.value ? ' chosen' : ''}`}
              disabled={answered != null}
              onClick={() => onSelect(opt.value)}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
      {options.length === 0 && !answered && (
        <div className="question-freetext">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your response…"
            className="question-freetext-input"
          />
          <button type="button" onClick={handleSubmit} className="question-freetext-send">
            Send
          </button>
        </div>
      )}
      {options.length === 0 && answered && (
        <div className="question-answered">{answered}</div>
      )}
    </div>
  )
}
