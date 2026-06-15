/**
 * Skills settings handlers — split out of settings-handlers.js (audit P2-4,
 * pure move). list_skills + skill activate/deactivate + skill-trust accept/
 * grant. Skill trust whitelists host-executable code, so trust mutations
 * require host-level authority (a pairing-bound token is rejected);
 * activate/deactivate are not gated (no more capability than ordinary input).
 */
import {
  resolveSession,
  resolveSessionOrError,
  requireSessionMethod,
  sendError,
  sendSessionError,
} from '../handler-utils.js'
import {
  loadActiveSkillsLayered,
  findRepoSkillsDir,
  findSkillForRetrust,
  DEFAULT_SKILLS_DIR,
  _isCommunityNamespace,
} from '../skills-loader.js'
import { realpathSync, readdirSync, statSync } from 'fs'
import { loggerForSession } from '../logger.js'

// #3250: strict ISO-8601 datetime gate matching the shape z.string().datetime()
// accepts. Used by handleListSkills to drop malformed timestamps from a
// hand-edited trust ledger before forwarding — see comment in handleListSkills
// for context. Date.parse is intentionally NOT used here: it accepts forms
// like "2026-03-18 10:00:00" (space separator) that the wire schema rejects.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/
function _isIsoDatetime(s) {
  return typeof s === 'string' && ISO_DATETIME_RE.test(s)
}
/**
 * Reject skill-trust mutations from a bound (pairing-issued) client. A skill is
 * EXECUTABLE CODE that runs on the host; granting trust (`skill_trust_grant`) or
 * re-accepting changed content (`skill_trust_accept`) whitelists that code to
 * run, which is a host-level integrity decision — the same class of escalation
 * as flipping auto permission mode or writing provider credentials. A bound
 * (share-a-session) token is scoped to USE the session, not to extend what code
 * the host will execute, so these require host-level authority (unbound client).
 *
 * Note: skill_activate / skill_deactivate are deliberately NOT gated here — they
 * only toggle ALREADY-installed, already-trusted local skills into the session,
 * which is no more capability than the input a bound client can already send.
 *
 * Returns true and sends the rejection if the client is bound (caller must
 * early-return); false to proceed. See docs/security/bearer-token-authority.md.
 */
function rejectSkillTrustIfBound(ws, client, msg, ctx) {
  if (!client?.boundSessionId) return false
  loggerForSession('ws', client.boundSessionId).warn(`Client ${client.id} (bound to ${client.boundSessionId}) attempted to modify skill trust (${msg?.type}) — rejected`)
  sendError(ws, msg?.requestId, 'SKILL_TRUST_FORBIDDEN_BOUND_CLIENT',
    'Pairing-issued session tokens cannot grant or accept skill trust (a skill is host-executable code). Use the primary API token from a device with physical access to this machine.', undefined, ctx)
  return true
}
/**
 * Return the active skills the running session is using.
 *
 * v1 (#2957) sourced skills only from `~/.chroxy/skills/`. v2 (#3067) layers a
 * repo-scoped overlay on top: walk up from the active session's cwd looking
 * for `.chroxy/skills/`, and let any repo file override a global file with the
 * same name. The payload includes a `source` ("global" or "repo") per skill so
 * clients can show which tier each one came from.
 *
 * The session loaded skills at construction with whatever `globalDir`/`repoDir`
 * it was given (including test overrides), so when an active session resolves
 * we mirror its loaded set instead of re-scanning disk — that keeps the WS
 * payload aligned with what's actually being injected and respects test-only
 * skillsDir overrides. The disk scan is the fallback used only when no session
 * is bound or it doesn't expose a skills accessor (e.g. mock sessions).
 *
 * Disabling a skill remains a filesystem rename (`*.disabled.md`); there's no
 * enable/disable UI in v2 either.
 */
