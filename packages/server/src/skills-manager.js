// SkillsManager (#5376) — extracted from BaseSession.
//
// Owns the shared-skills system (#2957): the immutable load-time inputs
// (skills dirs, byte caps, provider allowlist, trust store), the per-session
// manual-activation set (#3199/#3209), the parse cache (#3248), and the
// loader-built caches (`_skills`, `_skillsByMode`, `_skillsText`,
// `_prependSkillsText`, `_manualSkillNames`). Runs the layered loader and the
// runtime activate/deactivate toggle.
//
// BaseSession composes one of these and exposes thin compat getters (and a
// couple of setters) so every existing consumer — `session._skillsDir`,
// `session._providerSkillAllowlist`, the prompt builders, the #5367 opt
// sentinel — keeps reading the same surface. Trust / community-trust events
// still flow from the session via an injected `emit` callback; the constructor
// load deliberately RETURNS its collected events so BaseSession can re-emit
// them on `process.nextTick` (its listeners attach after the ctor returns).
//
// Field names are kept identical to the pre-extraction BaseSession fields so
// the moved method bodies read verbatim and the compat shims delegate without
// translation.

import {
  loadActiveSkillsLayered,
  formatSkillsForPrompt,
  groupSkillsByInjectionMode,
  findRepoSkillsDir,
  DEFAULT_SKILLS_DIR,
} from './skills-loader.js'
import { SkillsTrustStore } from './skills-trust.js'

export const DEFAULT_INJECTION_BY_PROVIDER = {
  'claude-sdk': 'append',
  'claude-cli': 'append',
  'docker-sdk': 'append',
  'docker-cli': 'append',
  'docker': 'append',
  'codex': 'prepend',
  'gemini': 'prepend',
}
export const FALLBACK_INJECTION_MODE = 'append'

export class SkillsManager {
  /**
   * @param {{
   *   cwd: string,
   *   provider?: string|null,
   *   activeManualSkills?: Set<string>|string[],
   *   skillsDir?: string,
   *   repoSkillsDir?: string|null,
   *   maxSkillBytes?: number|null,
   *   maxTotalSkillBytes?: number|null,
   *   providerSkillAllowlist?: object|null,
   *   trustStore?: object|null,
   *   trustMismatchMode?: 'warn'|'block'|null,
   *   emit: (event: string, payload: object) => void,
   * }} opts
   *   `emit` — the session's bound emitter; the runtime toggle path emits
   *   `skill_trust_request` through it. Does NOT auto-load; the caller runs
   *   `loadSkills({ collectTrustEvents: true })` so it controls emit timing.
   */
  constructor({
    cwd,
    provider,
    activeManualSkills,
    skillsDir,
    repoSkillsDir,
    maxSkillBytes,
    maxTotalSkillBytes,
    providerSkillAllowlist,
    trustStore,
    trustMismatchMode,
    emit,
  } = {}) {
    if (typeof emit !== 'function') {
      throw new TypeError('SkillsManager requires an emit callback')
    }
    this._emit = emit

    // Provider id (registry key from providers.js). Used for frontmatter
    // `providers:` filtering (#3198) and injection-mode defaulting (#3200).
    // Null provider means "no provider scoping".
    this._provider = provider || null

    // Per-session manually-activated skill names (#3199). Skills declared
    // `activation: manual` are off by default and only load when their name is
    // in this Set. #3209 adds the WS toggle path (activate/deactivate).
    this._activeManualSkills = activeManualSkills instanceof Set
      ? new Set(activeManualSkills)
      : (Array.isArray(activeManualSkills) ? new Set(activeManualSkills) : new Set())

    // Cache the immutable load-time inputs so the runtime toggle path (#3209)
    // can rebuild layerOpts without re-parsing constructor args.
    this._skillsDir = skillsDir || DEFAULT_SKILLS_DIR
    this._repoSkillsDir = repoSkillsDir !== undefined
      ? repoSkillsDir
      : findRepoSkillsDir(cwd)
    this._maxSkillBytes = Number.isFinite(maxSkillBytes) ? maxSkillBytes : null
    this._maxTotalSkillBytes = Number.isFinite(maxTotalSkillBytes) ? maxTotalSkillBytes : null
    this._providerSkillAllowlist = providerSkillAllowlist != null
      && typeof providerSkillAllowlist === 'object'
      && !Array.isArray(providerSkillAllowlist)
      ? providerSkillAllowlist
      : null

    // Trust store (#3204). Two activation paths: caller-supplied `trustStore`
    // (tests pin a temp file) or `trustMismatchMode: 'warn'|'block'` opting into
    // the default store. Without either, trust is a no-op (null).
    let resolvedTrustStore = null
    if (trustStore) {
      resolvedTrustStore = trustStore
    } else if (trustMismatchMode === 'warn' || trustMismatchMode === 'block') {
      resolvedTrustStore = new SkillsTrustStore({ mode: trustMismatchMode })
    }
    this._trustStore = resolvedTrustStore

    // #3248: per-session parse cache. Map keyed by realpath; the loader writes
    // through so subsequent loads (every activate/deactivate toggle) skip
    // readFileSync / parseFrontmatter for files whose mtimeMs is unchanged.
    this._skillsParseCache = new Map()

    // Loader-built caches — populated by loadSkills().
    this._skills = []
    this._manualSkillNames = new Set()
    this._skillsByMode = { append: [], prepend: [] }
    this._skillsText = ''
    this._prependSkillsText = ''
  }

