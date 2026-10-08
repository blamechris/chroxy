/**
 * AskUserQuestionPermissionBody — the readable body of an AskUserQuestion
 * permission card (#8264).
 *
 * In Approve mode the AskUserQuestion tool call still passes through the
 * permission gate (#4685: the model-supplied question must not be shown before
 * the user consents). The generic permission card builds its body from the
 * server-side `description`, which for a tool with no `command` / `file_path` /
 * `pattern` is the tool input as JSON cut at 200 characters — so the consent
 * surface read `AskUserQuestion: {"questions":[{"question":"Which color …` and
 * stopped mid-string. This renders the same information as the question card
 * does: the question text and its options, no JSON, no truncation.
 *
 * The questions are read from the already-broadcast `toolInput` (redacted by
 * the server, capped at 10K chars) and normalized by the SAME function the
 * question card's `user_question` handler uses (`normalizeUserQuestion` in
 * store-core), so the two surfaces cannot disagree about what a question or an
 * option is. When the input is unusable (absent, or replaced by the server's
 * `{ _truncated, summary }` placeholder) only the headline renders — the
 * question itself appears on the real card after Allow, and the JSON never does.
 */
import {
  normalizeUserQuestion,
  OTHER_OPTION_VALUE,
  type ChatMessageQuestion,
} from '@chroxy/store-core'

/** Tool name the card specialises on. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * Parse the questions out of a raw AskUserQuestion tool input. Returns `[]` for
 * anything that is not a usable `{ questions: [...] }`. The synthetic "Other"
 * free-text sentinel the question card appends is dropped: it is a UI affordance
 * the model never wrote, so listing it here would put words in Claude's mouth.
 */
export function readAskUserQuestions(toolInput: Record<string, unknown> | undefined): ChatMessageQuestion[] {
  const raw = toolInput?.questions
  if (!Array.isArray(raw)) return []
  const out: ChatMessageQuestion[] = []
  for (const entry of raw) {
    const q = normalizeUserQuestion(entry)
    if (!q) continue
    out.push({ ...q, options: q.options.filter((o) => o.value !== OTHER_OPTION_VALUE) })
  }
  return out
}

/** One-line statement of what is being asked; also the dropped-record text. */
export function askUserQuestionHeadline(questionCount: number): string {
  return questionCount > 1
    ? `Claude wants to ask you ${questionCount} questions`
    : 'Claude wants to ask you a question'
}

/** What the card says when it is dropped unanswered: the first question, or the headline. */
export function askUserQuestionSummary(toolInput: Record<string, unknown> | undefined): string {
  const questions = readAskUserQuestions(toolInput)
  return questions[0]?.question ?? askUserQuestionHeadline(1)
}

export function AskUserQuestionPermissionBody({ toolInput }: { toolInput?: Record<string, unknown> }) {
  const questions = readAskUserQuestions(toolInput)
  return (
    <>
      <span className="perm-ask-headline" data-testid="perm-ask-headline">
        {askUserQuestionHeadline(questions.length)}
      </span>
      {questions.length > 0 && (
        <ol className="perm-ask-questions" data-testid="perm-ask-questions">
          {questions.map((q, idx) => (
            <li key={`q-${idx}`} className="perm-ask-question" data-testid={`perm-ask-question-${idx}`}>
              <div className="perm-ask-question-text">{q.question}</div>
              {q.options.length > 0 && (
                <ul className="perm-ask-options" aria-label={q.multiSelect ? 'Options (choose any)' : 'Options'}>
                  {q.options.map((o) => (
                    <li key={o.value} className="perm-ask-option">{o.label}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
