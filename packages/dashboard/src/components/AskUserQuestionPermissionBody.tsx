/**
 * AskUserQuestionPermissionBody — the readable body of an AskUserQuestion
 * permission card (#8264).
 *
 * In Approve mode the AskUserQuestion tool call still passes through the
 * permission gate, and the user's consent is to running that tool. This card
 * shows the question text and options so the user knows what they are
 * consenting to; the interactive question card stays withheld until Allow
 * (#4685). The generic permission card builds its body from the
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
  ASK_USER_QUESTION_TOOL,
  readAskUserQuestions,
  askUserQuestionHeadline,
  askUserQuestionSummary,
} from '@chroxy/store-core'

// The parsing and wording live in store-core (#8357) so the mobile app's card
// reads the same; re-exported here so existing dashboard imports are unchanged.
export { ASK_USER_QUESTION_TOOL, readAskUserQuestions, askUserQuestionHeadline, askUserQuestionSummary }

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
                  {q.options.map((o, oi) => (
                    <li key={`${oi}-${o.value}`} className="perm-ask-option">{o.label}</li>
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