function handleListSkills(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)

  // #3209: emit the full activation context so the dashboard can
  // render manual-skill toggles. For a bound session, run a fresh
  // layered scan with `includeInactive: true` against that session's
  // active set — the session's cached `_skills` only contains active
  // entries (manual ones are filtered at construction).
  // #3252: prefer the public getter so future BaseSession internal
  // refactors don't silently turn this into "no active skills" without
  // a type error or test failure. Optional-chaining the getter keeps
  // mock sessions (which don't define the method) compatible.
  const activeSetCandidate = entry?.session?.getActiveManualSkillsRaw?.()
  const activeSet = activeSetCandidate instanceof Set ? activeSetCandidate : new Set()
  // #3205: prefer the session's resolved skill dirs when available so
  // the response matches what the session is actually injecting. This
  // matters when the session was constructed with `skillsDir` /
  // `repoSkillsDir` overrides (tests pin temp dirs; future wiring may
  // override per-session). Fall back to the defaults / cwd-walk only
  // when the session doesn't expose these — typically because no
  // session is bound (the no-session path scans the global tier).
  const sessionSkillsDir = entry?.session?._skillsDir || DEFAULT_SKILLS_DIR
  const sessionRepoDir = entry?.session
    ? (entry.session._repoSkillsDir !== undefined
      ? entry.session._repoSkillsDir
      : (entry.session.cwd ? findRepoSkillsDir(entry.session.cwd) : null))
    : null
  const provider = entry?.provider || null
  // #3205: trust store powers the hash + last-activated metadata in
  // the response. When the session has no trust store wired (operator
  // didn't opt into 'warn' / 'block' modes), those fields are simply
  // omitted — the dashboard renders the panel without those columns
  // rather than showing fake data.
  // #3252: same getter pattern as activeSet — keeps mock sessions
  // working without forcing every test to add the method.
  const trustStore = entry?.session?.getTrustStore?.() ?? null

  // #3226 (review): forward the bound session's `providerSkillAllowlist`
  // (if any) so the per-session listing reflects what the prompt builder
  // would actually inject. Without this, on Codex/Gemini sessions with
  // an allowlist configured, the dashboard would still show toggles for
  // skills the runtime drops at prompt-build time. Skipped entirely
  // when `includeAllProviders` is true (#3226's no-session path).
  const sessionAllowlist = entry?.session?._providerSkillAllowlist || null

  const skills = loadActiveSkillsLayered({
    globalDir: sessionSkillsDir,
    repoDir: sessionRepoDir,
    provider,
    activeManualSkills: activeSet,
    providerSkillAllowlist: sessionAllowlist,
    includeInactive: true,
    // #3226: when no provider is bound (no session, or a session
    // that doesn't expose one), bypass the provider-scoping gate
    // and the per-provider allowlist so the dashboard's "browse
    // all installed skills" listing doesn't silently drop scoped
    // entries. Per-session listings keep `provider` set, so the
    // current session's filtered view is unchanged.
    includeAllProviders: provider == null,
  }).map((s) => {
    // `metadata.activation` is the authoritative source — keep
    // anything else as `auto` to match the loader's defaults.
    const rawActivation = typeof s.metadata?.activation === 'string'
      ? s.metadata.activation.trim().toLowerCase()
      : null
    const activation = rawActivation === 'manual' ? 'manual' : 'auto'

    const out = {
      name: s.name,
      description: s.description,
      source: s.source || 'global',
      activation,
      // For `auto` skills, `active` is always true (they always load).
      // For `manual` skills, reflect the loader's per-skill flag —
      // already set from the activeManualSkills membership.
      active: activation === 'auto' ? true : !!s.active,
    }

    // #3205: optional metadata fields — `version` from the YAML
    // frontmatter, `hashPrefix` + `lastVerified` from the trust store.
    // All optional so older clients keep parsing this response, and a
    // trust-disabled session still gets a useful panel (just without
    // the audit columns).
    const version = typeof s.metadata?.version === 'string' ? s.metadata.version.trim() : null
    if (version) out.version = version

    if (trustStore && typeof trustStore.getRecord === 'function' && typeof s.path === 'string') {
      const record = trustStore.getRecord(s.path)
      if (record) {
        // 8-char hash prefix matches the sanitised log + skill_changed
        // wire format from #3215 / #3234. The full SHA never leaves
        // the server.
        out.hashPrefix = record.sha256.slice(0, 8)
        // #3250: producer-side ISO-8601 validation. The wire schema
        // (ServerSkillsListSchema) tightened these to z.string().datetime();
        // a hand-edited or corrupted ~/.chroxy/skills-trust.json could
        // otherwise emit a non-ISO string that fails the WHOLE
        // skills_list payload at the dashboard parser. Drop the
        // offending field instead — the dashboard renders the panel
        // without that column rather than rejecting the response.
        //
        // Date.parse is too permissive (accepts e.g. "2026-03-18 10:00:00"
        // which z.string().datetime() rejects). Match Zod's strict
        // ISO-8601 shape: T separator + Z or numeric offset.
        if (typeof record.lastVerified === 'string'
            && _isIsoDatetime(record.lastVerified)) {
          out.lastVerified = record.lastVerified
        }
        if (typeof record.firstSeen === 'string'
            && _isIsoDatetime(record.firstSeen)) {
          out.firstSeen = record.firstSeen
        }
      }
    }

    return out
  })

  ctx.transport.send(ws, { type: 'skills_list', skills })
}

