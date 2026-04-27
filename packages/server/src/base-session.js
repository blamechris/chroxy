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
import {
  loadActiveSkillsLayered,
  formatSkillsForPrompt,
  findRepoSkillsDir,
  DEFAULT_SKILLS_DIR,
} from './skills-loader.js'

const VALID_PERMISSION_MODES = ['approve', 'auto', 'plan', 'acceptEdits']

export class BaseSession extends EventEmitter {
  /**
   * Custom event names emitted by this provider class that should be proxied
   * by SessionManager in addition to the built-in PROXIED_EVENTS list.
   *
   * Override in a subclass and return an array of event name strings.
   * Each name will be forwarded as a transient session_event (not recorded
   * in history and not replayed on reconnect).
   *
   * @returns {string[]}
   */
  static get customEvents() {
    return []
  }

  constructor({ cwd, model, permissionMode, skillsDir, repoSkillsDir } = {}) {
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

    // Skills are scanned once at construction.
    // - skillsDir overrides the global directory (#2957) — primarily for tests.
    // - repoSkillsDir overrides the per-repo directory walk-up (#3067) so tests
    //   can pin both layers without touching the real filesystem; if omitted,
    //   walk up from this.cwd looking for the nearest .chroxy/skills/.
    this._skillsDir = skillsDir || DEFAULT_SKILLS_DIR
    this._repoSkillsDir = repoSkillsDir !== undefined
      ? repoSkillsDir
      : findRepoSkillsDir(this.cwd)
    this._skills = loadActiveSkillsLayered({
      globalDir: this._skillsDir,
      repoDir: this._repoSkillsDir,
    })
    this._skillsText = formatSkillsForPrompt(this._skills)
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
  /**
   * Parse a JSONL line from a subprocess stdout.
   * Returns the parsed object or null if the line is empty or invalid JSON.
   * @param {string} line
   * @returns {object|null}
   */
  _parseJsonLine(line) {
    if (!line || !line.trim()) return null
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }

  /**
   * Shared skills system MVP (#2957).
   *
   * Returns the list of active skills discovered at construction. Providers
   * that want a summary for `list_skills` can use this; providers that want
   * the injection-ready text should use `_buildSystemPrompt()`.
   *
   * @returns {Array<{ name: string, body: string, description: string }>}
   */
  _getSkills() {
    return Array.isArray(this._skills) ? this._skills : []
  }

  /**
   * Return the formatted skills text for injection into the provider's
   * system prompt (Claude SDK `systemPrompt.append`, CLI
   * `--append-system-prompt`) or prefixed to the first user message
   * (Codex, Gemini). Returns an empty string when no skills are active.
   *
   * @returns {string}
   */
  _buildSystemPrompt() {
    return typeof this._skillsText === 'string' ? this._skillsText : ''
  }

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
