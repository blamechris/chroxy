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
  groupSkillsByInjectionMode,
  findRepoSkillsDir,
  DEFAULT_SKILLS_DIR,
  SKILLS_PROMPT_HEADER,
} from './skills-loader.js'
import { SkillsTrustStore } from './skills-trust.js'

const VALID_PERMISSION_MODES = ['approve', 'auto', 'plan', 'acceptEdits']

// Default per-provider injection mode (#3200). Subprocess providers without
// a system-prompt flag (Codex, Gemini) prepend skills to the first user
// message; Claude (SDK or CLI) appends to the system prompt. Maps the
// session's provider id to the channel that the existing skills text
// pipeline already uses, so a skill without `injection:` keeps its
// behaviour from v1.
const DEFAULT_INJECTION_BY_PROVIDER = {
  'claude-sdk': 'append',
  'claude-cli': 'append',
  'docker-sdk': 'append',
  'docker-cli': 'append',
  'docker': 'append',
  'codex': 'prepend',
  'gemini': 'prepend',
}
const FALLBACK_INJECTION_MODE = 'append'

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

  constructor({
    cwd,
    model,
    permissionMode,
    skillsDir,
    repoSkillsDir,
    maxSkillBytes,
    maxTotalSkillBytes,
    provider,
    activeManualSkills,
    providerSkillAllowlist,
    trustStore,
    trustMismatchMode,
  } = {}) {
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

    // Provider id (registry key from providers.js — `claude-sdk`, `codex`,
    // etc.). Stored so frontmatter `providers:` filtering (#3198) and
    // injection-mode defaulting (#3200) can run at construction. Optional
    // — tests and ad-hoc instantiations may omit it; the loader treats
    // null provider as "no provider scoping" (skills with a `providers:`
    // list are filtered OUT, skills without one still apply).
    this._provider = provider || null

    // Per-session manually-activated skill names (#3199). Skills declared
    // `activation: manual` are off by default and only load when their
    // name is in this Set. The runtime toggle WS API that mutates this
    // Set is tracked in #3209; for now the Set is populated from
    // constructor input and never changes. Stored for forward
    // compatibility so a future toggle handler can mutate + re-load
    // without changing the BaseSession shape.
    this._activeManualSkills = activeManualSkills instanceof Set
      ? new Set(activeManualSkills)
      : (Array.isArray(activeManualSkills) ? new Set(activeManualSkills) : new Set())

    // Skills are scanned once at construction.
    // - skillsDir overrides the global directory (#2957) — primarily for tests.
    // - repoSkillsDir overrides the per-repo directory walk-up (#3067) so tests
    //   can pin both layers without touching the real filesystem; if omitted,
    //   walk up from this.cwd looking for the nearest .chroxy/skills/.
    // - maxSkillBytes / maxTotalSkillBytes override the loader's 32KB / 256KB
    //   defaults (#3202); plumbed from server config via SessionManager.
    this._skillsDir = skillsDir || DEFAULT_SKILLS_DIR
    this._repoSkillsDir = repoSkillsDir !== undefined
      ? repoSkillsDir
      : findRepoSkillsDir(this.cwd)
    const layerOpts = {
      globalDir: this._skillsDir,
      repoDir: this._repoSkillsDir,
      provider: this._provider,
      activeManualSkills: this._activeManualSkills,
      defaultInjectionMode: DEFAULT_INJECTION_BY_PROVIDER[this._provider] || FALLBACK_INJECTION_MODE,
    }
    if (Number.isFinite(maxSkillBytes)) layerOpts.maxSkillBytes = maxSkillBytes
    if (Number.isFinite(maxTotalSkillBytes)) layerOpts.maxTotalSkillBytes = maxTotalSkillBytes
    // Per-provider skill allowlist (#3207). When omitted, the loader is
    // permissive (legacy behaviour). When supplied, non-Claude providers
    // are filtered to the named subset and a missing entry filters all
    // skills for that provider (fail-secure). Plumbed by SessionManager
    // from the server config.
    if (providerSkillAllowlist != null && typeof providerSkillAllowlist === 'object'
      && !Array.isArray(providerSkillAllowlist)) {
      layerOpts.providerSkillAllowlist = providerSkillAllowlist
    }

    // Trust store (#3204). Two activation paths:
    //   - `trustStore: <SkillsTrustStore-like>` — caller-supplied store
    //     (tests pin a temp file path here so the real
    //     ~/.chroxy/skills-trust.json is never touched).
    //   - `trustMismatchMode: 'warn' | 'block'` — opt into the default
    //     store at ~/.chroxy/skills-trust.json with the chosen mode.
    //     SessionManager always passes one of these strings through;
    //     direct BaseSession construction without it (existing tests,
    //     ad-hoc instantiation) keeps the legacy no-op behaviour.
    // Mismatch events are collected during the synchronous loader call
    // and re-emitted on `process.nextTick` because SessionManager wires
    // event listeners AFTER the constructor returns — a synchronous
    // emit here would land on an empty listener set.
    let resolvedTrustStore = null
    if (trustStore) {
      resolvedTrustStore = trustStore
    } else if (trustMismatchMode === 'warn' || trustMismatchMode === 'block') {
      resolvedTrustStore = new SkillsTrustStore({ mode: trustMismatchMode })
    }
    this._trustStore = resolvedTrustStore
    const pendingTrustEvents = []
    if (resolvedTrustStore) {
      layerOpts.trustStore = resolvedTrustStore
      layerOpts.onTrustMismatch = (info) => { pendingTrustEvents.push(info) }
    }
    this._skills = loadActiveSkillsLayered(layerOpts)
    // Persist any newly-recorded hashes / lastVerified bumps. Failure to
    // write is non-fatal — the SkillsTrustStore swallows errors.
    if (resolvedTrustStore && typeof resolvedTrustStore.flush === 'function') {
      try { resolvedTrustStore.flush() } catch { /* ignore */ }
    }
    if (pendingTrustEvents.length > 0) {
      // `process.nextTick` runs before any pending I/O / setImmediate
      // but after the current call stack unwinds, so SessionManager has
      // had a chance to attach event listeners by the time we fire.
      process.nextTick(() => {
        for (const ev of pendingTrustEvents) {
          this.emit('skill_changed', ev)
        }
      })
    }
    // Split skills by injection mode (#3200). Each provider implementation
    // calls _buildSystemPrompt() (back-compat alias for the append/system
    // bucket) and _buildPrependPrompt() (the prepend bucket); subprocess
    // providers that have no system-prompt channel concatenate both in
    // their first-message prepend path so a skill that asks for `system`
    // injection still ends up in front of the user message.
    const grouped = groupSkillsByInjectionMode(this._skills)
    this._skillsByMode = grouped
    this._skillsText = formatSkillsForPrompt(grouped.append)
    this._prependSkillsText = formatSkillsForPrompt(grouped.prepend)
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
   * `--append-system-prompt`). Returns an empty string when no skills are
   * active.
   *
   * Per-skill injection mode (#3200): this returns ONLY skills whose
   * resolved `injectionMode` is `append` / `system`. Skills that asked
   * for `prepend` are returned by `_buildPrependPrompt()` instead. On
   * Claude (which has both channels available), the system-prompt path
   * is the existing v1 default; on Codex / Gemini there is no system
   * prompt so this returns '' for any skill that explicitly asked for
   * `injection: append` — those callers should fall back through
   * `_buildPrependPrompt()`.
   *
   * @returns {string}
   */
  _buildSystemPrompt() {
    return typeof this._skillsText === 'string' ? this._skillsText : ''
  }

  /**
   * Return the formatted skills text for prepending to the first user
   * message (Codex, Gemini default; any provider when a skill declares
   * `injection: prepend`). Returns an empty string when no skills are
   * active for this channel.
   *
   * Subprocess providers that have no system-prompt channel should
   * concatenate `_buildSystemPrompt()` + `_buildPrependPrompt()` so a
   * Claude-targeted skill that nonetheless ended up loaded for a Codex
   * session still injects (rare — `providers:` filtering normally
   * prevents this — but defensive against typos in frontmatter).
   *
   * @returns {string}
   */
  _buildPrependPrompt() {
    return typeof this._prependSkillsText === 'string' ? this._prependSkillsText : ''
  }

  /**
   * Return a single skills payload that concatenates BOTH the prepend bucket
   * and the append/system bucket with the `# User skills` header rendered
   * exactly once at the top (#3228). Used by subprocess providers (Codex,
   * Gemini) that have no system-prompt channel and must inline every loaded
   * skill into the first user message.
   *
   * Why this exists: `_buildSystemPrompt()` and `_buildPrependPrompt()` each
   * carry their own `# User skills` header so they're complete payloads when
   * routed to their natural channel. Concatenating their string outputs
   * directly produced two headers in the final user-message prefix — caught
   * in PR #3224 review. Building from the two skill lists with a single
   * call to `formatSkillsForPrompt({ includeHeader: false })` per bucket
   * sidesteps that.
   *
   * Returns an empty string when both buckets are empty so the caller can
   * branch on truthiness without null-checking.
   *
   * @returns {string}
   */
  _buildCombinedSkillsPrefix() {
    const prependList = this._skillsByMode && Array.isArray(this._skillsByMode.prepend)
      ? this._skillsByMode.prepend
      : []
    const appendList = this._skillsByMode && Array.isArray(this._skillsByMode.append)
      ? this._skillsByMode.append
      : []

    if (prependList.length === 0 && appendList.length === 0) return ''

    const parts = []
    const prependText = formatSkillsForPrompt(prependList, { includeHeader: false })
    if (prependText) parts.push(prependText)
    const appendText = formatSkillsForPrompt(appendList, { includeHeader: false })
    if (appendText) parts.push(appendText)
    if (parts.length === 0) return ''

    return `${SKILLS_PROMPT_HEADER}${parts.join('\n\n---\n\n')}`
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