/**
 * #3209: activate a manual skill at runtime. The dashboard sends this
 * when a user checks a manual-skill toggle. The session's active set
 * is mutated, the skills list is reloaded so the next prompt picks
 * up the new skill, and a `skill_activated` broadcast lets other
 * clients on the same session refresh their UI.
 */
function handleSkillActivate(ws, client, msg, ctx) {
  if (typeof msg.skillName !== 'string' || msg.skillName === '') {
    sendSessionError(ws, ctx, 'skill_activate requires a non-empty `skillName`')
    return
  }
  const sessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSessionOrError(ws, ctx, msg, client)
  if (!entry) return
  if (!requireSessionMethod(ws, ctx, entry, 'activateSkill', 'This provider does not support skill activation')) {
    return
  }
  // #3246: subprocess providers (CliSession, CodexSession,
  // GeminiSession) snapshot the skills text at session start —
  // mutating in-memory state mid-session does not propagate to the
  // running model. Refuse the toggle with a distinct error code so
  // the dashboard can surface "this provider doesn't support runtime
  // toggle" UX instead of silently flipping a checkbox that does
  // nothing on the wire.
  if (typeof entry.session.supportsRuntimeSkillToggle === 'function'
    && !entry.session.supportsRuntimeSkillToggle()) {
    sendError(
      ws,
      msg?.requestId,
      'SKILL_TOGGLE_UNSUPPORTED',
      `Provider '${entry.provider}' does not support runtime skill toggling. Restart the session with the skill in 'activeManualSkills' instead.`,
      undefined,
      ctx,
    )
    return
  }

  const changed = entry.session.activateSkill(msg.skillName)
  if (!changed) return // already active or invalid name — no-op, no broadcast

  ctx.transport.broadcastToSession(sessionId, {
    type: 'skill_activated',
    sessionId,
    skillName: msg.skillName,
  })
}

/**
 * #3209: deactivate a manual skill at runtime. Mirror of
 * `handleSkillActivate`.
 */
function handleSkillDeactivate(ws, client, msg, ctx) {
  if (typeof msg.skillName !== 'string' || msg.skillName === '') {
    sendSessionError(ws, ctx, 'skill_deactivate requires a non-empty `skillName`')
    return
  }
  const sessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSessionOrError(ws, ctx, msg, client)
  if (!entry) return
  if (!requireSessionMethod(ws, ctx, entry, 'deactivateSkill', 'This provider does not support skill toggling')) {
    return
  }
  // #3246: same capability gate as activate — subprocess providers
  // can't honour a mid-session deactivate either.
  if (typeof entry.session.supportsRuntimeSkillToggle === 'function'
    && !entry.session.supportsRuntimeSkillToggle()) {
    sendError(
      ws,
      msg?.requestId,
      'SKILL_TOGGLE_UNSUPPORTED',
      `Provider '${entry.provider}' does not support runtime skill toggling. Restart the session without the skill in 'activeManualSkills' instead.`,
      undefined,
      ctx,
    )
    return
  }

  const changed = entry.session.deactivateSkill(msg.skillName)
  if (!changed) return // wasn't active — no-op, no broadcast

  ctx.transport.broadcastToSession(sessionId, {
    type: 'skill_deactivated',
    sessionId,
    skillName: msg.skillName,
  })
}

