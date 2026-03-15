/**
 * BaseSession — shared state and behavior for all session providers.
 *
 * Extracts the common state machine (busy/ready flags, message counter,
 * agent tracking) and shared method patterns (setModel guard,
 * setPermissionMode validation, _clearMessageState) so CliSession,
 * SdkSession, and GeminiSession don't duplicate them.
 */
import { EventEmitter } from 'events'
import { resolveModelId } from './models.js'

const VALID_PERMISSION_MODES = ['approve', 'auto', 'plan', 'acceptEdits']

export class BaseSession extends EventEmitter {
  constructor({ cwd, model, permissionMode } = {}) {
    super()
    this.cwd = cwd || process.cwd()
    this.model = model || null
    this.permissionMode = permissionMode || 'approve'

    this._isBusy = false
    this._processReady = false
    this._messageCounter = 0
    this._currentMessageId = null
    this._destroying = false
    this._activeAgents = new Map()
    this._resultTimeout = null
  }

  get isRunning() {
    return this._isBusy
  }

  /** Current thinking level. Override in subclasses that support it. */
  get thinkingLevel() { return undefined }

  get isReady() {
    return this._processReady && !this._isBusy
  }

  /**
   * Change the model. Subclasses that need to restart (CliSession) should
   * override and call super.setModel() for the guard + resolve, then act.
   * Returns true if the model actually changed (subclass should act).
   */
  setModel(model) {
    if (this._isBusy) {
      return false
    }
    const newModel = model ? resolveModelId(model) : null
    if (newModel === this.model) {
      return false
    }
    this.model = newModel
    return true
  }

  /**
   * Change the permission mode. Subclasses that need to restart (CliSession)
   * should override and call super.setPermissionMode() for validation.
   * Returns true if the mode actually changed.
   */
  setPermissionMode(mode) {
    if (!VALID_PERMISSION_MODES.includes(mode)) {
      return false
    }
    if (this._isBusy) {
      return false
    }
    if (mode === this.permissionMode) {
      return false
    }
    this.permissionMode = mode
    return true
  }

  /**
   * Clear per-message state. Subclasses should call super._clearMessageState()
   * and then clear their own additional state (plan mode, pending permissions, etc.).
   */
  _clearMessageState() {
    this._isBusy = false
    this._currentMessageId = null

    // Emit completions for any tracked agents so the app clears badges
    if (this._activeAgents.size > 0) {
      for (const agent of this._activeAgents.values()) {
        this.emit('agent_completed', { toolUseId: agent.toolUseId })
      }
      this._activeAgents.clear()
    }

    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }
  }
}
