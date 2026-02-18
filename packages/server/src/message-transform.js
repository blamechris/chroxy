/**
 * Message transform pipeline for pre-processing user prompts.
 *
 * Transforms are pure synchronous functions: (message, context) => message.
 * The pipeline is opt-in — if no transforms are configured, messages pass
 * through unchanged (zero behavior change for existing users).
 */

/**
 * Built-in transforms registry.
 * Each transform takes (message, context) and returns the transformed message.
 * Context: { cwd, model, isVoiceInput, sessionName, platform, gitBranch }
 */
const BUILT_IN_TRANSFORMS = {
  /**
   * Prepend a brief context annotation so Claude knows the environment.
   * Uses a system-note style prefix that Claude treats as ambient context.
   */
  contextAnnotation: (message, ctx) => {
    // Skip annotation for very short messages (plan approvals, yes/no, etc.)
    if (message.length < 10) return message
    const parts = []
    if (ctx.cwd) parts.push(`cwd: ${ctx.cwd}`)
    if (ctx.model) parts.push(`model: ${ctx.model}`)
    if (ctx.gitBranch) parts.push(`branch: ${ctx.gitBranch}`)
    if (ctx.platform) parts.push(`platform: ${ctx.platform}`)
    if (parts.length === 0) return message
    return `[${parts.join(', ')}]\n\n${message}`
  },

  /**
   * Clean up common voice-to-text artifacts: filler words, missing
   * punctuation, and normalization for cleaner prompts.
   */
  voiceCleanup: (message, ctx) => {
    if (!ctx.isVoiceInput) return message
    let cleaned = message
    // Remove common filler words at start of message
    cleaned = cleaned.replace(/^(um|uh|like|so|okay|well|basically),?\s*/i, '')
    // Remove mid-sentence fillers (comma-delimited or standalone)
    // Careful: "like" and "so" have legitimate uses, only strip after comma
    cleaned = cleaned.replace(/,\s*(um|uh),?\s*/gi, ', ')
    cleaned = cleaned.replace(/\s+(um|uh)\s+/gi, ' ')
    // Clean up double spaces from removals
    cleaned = cleaned.replace(/  +/g, ' ').trim()
    // Remove trailing comma left by filler removal (e.g. "fix the bug, um" → "fix the bug")
    cleaned = cleaned.replace(/,\s*$/, '')
    // Ensure sentence ends with punctuation
    if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
      cleaned += '.'
    }
    return cleaned
  },
}

export class MessageTransformPipeline {
  /**
   * @param {string[]} transformNames - Ordered list of transform names to apply
   */
  constructor(transformNames = []) {
    this._transforms = []
    for (const name of transformNames) {
      const fn = BUILT_IN_TRANSFORMS[name]
      if (fn) {
        this._transforms.push({ name, fn })
      } else {
        console.warn(`[message-transform] Unknown transform: "${name}", skipping`)
      }
    }
    if (this._transforms.length > 0) {
      console.log(`[message-transform] Pipeline: ${this._transforms.map(t => t.name).join(' → ')}`)
    }
  }

  /**
   * Apply all configured transforms to a message.
   * @param {string} message - The user's raw prompt
   * @param {object} context - Transform context
   * @returns {string} Transformed message
   */
  apply(message, context = {}) {
    if (this._transforms.length === 0) return message
    let result = message
    for (const { fn } of this._transforms) {
      result = fn(result, context)
    }
    return result
  }

  /** @returns {boolean} True if pipeline has any transforms configured */
  get hasTransforms() {
    return this._transforms.length > 0
  }
}

/** Exported for testing */
export const transforms = BUILT_IN_TRANSFORMS