/**
 * #3235: operator-facing accept-hash surface for SkillsTrustStore. After
 * a content-hash mismatch fires (`skill_changed` event), the operator
 * needs a way to re-trust the new content without manually editing
 * `~/.chroxy/skills-trust.json`. This handler:
 *
 *   1. Validates the inbound `skillName`.
 *   2. Looks up the skill on the bound session (via `_getSkills()`) so
 *      we use the exact post-frontmatter `body` and `path` the loader
 *      already validated.
 *   3. Calls `trustStore.acceptHash(realPath, body)` to overwrite the
 *      stored hash with the current content's digest.
 *   4. Flushes the ledger so the new hash survives a crash.
 *   5. Broadcasts `skill_trust_accepted` so the dashboard can clear any
 *      mismatch badge — pairs with the `skill_changed` event from #3234.
 *
 * Error envelope:
 *   - `INVALID_SKILL_NAME` (session_error envelope) — missing/empty.
 *   - `No active session` (session_error envelope) — no bound session.
 *   - `TRUST_NOT_ENABLED` — bound session has no trust store wired.
 *   - `SKILL_NOT_FOUND` — name doesn't match any currently-loaded skill.
 *
 * The handler does NOT trigger a session reload — the new hash takes
 * effect on the NEXT load. In `block` mode, that's exactly what the
 * operator wants: re-trust now, the skill loads on next session start.
 */
function handleSkillTrustAccept(ws, client, msg, ctx) {
  if (rejectSkillTrustIfBound(ws, client, msg, ctx)) return
  if (typeof msg.skillName !== 'string' || msg.skillName === '') {
    sendSessionError(ws, ctx, 'skill_trust_accept requires a non-empty `skillName`')
    return
  }
  const sessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSessionOrError(ws, ctx, msg, client)
  if (!entry) return

  // #3252: getter-with-optional-chaining keeps mock sessions (which
  // don't define the method) compatible while still surfacing TRUST_NOT_ENABLED
  // for legitimate trust-disabled sessions.
  const trustStore = entry?.session?.getTrustStore?.() ?? null
  if (!trustStore || typeof trustStore.acceptHash !== 'function') {
    sendError(
      ws,
      msg?.requestId,
      'TRUST_NOT_ENABLED',
      'This session has no skills trust store wired (operator did not opt into warn/block mode).',
      undefined,
      ctx,
    )
    return
  }

  // Find the skill. We CAN'T use `_getSkills()` here: in `block` mode,
  // a hash-mismatched skill is filtered out at load time, which means
  // the very skills the operator is trying to re-trust are absent from
  // the loaded list. Fall back to a direct filesystem lookup that
  // bypasses the trust gate (#3235 review).
  let resolvedPath = null
  let resolvedBody = null

  // First try the session's already-loaded list — covers the warn-mode
  // case where the skill stays in `_skills` even after a mismatch.
  // Using the loaded entry's body+path is preferable when available
  // because the body has already been validated by the same loader pass
  // that recorded the trust hash.
  const loadedSkills = typeof entry.session._getSkills === 'function'
    ? entry.session._getSkills()
    : []
  const loaded = Array.isArray(loadedSkills)
    ? loadedSkills.find((s) => s && s.name === msg.skillName)
    : null
  if (loaded && typeof loaded.path === 'string' && typeof loaded.body === 'string') {
    resolvedPath = loaded.path
    resolvedBody = loaded.body
  } else {
    // Block-mode recovery path: scan the session's skill dirs directly.
    const sessionGlobalDir = entry?.session?._skillsDir || DEFAULT_SKILLS_DIR
    const sessionRepoDir = entry?.session?._repoSkillsDir !== undefined
      ? entry.session._repoSkillsDir
      : (entry?.session?.cwd ? findRepoSkillsDir(entry.session.cwd) : null)
    const found = findSkillForRetrust({
      skillName: msg.skillName,
      globalDir: sessionGlobalDir,
      repoDir: sessionRepoDir,
    })
    if (found) {
      resolvedPath = found.realPath
      resolvedBody = found.body
    }
  }

  if (resolvedPath === null || resolvedBody === null) {
    sendError(
      ws,
      msg?.requestId,
      'SKILL_NOT_FOUND',
      `No skill named '${msg.skillName}' found in the session's skill directories.`,
      undefined,
      ctx,
    )
    return
  }

  trustStore.acceptHash(resolvedPath, resolvedBody)

  // #3235 review: persist BEFORE broadcasting. If flush fails, the
  // dashboard mustn't clear the mismatch indicator on a hash that
  // never reached disk — the next restart would re-flag the skill.
  // Surface the error to the caller so they can retry.
  if (typeof trustStore.flush === 'function') {
    try {
      trustStore.flush()
    } catch (err) {
      // #4828: session-scoped — `sessionId` is in scope here.
      loggerForSession('ws', sessionId).warn(`skill_trust_accept: flush failed (${err && err.message ? err.message : err})`)
      sendError(
        ws,
        msg?.requestId,
        'TRUST_FLUSH_FAILED',
        'Accepted in memory but the trust ledger could not be persisted. Retry; the next restart may re-flag this skill.',
        undefined,
        ctx,
      )
      return
    }
  }

  ctx.transport.broadcastToSession(sessionId, {
    type: 'skill_trust_accepted',
    sessionId,
    skillName: msg.skillName,
  })
}

