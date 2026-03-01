/**
 * QuestionPrompt — renders a question with clickable option buttons (#1193).
 *
 * Used for AskUserQuestion prompts from Claude. Shows question text
 * with option buttons; disables and highlights after selection.
 */

export interface QuestionPromptProps {
  question: string
  options: { label: string; value: string }[]
  answered?: string
  onSelect: (value: string) => void
}

export function QuestionPrompt({ question, options, answered, onSelect }: QuestionPromptProps) {
  return (
    <div className="question-prompt" data-testid="question-prompt">
      <div className="question-text">{question}</div>
      {options.length > 0 && (
        <div className="question-options">
          {options.map((opt, i) => (
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
    </div>
  )
}
