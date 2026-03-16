import { EventEmitter } from 'events'

// Tools that acceptEdits mode auto-approves
const ACCEPT_EDITS_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'])

// Tools eligible for session-scoped auto-allow rules
export const ELIGIBLE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'])

// Tools that can never be auto-allowed by rules (too dangerous to whitelist)
export const NEVER_AUTO_ALLOW = new Set(['Bash', 'Task', 'WebFetch', 'WebSearch'])

// Default permission timeout (5 minutes)
const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Manages in-process permission requests for SDK-style sessions.
 *
 * Handles the lifecycle of permission prompts:
 *   - Creating permission requests with unique IDs
 *   - Emitting permission_request events for the UI
 *   - Resolving/denying requests via respondToPermission()
 *   - Auto-denying on timeout or abort signal
 *   - Tracking last permission data for reconnect re-send
 *   - AskUserQuestion routing and handling
 *
 * Events emitted:
 *   permission_request  { requestId, tool, description, input, remainingMs, createdAt }
 *   user_question       { toolUseId, questions }
 */
export class PermissionManager extends EventEmitter {
  constructor({ timeoutMs, log } = {}) {
    super()
    this._timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS
    this._log = log || console

    this._pendingPermissions = new Map() // requestId -> { resolve, input }
    this._permissionTimers = new Map()   // requestId -> timer
    this._permissionCounter = 0
    this._lastPermissionData = new Map() // requestId -> emitted permission_request payload

    // Session-scoped permission rules
    this._sessionRules = [] // [{ tool, decision }]

    // AskUserQuestion handling
    this._pendingUserAnswer = null // { resolve, input } when waiting for user answer
    this._questionTimer = null
    this._waitingForAnswer = false
  }

  /**
   * Set session-scoped permission rules.
   * Each rule must have a `tool` in ELIGIBLE_TOOLS and a `decision` of 'allow' or 'deny'.
   * Rules for NEVER_AUTO_ALLOW tools are rejected with an error.
   *
   * @param {Array<{tool: string, decision: string}>} rules
   * @throws {Error} if any rule is invalid
   */
  setRules(rules) {
    if (!Array.isArray(rules)) {
      throw new Error('rules must be an array')
    }
    for (const rule of rules) {
      if (!rule || typeof rule.tool !== 'string') {
        throw new Error('each rule must have a tool string')
      }
      if (rule.decision !== 'allow' && rule.decision !== 'deny') {
        throw new Error(`rule decision must be 'allow' or 'deny', got '${rule.decision}'`)
      }
      if (NEVER_AUTO_ALLOW.has(rule.tool)) {
        throw new Error(`${rule.tool} is in NEVER_AUTO_ALLOW and cannot be auto-allowed`)
      }
      if (!ELIGIBLE_TOOLS.has(rule.tool)) {
        throw new Error(`${rule.tool} is not in ELIGIBLE_TOOLS`)
      }
    }
    this._sessionRules = rules.slice()
  }

  /**
   * Return a copy of the current session rules.
   *
   * @returns {Array<{tool: string, decision: string}>}
   */
  getRules() {
    return this._sessionRules.slice()
  }

  /**
   * Clear all session-scoped permission rules.
   */
  clearRules() {
    this._sessionRules = []
  }

  /**
   * Check whether a toolName matches a session rule.
   *
   * @param {string} toolName
   * @returns {'allow'|'deny'|null} null if no rule matches
   */
  _matchesRule(toolName) {
    for (const rule of this._sessionRules) {
      if (rule.tool === toolName) {
        return rule.decision
      }
    }
    return null
  }