// #3500: shallow scan of community/*/<skillName>.{md,markdown} across the
// configured skills roots. Returns the first author (other than `claimedAuthor`)
// that actually owns the skill on disk, or null if no such author exists.
//
// Bounded cost: one readdirSync per skills root + one statSync per author dir
// per extension. Only invoked on the SKILL_NOT_FOUND error path after the
// per-author realpath lookup has already missed — never on the happy path.
//
// Each candidate is gated through `_isCommunityNamespace` against the root's
// realpath, mirroring the security check the per-author loop applies. That
// rejects hidden author dirs (.foo), symlinks that escape the root, and any
// segment shape that doesn't fit `community/<author>/<file>`.
function _scanCommunityForSkillName(skillsRoots, skillName, claimedAuthor) {
  for (const root of skillsRoots) {
    let rootReal
    try {
      rootReal = realpathSync(root)
    } catch {
      continue
    }
    let authorEntries
    try {
      authorEntries = readdirSync(`${rootReal}/community`, { withFileTypes: true })
    } catch {
      // No community/ dir under this root — skip.
      continue
    }
    // #3549: readdir order is filesystem/platform-dependent. Sort by name so
    // that when multiple community authors expose a skill with the same name,
    // the suggested `actualAuthor` is deterministic (matches the alphabetical
    // ordering used by the skills loader's community walk).
    authorEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const ent of authorEntries) {
      const authorName = ent.name
      // Mirror _isCommunityNamespace's hidden-author guard. We also need the
      // entry to be a directory (or a symlink to one) — readdir's withFileTypes
      // gives us .isDirectory() / .isSymbolicLink() checks without an extra stat
      // for the common case.
      if (!authorName || authorName === '.' || authorName === '..' || authorName.startsWith('.')) continue
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue
      if (authorName === claimedAuthor) continue
      for (const ext of ['md', 'markdown']) {
        const candidatePath = `${rootReal}/community/${authorName}/${skillName}.${ext}`
        let candidateReal
        try {
          candidateReal = realpathSync(candidatePath)
        } catch {
          continue
        }
        // Confirm the resolved path is regular and under community/<author>/.
        try {
          const st = statSync(candidateReal)
          if (!st.isFile()) continue
        } catch {
          continue
        }
        const { isCommunity, author: actualAuthor } = _isCommunityNamespace(candidateReal, rootReal)
        if (!isCommunity) continue
        if (!actualAuthor || actualAuthor === claimedAuthor) continue
        return actualAuthor
      }
    }
  }
  return null
}

