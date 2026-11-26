import { randomUUID } from 'node:crypto'
import { CODEX_QUESTION_ID_PREFIX, formatCodexQuestionOptionLabel } from '@chroxy/protocol'

// Bounds for native question payloads stored in the session and its history.
const MAX_QUESTIONS = 3
const MAX_OPTIONS = 8
const MAX_ID_LENGTH = 256
const MAX_TEXT_LENGTH = 4_096
const OTHER_OPTION_VALUE = '__chroxy_other__'

function nonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength && value.trim().length > 0
}

// Compare the text a viewer can distinguish after whitespace collapse. The
// original question keys and option labels still go over the wire unchanged.
function displayedTextKey(value) {
  return value.replace(/\s+/g, ' ').trim()
}

export function isCodexRequestId(value) {
  return Number.isSafeInteger(value) || nonEmptyString(value, MAX_ID_LENGTH)
}

export function createCodexQuestionToolUseId() {
  return `${CODEX_QUESTION_ID_PREFIX}${randomUUID()}`
}

// Codex CLI's generated ToolRequestUserInputParams. Keep the native ids and
// controls separately from the question text that Chroxy clients answer by.
export function parseCodexUserQuestion(params) {
  const { threadId, turnId, itemId, questions, isBlocking = true, autoResolutionMs } = params ?? {}
  if (![threadId, turnId, itemId].every(id => nonEmptyString(id, MAX_ID_LENGTH))
      || typeof isBlocking !== 'boolean'
      || (autoResolutionMs != null && (!Number.isSafeInteger(autoResolutionMs) || autoResolutionMs < 0))
      || !Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS) return null

  const ids = new Set()
  const questionKeys = new Set()
  const displayTexts = new Set()
  const fields = []
  const form = []
  const single = questions.length === 1
  for (const row of questions) {
    const { id, header, question, isOther, isSecret, options } = row ?? {}
    if (!nonEmptyString(id, MAX_ID_LENGTH) || ids.has(id)
        || typeof header !== 'string' || header.length > MAX_TEXT_LENGTH
        || !nonEmptyString(question, MAX_TEXT_LENGTH)
        || typeof isOther !== 'boolean' || isSecret !== false
        || (options !== null && (!Array.isArray(options) || options.length > MAX_OPTIONS))) return null

    const displayText = header.trim() ? `${header}\n${question}` : question
    const displayKey = displayedTextKey(displayText)
    if (displayTexts.has(displayKey) || (!single && Object.hasOwn(Object.prototype, displayText))) return null

    const labels = new Set()
    const displayLabels = new Set()
    const choices = []
    for (const option of options ?? []) {
      const { label, description } = option ?? {}
      if (!nonEmptyString(label, MAX_TEXT_LENGTH) || label === OTHER_OPTION_VALUE || labels.has(label)
          || typeof description !== 'string' || description.length > MAX_TEXT_LENGTH) return null
      const displayLabel = displayedTextKey(formatCodexQuestionOptionLabel(label, description))
      if (displayLabels.has(displayLabel)) return null
      labels.add(label)
      displayLabels.add(displayLabel)
      choices.push({ label, description })
    }
    // Existing multi-question forms render choices only. A free-text field in
    // such a form could never be completed. Single-question forms support both.
    if (!single && labels.size === 0) return null
    const allowOther = single && isOther
    // Keep the literal Other label reserved and reject aliases viewers would
    // see as the same as the synthesized custom-answer choice.
    if (allowOther && (labels.has('Other') || displayLabels.has('Other'))) return null

    ids.add(id)
    questionKeys.add(displayText)
    displayTexts.add(displayKey)
    fields.push({ id, question: displayText, labels, allowOther })
    form.push({ question: displayText, options: choices, allowOther })
  }
  // Both clients reserve this exact two-key answer object for a single Other
  // response. A form with those display keys cannot submit two choice answers.
  if (questionKeys.size === 2 && questionKeys.has('otherLabel') && questionKeys.has('freeformText')) return null
  return { threadId, turnId, itemId, isBlocking, fields, questions: form }
}

export function buildCodexUserQuestionResponse(fields, text, answers, freeformText) {
  if (answers !== undefined && (!answers || typeof answers !== 'object' || Array.isArray(answers)
      || Object.keys(answers).length !== fields.length || freeformText !== undefined)) return null
  if (answers === undefined && fields.length !== 1) return null

  const result = []
  for (const { id, question, labels, allowOther } of fields) {
    if (answers !== undefined && !Object.hasOwn(answers, question)) return null
    let value = answers === undefined ? text : answers[question]
    if (freeformText !== undefined) {
      if (value !== 'Other' || !allowOther || labels.size === 0 || !nonEmptyString(freeformText, 100_000)) return null
      value = `user_note: ${freeformText}`
    } else {
      if (!nonEmptyString(value, 100_000)) return null
      if (labels.size === 0) value = `user_note: ${value}`
      else if (!labels.has(value)) return null
    }
    result.push([id, { answers: [value] }])
  }
  return { answers: Object.fromEntries(result) }
}
