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
    promptEvaluator,
  } = {}) {
    super()
    this.cwd = cwd || process.cwd()
    this.model = model || null
    this.permissionMode = permissionMode || 'approve'
    // #3185: per-session toggle for the auto-evaluator chain (parent epic
    // #3068). Default `false` — the existing manual `evaluate_draft` flow
    // (PR #3089) is unaffected by this flag. Coerced to a strict boolean
    // here so JSON.stringify produces `true`/`false` (not `1`/`null`) on
    // the auth_ok / session_list wires.
    this.promptEvaluator = !!promptEvaluator

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
    // name is in this Set. #3209 adds the WS toggle path
    // (activateSkill/deactivateSkill) that mutates this Set + reloads.
    this._activeManualSkills = activeManualSkills instanceof Set
      ? new Set(activeManualSkills)
      : (Array.isArray(activeManualSkills) ? new Set(activeManualSkills) : new Set())

    // Cache the immutable load-time inputs so the runtime toggle path
    // (#3209) can rebuild layerOpts without re-parsing constructor args.
    // These are set once at construction and never mutate.
    this._skillsDir = skillsDir || DEFAULT_SKILLS_DIR
    this._repoSkillsDir = repoSkillsDir !== undefined
      ? repoSkillsDir
      : findRepoSkillsDir(this.cwd)
    this._maxSkillBytes = Number.isFinite(maxSkillBytes) ? maxSkillBytes : null
    this._maxTotalSkillBytes = Number.isFinite(maxTotalSkillBytes) ? maxTotalSkillBytes : null
    this._providerSkillAllowlist = providerSkillAllowlist != null
      && typeof providerSkillAllowlist === 'object'
      && !Array.isArray(providerSkillAllowlist)
      ? providerSkillAllowlist
      : null

    // Trust store (#3204). Two activation paths:
    //   - `trustStore: <SkillsTrustStore-like>` — caller-supplied store
    //     (tests pin a temp file path here so the real
    //     ~/.chroxy/skills-trust.json is never touched).
    //   - `trustMismatchMode: 'warn' | 'block'` — opt into the default
    //     store at ~/.chroxy/skills-trust.json with the chosen mode.
    //     SessionManager always passes one of these strings through;
    //     direct BaseSession construction without it (existing tests,
    //     ad-hoc instantiation) keeps the legacy no-op behaviour.
    let resolvedTrustStore = null
    if (trustStore) {
      resolvedTrustStore = trustStore
    } else if (trustMismatchMode === 'warn' || trustMismatchMode === 'block') {
      resolvedTrustStore = new SkillsTrustStore({ mode: trustMismatchMode })
    }
    this._trustStore = resolvedTrustStore

    // #3248: per-session parse cache. Map keyed by realpath; values
    // hold `{ mtimeMs, size, body, frontmatter, finalBody, description }`
    // so subsequent _loadSkills() calls (every activate/deactivate
    // toggle) skip readFileSync / parseFrontmatter for files whose
    // mtimeMs is unchanged. The loader writes through to this Map —
    // invalidation is automatic when the on-disk mtimeMs moves.
    this._skillsParseCache = new Map()

    // Skills are scanned at construction. #3209 adds a runtime reload
    // path for manual activation toggles. Mismatch events are
    // collected during the synchronous loader call and re-emitted on
    // `process.nextTick` because SessionManager wires event listeners
    // AFTER the constructor returns — a synchronous emit here would
    // land on an empty listener set.
    const { trustEvents: pendingTrustEvents, communityTrustEvents: pendingCommunityTrustEvents } = this._loadSkills({ collectTrustEvents: true })
    if (pendingTrustEvents.length > 0 || pendingCommunityTrustEvents.length > 0) {
      process.nextTick(() => {
        for (const ev of pendingTrustEvents) {
          this.emit('skill_changed', ev)
        }
        for (const ev of pendingCommunityTrustEvents) {
          this.emit('skill_trust_request', ev)
        }
      })
    }
  }

  /**
   * Build the layered-loader options + run the loader, populating the
   * skill caches (`_skills`, `_skillsByMode`, `_skillsText`,
   * `_prependSkillsText`). Used by both the constructor and the
   * runtime activate/deactivate toggle (#3209) so the loader-side
   * state stays the single source of truth.
   *
   * @param {{ collectTrustEvents?: boolean }} [opts]
   * @returns {{ trustEvents: Array<object>, communityTrustEvents: Array<object> }}
   *   `trustEvents` — pending skill_changed events (mismatch) when collectTrustEvents=true.
   *   `communityTrustEvents` — pending skill_trust_request events for untrusted community skills.
   * @private
   */
  _loadSkills({ collectTrustEvents = false } = {}) {
    const layerOpts = {
      globalDir: this._skillsDir,
      repoDir: this._repoSkillsDir,
      provider: this._provider,
      activeManualSkills: this._activeManualSkills,
      defaultInjectionMode: DEFAULT_INJECTION_BY_PROVIDER[this._provider] || FALLBACK_INJECTION_MODE,
      // #3253: include inactive manual skills in the unified scan so
      // `activateSkill` can validate names against `_manualSkillNames`
      // without paying for a second validation-only scan. The active
      // subset is partitioned out below before populating the
      // prompt-context caches — inactive entries never reach the
      // model. Cost: a few metadata-only entries; bodies are not
      // loaded for inactive manual skills (skills-loader.js:646).
      includeInactive: true,
    }
    if (this._maxSkillBytes !== null) layerOpts.maxSkillBytes = this._maxSkillBytes
    if (this._maxTotalSkillBytes !== null) layerOpts.maxTotalSkillBytes = this._maxTotalSkillBytes
    if (this._providerSkillAllowlist) layerOpts.providerSkillAllowlist = this._providerSkillAllowlist
    // #3248: hand the per-session parse cache to the loader. Cache
    // hits skip readFileSync + parseFrontmatter; misses populate.
    if (this._skillsParseCache instanceof Map) layerOpts.parseCache = this._skillsParseCache

    const pendingTrustEvents = []
    const pendingCommunityTrustEvents = []
    if (this._trustStore) {
      layerOpts.trustStore = this._trustStore
      if (collectTrustEvents) {
        layerOpts.onTrustMismatch = (info) => { pendingTrustEvents.push(info) }
      }
      // Hash recording happens via `trustStore.inspect()` inside the
      // loader regardless of whether `onTrustMismatch` is wired — the
      // callback is just the mismatch-event delivery channel. On
      // runtime reload (collectTrustEvents=false) we deliberately
      // omit the callback so a user-initiated toggle does NOT
      // re-emit `skill_changed` events that already fired at session
      // construction.

      // #3297: community trust checker — allows the loader to gate
      // community skills pending a first-activation grant.
      if (typeof this._trustStore.isCommunityTrusted === 'function') {
        layerOpts.communityTrustChecker = this._trustStore.isCommunityTrusted.bind(this._trustStore)
      }
      // Always collect community trust pending events (fired on both
      // construction and runtime reload so re-entry from other sessions
      // sees the prompt after a grant clears an earlier block).
      layerOpts.onCommunityTrustPending = (info) => { pendingCommunityTrustEvents.push(info) }
    }

    const all = loadActiveSkillsLayered(layerOpts)
    if (this._trustStore && typeof this._trustStore.flush === 'function') {
      try { this._trustStore.flush() } catch { /* ignore */ }
    }

    // #3253: partition the unified scan into the active subset (used
    // for prompt injection) and a Set of all manual-skill names (used
    // by activateSkill to validate without re-scanning). Inactive
    // entries carry `active: false` from the loader; auto skills
    // don't carry the field at all and are always active.
    const manualNames = new Set()
    const active = []
    for (const s of all) {
      const activation = typeof s.metadata?.activation === 'string'
        ? s.metadata.activation.trim().toLowerCase()
        : null
      if (activation === 'manual') manualNames.add(s.name)
      if (s.active !== false) active.push(s)
    }
    this._skills = active
    this._manualSkillNames = manualNames

    const grouped = groupSkillsByInjectionMode(this._skills)
    this._skillsByMode = grouped
    this._skillsText = formatSkillsForPrompt(grouped.append)
    this._prependSkillsText = formatSkillsForPrompt(grouped.prepend)

    return { trustEvents: pendingTrustEvents, communityTrustEvents: pendingCommunityTrustEvents }
  }

  /**
   * Indicates whether runtime skill toggles take effect on the wire
   * for this provider (#3209 / #3246). The default is `false` — only
   * SdkSession overrides to `true` because the SDK rebuilds
   * `systemPrompt.append` on every turn from `_buildSystemPrompt()`.
   *
   * Subprocess providers (CliSession, CodexSession, GeminiSession)
   * embed the skills text into the persistent subprocess at start
   * (claude `--append-system-prompt`) or onto the first user message
   * (Codex / Gemini's `_skillsPrepended` flag). Mutating in-memory
   * state mid-session does NOT propagate to the running model, so the
   * WS handler refuses the toggle with `SKILL_TOGGLE_UNSUPPORTED` for
   * those providers and the dashboard hides / disables the checkbox.
   *
   * @returns {boolean}
   */
  supportsRuntimeSkillToggle() {
    return false
  }

  /**
   * Activate a manual skill at runtime (#3209). The skill must
   * actually exist on disk AND declare `activation: manual` —
   * arbitrary strings, typos, and `activation: auto` skill names
   * are rejected (return `false`). Without the existence check, a
   * stale entry would sit in `_activeManualSkills` forever, the
   * loader would silently drop it on every `_loadSkills()` call,
   * and the dashboard checkbox would falsely report success.
   *
   * Returns `true` when the active set actually changed (caller can
   * broadcast `skill_activated` and re-emit). `false` when already
   * active, when the name doesn't correspond to a real manual
   * skill, or when the input shape is invalid.
   *
   * @param {string} skillName
   * @returns {boolean}
   */
  activateSkill(skillName) {
    if (typeof skillName !== 'string' || skillName === '') return false
    if (this._activeManualSkills.has(skillName)) return false

    // #3253: speculatively add and reload — the unified `_loadSkills`
    // scan populates both the prompt-context caches AND the
    // `_manualSkillNames` validation set, so we can reuse one scan
    // for validation + reload rather than running a separate
    // validation-only scan first. On the rare failure path (typo /
    // auto-skill name) we run a rollback scan to restore the active
    // set; the common success path stays at one layered scan.
    this._activeManualSkills.add(skillName)
    const { communityTrustEvents } = this._loadSkills()
    if (!this._manualSkillNames.has(skillName)) {
      this._activeManualSkills.delete(skillName)
      this._loadSkills()
      return false
    }
    for (const ev of communityTrustEvents) {
      this.emit('skill_trust_request', ev)
    }
    return true
  }

  /**
   * Deactivate a manual skill at runtime (#3209). Returns true when
   * the active set actually changed; false otherwise. The
   * `_listManualSkillNames` validation isn't strictly needed here
   * (deactivating a name that isn't currently active is already a
   * no-op via the `has()` check), but mirroring `activateSkill`
   * keeps the contract symmetric.
   *
   * @param {string} skillName
   * @returns {boolean}
   */
  deactivateSkill(skillName) {
    if (typeof skillName !== 'string' || skillName === '') return false
    if (!this._activeManualSkills.has(skillName)) return false
    this._activeManualSkills.delete(skillName)
    const { communityTrustEvents } = this._loadSkills()
    for (const ev of communityTrustEvents) {
      this.emit('skill_trust_request', ev)
    }
    return true
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
   * Toggle the per-session promptEvaluator flag (#3185). Returns `true`
   * when the value changes (so callers can decide whether to broadcast a
   * `prompt_evaluator_changed` event and persist state) and `false` when
   * the input is invalid OR the value is unchanged. Strict-boolean only —
   * a non-boolean input is rejected without mutating state, defending
   * against malformed WS payloads.
   *
   * Unlike `setPermissionMode`, this is safe to flip while the session is
   * busy: the flag is only read at the start of the next prompt, so a
   * mid-turn change has no in-flight side effects.
   *
   * @param {boolean} value
   * @returns {boolean}
   */
  setPromptEvaluator(value) {
    if (typeof value !== 'boolean') {
      return false
    }
    if (value === this.promptEvaluator) {
      return false
    }
    this.promptEvaluator = value
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
   * Return the set of currently-active manual-skill names (#3209).
   * The dashboard reads this to know which checkboxes to render
   * checked. Callers MUST treat the return as read-only — mutate via
   * `activateSkill()` / `deactivateSkill()` so the loader rebuild
   * fires.
   *
   * @returns {string[]}
   */
  getActiveManualSkills() {
    return Array.from(this._activeManualSkills)
  }

  /**
   * Return the raw active-manual-skills Set (#3252).
   *
   * Same data as `getActiveManualSkills()` but as the underlying Set
   * so callers can do cheap `.has(name)` membership checks without
   * rebuilding from the array form. The returned Set is the same
   * instance held by this session — callers MUST treat it as
   * read-only and mutate via `activateSkill()` / `deactivateSkill()`
   * so the loader rebuild fires.
   *
   * @returns {Set<string>}
   */
  getActiveManualSkillsRaw() {
    return this._activeManualSkills
  }

  /**
   * Return the wired SkillsTrustStore, or null when trust is disabled
   * (#3252).
   *
   * Trust is opt-in: the operator sets `trustMismatchMode` to 'warn'
   * or 'block' to record per-skill content hashes and surface
   * mismatch warnings. Without that opt-in, the field is null and
   * the dashboard renders the panel without hash / last-verified
   * columns rather than showing fake data.
   *
   * @returns {import('./skills-trust.js').SkillsTrustStore | null}
   */
  getTrustStore() {
    return this._trustStore
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