/**
 * #3297: grant community trust for a given author/skill. Fired when the
 * dashboard operator accepts the first-activation prompt for a community
 * skill. Unlike `skill_trust_accept` (hash mismatch recovery), this
 * handler:
 *
 *   1. Validates `skillName` and `author` from the payload.
 *   2. Resolves the skill's realpath from the session's skills dirs
 *      (falling back to a direct community/<author>/<name>.md scan
 *      because community skills are absent from `_getSkills()` while
 *      pending trust).
 *   3. Applies a security gate: verifies the resolved path is genuinely
 *      under `community/<author>/` via `_isCommunityNamespace`, and that
 *      the directory author matches the claimed `author`.
 *   4. Calls `trustStore.grantCommunityTrust(author, { realPath })` to
 *      write both the byAuthor and byPath indexes and flush synchronously.
 *   5. Calls `session._loadSkills()` so the just-trusted skill is active
 *      for the CURRENT session immediately (no restart required).
 *   6. Broadcasts `skill_trust_granted` to all session clients and sends
 *      `skill_trust_grant_ok` ack to the requesting client.
 *
 * Error codes:
 *   - `INVALID_SKILL_NAME` — missing/empty skillName
 *   - `INVALID_AUTHOR` — missing/empty author, OR (#3307) the skill resolves
 *      on disk under a different `community/<author>/` namespace than the
 *      caller claims (e.g. via a symlink that crosses author dirs), OR (#3500)
 *      a shallow scan of `community/<author>/` finds the skillName under a different
 *      author when the per-author lookup misses (the common no-symlink case).
 *      For the cross-author cases the response carries `actualAuthor` as a
 *      structured field (#3538) — clients can branch on `code` and read
 *      `actualAuthor` directly to render "did you mean alice?" without
 *      regex-parsing the human-readable `message`. The empty-author
 *      validation case does NOT carry `actualAuthor` (no real author known).
 *   - `No active session` (session_error) — no bound session
 *   - `TRUST_NOT_ENABLED` — session has no trust store
 *   - `SKILL_NOT_FOUND` — can't find the skill on disk under any author
 *   - `TRUST_FLUSH_FAILED` — granted in memory but the trust ledger could not be persisted
 */