  /**
   * Handle a permission check from the SDK canUseTool callback.
   *
   * For AskUserQuestion: emits user_question and waits for respondToQuestion().
   * For session rules: auto-resolves without prompting.
   * For acceptEdits mode: auto-approves file operation tools.
   * For all other tools: emits permission_request and waits for respondToPermission().
   *
   * @param {string} toolName - The tool requesting permission
   * @param {Object} input - The tool input
   * @param {AbortSignal|null} signal - Abort signal for cancellation
   * @param {string} permissionMode - Current permission mode
   * @returns {Promise<{behavior: string, updatedInput?: Object, message?: string}>}
   */
  handlePermission(toolName, input, signal, permissionMode) {
    if (toolName === 'AskUserQuestion') {
      return this._handleAskUserQuestion(input, signal)
    }

    // Session rules: check before acceptEdits and the prompt path
    const ruleDecision = this._matchesRule(toolName)
    if (ruleDecision !== null) {
      this._logInfo(`Permission rule matched for ${toolName}: ${ruleDecision}`)
      if (ruleDecision === 'allow') {
        return Promise.resolve({ behavior: 'allow', updatedInput: input || {} })
      }
      return Promise.resolve({ behavior: 'deny', message: 'Denied by session rule' })
    }

    // acceptEdits: auto-approve file operations, prompt for everything else
    if (permissionMode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input || {} })
    }

    return new Promise((resolve) => {
      const requestId = `perm-${++this._permissionCounter}-${Date.now()}`
      this._pendingPermissions.set(requestId, { resolve, input: input || {} })

      const toolInput = input || {}
      const description = toolInput.description
        || toolInput.command
        || toolInput.file_path
        || toolInput.pattern
        || toolInput.query
        || (Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput).slice(0, 200) : toolName)

      this._logInfo(`Permission request ${requestId}: ${toolName}`)

      const permPayload = {
        requestId,
        tool: toolName,
        description,
        input: toolInput,
        remainingMs: this._timeoutMs,
        createdAt: Date.now(),
      }
      this._lastPermissionData.set(requestId, permPayload)
      this.emit('permission_request', permPayload)

      // Auto-deny on abort signal (user interrupted)
      if (signal) {
        signal.addEventListener('abort', () => {
          if (this._pendingPermissions.has(requestId)) {
            this._pendingPermissions.delete(requestId)
            this._lastPermissionData.delete(requestId)
            this._clearPermissionTimer(requestId)
            resolve({ behavior: 'deny', message: 'Request cancelled' })
          }
        }, { once: true })
      }

      // Auto-deny after timeout if no response
      const timer = setTimeout(() => {
        this._permissionTimers.delete(requestId)
        if (this._pendingPermissions.has(requestId)) {
          this._logInfo(`Permission ${requestId} timed out, auto-denying`)
          this._pendingPermissions.delete(requestId)
          this._lastPermissionData.delete(requestId)
          resolve({ behavior: 'deny', message: 'Permission timed out' })
        }
      }, this._timeoutMs)
      this._permissionTimers.set(requestId, timer)
    })
  }

  /**
   * Handle AskUserQuestion via canUseTool.
   * Emits user_question and waits for respondToQuestion() to deliver the
   * user's answer, then resolves with structured updatedInput.
   */
  _handleAskUserQuestion(input, signal) {
    return new Promise((resolve) => {
      const questionInput = input || {}
      this._waitingForAnswer = true
      this._pendingUserAnswer = { resolve, input: questionInput }

      const toolUseId = `ask-${++this._permissionCounter}-${Date.now()}`
      this._logInfo(`AskUserQuestion detected (${toolUseId})`)

      this.emit('user_question', {
        toolUseId,
        questions: questionInput.questions,
      })

      // Auto-deny on abort signal
      if (signal) {
        signal.addEventListener('abort', () => {
          if (this._pendingUserAnswer) {
            this._clearQuestionTimer()
            this._pendingUserAnswer = null
            this._waitingForAnswer = false
            resolve({ behavior: 'deny', message: 'Cancelled' })
          }
        }, { once: true })
      }

      // Auto-deny after timeout if no response
      this._questionTimer = setTimeout(() => {
        this._questionTimer = null
        if (this._pendingUserAnswer) {
          this._logInfo(`Question ${toolUseId} timed out, auto-denying`)
          this._pendingUserAnswer = null
          this._waitingForAnswer = false
          resolve({ behavior: 'deny', message: 'Question timed out' })
        }
      }, this._timeoutMs)
    })
  }

  /**
   * Resolve a pending permission request.
   *
   * @param {string} requestId - The permission request ID
   * @param {string} decision - 'allow', 'deny', or 'allowAlways'
   */
  respondToPermission(requestId, decision) {
    const pending = this._pendingPermissions.get(requestId)
    if (!pending) {
      this._logWarn(`No pending permission for ${requestId}`)
      return
    }
    this._pendingPermissions.delete(requestId)
    this._lastPermissionData.delete(requestId)
    this._clearPermissionTimer(requestId)

    this._logInfo(`Permission ${requestId} resolved: ${decision}`)

    if (decision === 'allow') {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
    } else if (decision === 'allowAlways') {
      pending.resolve({ behavior: 'allowAlways', updatedInput: pending.input })
    } else {
      pending.resolve({ behavior: 'deny', message: 'User denied' })
    }
  }

  /**
   * Send a response to an AskUserQuestion prompt.
   *
   * @param {string} text - The user's text answer
   * @param {Object} [answersMap] - Per-question answers map
   */
  respondToQuestion(text, answersMap) {
    if (!this._pendingUserAnswer) return
    this._clearQuestionTimer()
    const { resolve, input } = this._pendingUserAnswer
    this._pendingUserAnswer = null
    this._waitingForAnswer = false

    this._logInfo(`Question response received: "${text.slice(0, 60)}"`)

    // Build structured answers map: SDK expects { [questionText]: selectedLabel }
    const answers = {}
    const questions = input.questions || []
    const questionKeys = new Set(questions.map(q => q.question))
    if (answersMap && typeof answersMap === 'object' && Object.keys(answersMap).length > 0) {
      // Per-question answers provided by the client — only copy known question keys
      for (const key of Object.keys(answersMap)) {
        if (questionKeys.has(key)) {
          answers[key] = answersMap[key]
        }
      }
    } else if (questions.length > 0) {
      // Fallback: single answer mapped to all questions
      for (const q of questions) {
        answers[q.question] = text
      }
    }

    resolve({
      behavior: 'allow',
      updatedInput: {
        questions,
        answers,
      },
    })
  }

  /**
   * Clear a permission timeout timer by request ID.
   */
  _clearPermissionTimer(requestId) {
    const timer = this._permissionTimers.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this._permissionTimers.delete(requestId)
    }
  }

  /**
   * Clear the AskUserQuestion timeout timer.
   */
  _clearQuestionTimer() {
    if (this._questionTimer) {
      clearTimeout(this._questionTimer)
      this._questionTimer = null
    }
  }

  /**
   * Auto-deny all pending permissions and questions. Called on message
   * completion or session destruction.
   */
  clearAll() {
    // Auto-deny pending permissions and clear timers
    for (const [requestId, pending] of this._pendingPermissions) {
      this._clearPermissionTimer(requestId)
      pending.resolve({ behavior: 'deny', message: 'Message completed' })
    }
    this._pendingPermissions.clear()
    this._lastPermissionData.clear()

    // Auto-deny pending user answer
    this._clearQuestionTimer()
    if (this._pendingUserAnswer) {
      this._pendingUserAnswer.resolve({ behavior: 'deny', message: 'Message completed' })
      this._pendingUserAnswer = null
    }
    this._waitingForAnswer = false
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    this.clearAll()
    this.removeAllListeners()
  }

  /** @private */
  _logInfo(msg) {
    if (this._log.info) {
      this._log.info(msg)
    } else {
      console.log(msg)
    }
  }

  /** @private */
  _logWarn(msg) {
    if (this._log.warn) {
      this._log.warn(msg)
    } else {
      console.warn(msg)
    }
  }
}
