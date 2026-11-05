/**
 * "The selected model is not usable" screen for claude-tui (#8934).
 *
 * Pure: text in, a classified result out (the same shape as usage-limit.js).
 *
 * When `claude --model <id>` is given an id it does not know, the TUI still
 * starts. It paints, on the first prompt,
 *
 *   ⏺ There's an issue with the selected model (haiku-5-5). It may not exist or
 *     you may not have access to it. Run /model to pick a different model.
 *
 * and returns to its prompt with no Stop hook, so the turn used to sit until the
 * 90s first-output watchdog said "try sending again" (which never helps).
 *
 * Matching tolerates NO whitespace between words: the PTY tail has had its
 * cursor-move escapes deleted, so a narrow terminal delivers
 * "There'sanissuewiththeselectedmodel(haiku-5-5)" (see usage-limit.js).
 * The model id is captured from the parentheses, restricted to the characters a
 * model id can contain, so a captured value is always printable and short.
 */

/** Error `code` carried on the chat error. */
export const MODEL_UNAVAILABLE_CODE = 'model_unavailable'

const SCREEN_RE = /there[’']?s\s*an\s*issue\s*with\s*the\s*selected\s*model\s*\(\s*([A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99})\s*\)/i

/**
 * @param {string} text ANSI-stripped PTY output (this turn's only)
 * @returns {{ code: string, model: string, message: string }|null}
 */
export function classifyModelError(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const m = SCREEN_RE.exec(text)
  if (!m) return null
  const model = m[1]
  return {
    code: MODEL_UNAVAILABLE_CODE,
    model,
    message: `Claude rejected the model '${model}': it may not exist or this account may not have access to it. Pick a different model and try again.`,
  }
}