function handleSkillTrustGrant(ws, client, msg, ctx) {
  if (rejectSkillTrustIfBound(ws, client, msg, ctx)) return
  if (typeof msg.skillName !== 'string' || msg.skillName === '') {
    sendError(ws, msg?.requestId, 'INVALID_SKILL_NAME', 'skill_trust_grant requires a non-empty `skillName`', undefined, ctx)
    return
  }
  if (typeof msg.author !== 'string' || msg.author === '') {
    sendError(ws, msg?.requestId, 'INVALID_AUTHOR', 'skill_trust_grant requires a non-empty `author`', undefined, ctx)
    return
  }

  const sessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSessionOrError(ws, ctx, msg, client)
  if (!entry) return

  const trustStore = entry?.session?.getTrustStore?.() ?? null
  if (!trustStore || typeof trustStore.grantCommunityTrust !== 'function') {
    sendError(ws, msg?.requestId, 'TRUST_NOT_ENABLED', 'This session has no skills trust store wired.', undefined, ctx)
    return
  }

  // Resolve the skill path. Community skills are absent from _getSkills()
  // while pending trust, so we scan the community dirs directly.
  const sessionGlobalDir = entry?.session?._skillsDir || DEFAULT_SKILLS_DIR
  const sessionRepoDir = entry?.session?._repoSkillsDir !== undefined
    ? entry.session._repoSkillsDir
    : (entry?.session?.cwd ? findRepoSkillsDir(entry.session.cwd) : null)

  // Collect all skills roots to search
  const skillsRoots = [sessionGlobalDir]
  if (sessionRepoDir) skillsRoots.push(sessionRepoDir)

  let resolvedPath = null
  // #3307: track when the lookup resolves to a real file but lands under a
  // different community author than the caller claims. Distinguishes
  // "skill missing entirely" (SKILL_NOT_FOUND) from "skill exists under
  // a different namespace" (INVALID_AUTHOR) so clients can guide the
  // operator toward the correct author.
  let namespaceMismatchDetected = false
  // #3538: capture the real author of the cross-namespace resolve so we can
  // surface it as a structured field on INVALID_AUTHOR (no regex on message).
  let mismatchActualAuthor = null

  for (const root of skillsRoots) {
    let rootReal
    try {
      rootReal = realpathSync(root)
    } catch {
      continue
    }
    // Try community/<author>/<skillName> with each allowed extension (.md, .markdown)
    let candidateReal = null
    for (const ext of ['md', 'markdown']) {
      const candidatePath = `${root}/community/${msg.author}/${msg.skillName}.${ext}`
      try {
        candidateReal = realpathSync(candidatePath)
        break
      } catch {
        // not found with this extension — try next
      }
    }
    if (!candidateReal) continue
    // Security gate: verify the resolved path is under community/<author>/
    const { isCommunity, author: actualAuthor } = _isCommunityNamespace(candidateReal, rootReal)
    if (!isCommunity) continue
    if (actualAuthor !== msg.author) {
      // Skill exists on disk but the realpath belongs to a different community
      // author (e.g. via a symlink). Flag it so we can surface INVALID_AUTHOR
      // after the loop instead of the misleading SKILL_NOT_FOUND.
      namespaceMismatchDetected = true
      // Remember the real author so the error response can carry it
      // structurally (#3538). Keep the first hit — additional roots are
      // unlikely to disagree but if they do, the first match is what the
      // per-author lookup would have resolved to.
      if (mismatchActualAuthor === null) mismatchActualAuthor = actualAuthor
      continue
    }
    resolvedPath = candidateReal
    break
  }

  if (!resolvedPath) {
    if (namespaceMismatchDetected) {
      sendError(
        ws,
        msg?.requestId,
        'INVALID_AUTHOR',
        `Community skill '${msg.skillName}' resolves to a different author than '${msg.author}'.`,
        // #3538: structured field for client suggestions ("did you mean X?").
        { actualAuthor: mismatchActualAuthor },
        ctx,
      )
      return
    }
    // #3500: per-author realpath lookup missed. Before declaring SKILL_NOT_FOUND,
    // scan community/*/ for the skillName — the common operator path is
    // `community/alice/foo.md` exists with NO symlink under `community/<msg.author>/`,
    // and we want to surface "wrong author" rather than "missing".
    const actualAuthor = _scanCommunityForSkillName(skillsRoots, msg.skillName, msg.author)
    if (actualAuthor) {
      sendError(
        ws,
        msg?.requestId,
        'INVALID_AUTHOR',
        `Community skill '${msg.skillName}' is owned by '${actualAuthor}', not '${msg.author}'.`,
        // #3538: structured field for client suggestions ("did you mean X?").
        { actualAuthor },
        ctx,
      )
      return
    }
    sendError(ws, msg?.requestId, 'SKILL_NOT_FOUND', `No community skill '${msg.skillName}' found for author '${msg.author}'.`, undefined, ctx)
    return
  }

  try {
    trustStore.grantCommunityTrust(msg.author, { realPath: resolvedPath })
  } catch (err) {
    // #4828: session-scoped — `sessionId` is in scope earlier in the handler.
    loggerForSession('ws', sessionId).warn(`skill_trust_grant: flush failed (${err && err.message ? err.message : err})`)
    sendError(
      ws,
      msg?.requestId,
      'TRUST_FLUSH_FAILED',
      'Granted in memory but the trust ledger could not be persisted. Retry; the next restart may re-prompt for trust.',
      undefined,
      ctx,
    )
    return
  }

  // Reload skills immediately so the just-trusted skill is active in this session.
  if (typeof entry.session._loadSkills === 'function') {
    entry.session._loadSkills()
  }

  ctx.transport.broadcastToSession(sessionId, {
    type: 'skill_trust_granted',
    sessionId,
    skillName: msg.skillName,
    author: msg.author,
  })

  ctx.transport.send(ws, {
    type: 'skill_trust_grant_ok',
    requestId: msg?.requestId ?? null,
    sessionId,
    skillName: msg.skillName,
    author: msg.author,
  })
}


export const skillsHandlers = {
  list_skills: handleListSkills,
  skill_activate: handleSkillActivate,
  skill_deactivate: handleSkillDeactivate,
  skill_trust_accept: handleSkillTrustAccept,
  skill_trust_grant: handleSkillTrustGrant,
}