  /**
   * Build the layered-loader options + run the loader, populating the skill
   * caches (`_skills`, `_skillsByMode`, `_skillsText`, `_prependSkillsText`).
   * Used by both the initial construction load and the runtime
   * activate/deactivate toggle (#3209) so loader-side state stays the single
   * source of truth.
   *
   * @param {{ collectTrustEvents?: boolean }} [opts]
   * @returns {{ trustEvents: Array<object>, communityTrustEvents: Array<object> }}
   */
  loadSkills({ collectTrustEvents = false } = {}) {
    const layerOpts = {
      globalDir: this._skillsDir,
      repoDir: this._repoSkillsDir,
      provider: this._provider,
      activeManualSkills: this._activeManualSkills,
      defaultInjectionMode: DEFAULT_INJECTION_BY_PROVIDER[this._provider] || FALLBACK_INJECTION_MODE,
      // #3253: include inactive manual skills in the unified scan so
      // activateSkill can validate names against `_manualSkillNames` without a
      // second scan. The active subset is partitioned out below; inactive
      // entries never reach the model (bodies aren't loaded for them).
      includeInactive: true,
    }
    if (this._maxSkillBytes !== null) layerOpts.maxSkillBytes = this._maxSkillBytes
    if (this._maxTotalSkillBytes !== null) layerOpts.maxTotalSkillBytes = this._maxTotalSkillBytes
    if (this._providerSkillAllowlist) layerOpts.providerSkillAllowlist = this._providerSkillAllowlist
    // #3248: hand the per-session parse cache to the loader.
    if (this._skillsParseCache instanceof Map) layerOpts.parseCache = this._skillsParseCache

    const pendingTrustEvents = []
    const pendingCommunityTrustEvents = []
    if (this._trustStore) {
      layerOpts.trustStore = this._trustStore
      if (collectTrustEvents) {
        layerOpts.onTrustMismatch = (info) => { pendingTrustEvents.push(info) }
      }
      // Hash recording happens via trustStore.inspect() inside the loader
      // regardless; the callback is just the mismatch-event channel. On runtime
      // reload (collectTrustEvents=false) we omit it so a user-initiated toggle
      // does NOT re-emit skill_changed events that already fired at construction.

      // #3297: community trust checker — lets the loader gate community skills
      // pending a first-activation grant.
      if (typeof this._trustStore.isCommunityTrusted === 'function') {
        layerOpts.communityTrustChecker = this._trustStore.isCommunityTrusted.bind(this._trustStore)
      }
      // Always collect community trust pending events (fired on both
      // construction and runtime reload).
      layerOpts.onCommunityTrustPending = (info) => { pendingCommunityTrustEvents.push(info) }
    }

    const all = loadActiveSkillsLayered(layerOpts)
    if (this._trustStore && typeof this._trustStore.flush === 'function') {
      try { this._trustStore.flush() } catch { /* ignore */ }
    }

    // #3253: partition the unified scan into the active subset (used for prompt
    // injection) and a Set of all manual-skill names (used by activateSkill to
    // validate without re-scanning).
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
   * Activate a manual skill at runtime (#3209). The skill must exist on disk
   * AND declare `activation: manual` — arbitrary strings, typos, and
   * `activation: auto` names are rejected (return false). Returns true when the
   * active set actually changed; emits `skill_trust_request` (via the injected
   * emit) for any community skill the reload surfaced.
   *
   * @param {string} skillName
   * @returns {boolean}
   */
  activateSkill(skillName) {
    if (typeof skillName !== 'string' || skillName === '') return false
    if (this._activeManualSkills.has(skillName)) return false

    // #3253: speculatively add and reload — the unified loadSkills scan
    // populates both the prompt-context caches AND the `_manualSkillNames`
    // validation set, so one scan covers validation + reload. On the rare
    // failure path (typo / auto-skill name) we run a rollback scan.
    this._activeManualSkills.add(skillName)
    const { communityTrustEvents } = this.loadSkills()
    if (!this._manualSkillNames.has(skillName)) {
      this._activeManualSkills.delete(skillName)
      this.loadSkills()
      return false
    }
    for (const ev of communityTrustEvents) {
      this._emit('skill_trust_request', ev)
    }
    return true
  }

  /**
   * Deactivate a manual skill at runtime (#3209). Returns true when the active
   * set actually changed; false otherwise.
   *
   * @param {string} skillName
   * @returns {boolean}
   */
  deactivateSkill(skillName) {
    if (typeof skillName !== 'string' || skillName === '') return false
    if (!this._activeManualSkills.has(skillName)) return false
    this._activeManualSkills.delete(skillName)
    const { communityTrustEvents } = this.loadSkills()
    for (const ev of communityTrustEvents) {
      this._emit('skill_trust_request', ev)
    }
    return true
  }
}
