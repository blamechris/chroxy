import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { resolve, relative, sep, isAbsolute } from 'node:path'
import { createLogger } from './logger.js'
// #6038: the SDK/TUI permission path broadcasts to clients too, so it must apply
// the same redaction as the hook path. Shared sanitizer + value redactor live in
// redaction.js (a leaf module — no import cycle / HTTP-handler weight).
import { sanitizeToolInput, redactValue } from './redaction.js'
import { redactMcpUrl, resolveTrustAddress } from './byok-mcp-config.js'
// #6842 review (Copilot) — audit entries must carry the store's NORMALIZED
// project key, not the raw session cwd, or a relative / `..`-laden cwd
// produces entries that never correlate with the persisted rule they audit.
// Import is cycle-safe: permission-rule-store.js imports our ELIGIBLE_TOOLS /
// NEVER_AUTO_ALLOW consts, but both modules only touch each other's exports
// inside function bodies (call time), never at module evaluation, and
// normalizeProjectKey is a hoisted function declaration.
import { normalizeProjectKey } from './permission-rule-store.js'

const _fallbackLog = createLogger('permission-manager')

// Tools that acceptEdits mode auto-approves. `apply_patch` is codex's file-edit
// approval (item/fileChange/requestApproval, #6605) — the codex analogue of
// Write/Edit, so acceptEdits auto-approves codex edits too.
const ACCEPT_EDITS_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'apply_patch'])

// Tools eligible for session-scoped auto-allow rules (`apply_patch` = codex edits).
export const ELIGIBLE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'apply_patch'])

// Tools that can never be auto-allowed by rules (too dangerous to whitelist).
// `shell` is codex's command-execution approval — the codex analogue of Bash, so
// arbitrary codex command execution can't be rule-whitelisted either (#6605).
// `request_permissions` is codex's sandbox-escalation approval (#6610) — broadening
// filesystem/network scope must always prompt, never be silently rule-whitelisted.
// `mcp_elicitation` is a codex MCP connector eliciting the user (#6635, e.g. a
// GitHub connector write approval) — a connector action must always prompt too.
export const NEVER_AUTO_ALLOW = new Set(['Bash', 'Task', 'WebFetch', 'WebSearch', 'shell', 'request_permissions', 'mcp_elicitation'])

// #6794 — hardcoded protected-path floor. Even under lenient settings (auto /
// acceptEdits / a broad `allow` rule) Chroxy must not SILENTLY auto-approve a
// path-carrying tool aimed at a repo-control / agent-config directory or a
// secret file. This mirrors Claude Code's own "always ask" floor (desktop
// parity): the target simply falls through to the interactive prompt instead
// of short-circuiting — a floor, never a hard deny.
//
// Protected DIRECTORY segment names, matched at any depth of the path the write
// RESOLVES into (see isProtectedPathValue for the relative-vs-absolute framing
// that keeps a session's own cwd from false-matching). `.config/git` (the XDG
// git-config dir) is a two-segment sequence handled separately, not a bare segment.
const PROTECTED_DIR_SEGMENTS = new Set(['.git', '.claude', '.vscode'])

// Tool-input fields that name a filesystem target. Presence of one is what
// makes a tool "path-carrying" for the floor (Write/Edit → file_path,
// NotebookEdit → notebook_path, Read/Glob/Grep → file_path/path). A tool with
// none of these (Bash, Task, WebFetch, WebSearch) cannot be floored here —
// command-shaped access is out of scope for a path floor.
const PROTECTED_PATH_INPUT_FIELDS = ['file_path', 'path', 'notebook_path']

// Default permission timeout (5 minutes)
const DEFAULT_TIMEOUT_MS = 300_000

// #6448 — resource-limit caps (DoS hardening). A normal session sits far below
// all of these; they only bite under a flood of requests or a malicious tool
// input, where the alternative is unbounded memory/CPU growth.
const MAX_PENDING_PERMISSIONS = 1000  // concurrent pending requests (each holds map entries + a timer)
const MAX_SESSION_RULES = 100         // session-scoped auto-allow rules
const MAX_RAW_DESCRIPTION_LEN = 8192  // raw tool field length fed to redactValue (far above the 200-char shown window)

/**
 * #6543 (IDE P3 feature B) — per-tool whitelist of the CONTENT field(s) a client
 * may substitute via `editedInput` on an `allow` (the per-hunk pre-write review).
 * ONLY these content fields can come from the client; the path/anchor fields
 * (`file_path`, `old_string`, `command`, …) are always taken from the ORIGINAL
 * input. So an operator can narrow/edit the shown content but can NEVER redirect
 * where the write lands or what runs. A tool absent from this map ignores
 * `editedInput` entirely (accept/reject-the-whole-tool). `old_string` is
 * deliberately NOT editable — it is the Edit's match anchor, not shown content.
 */
const EDITABLE_INPUT_FIELDS = {
  Write: ['content'],
  Edit: ['new_string'],
}

/**
 * Merge a client's `editedInput` into the agent's original tool input under the
 * strict {@link EDITABLE_INPUT_FIELDS} whitelist. Returns the original REFERENCE
 * when there's no editedInput, it isn't a plain object, or the tool isn't
 * editable; otherwise returns a shallow clone with only the whitelisted STRING
 * fields substituted (a non-string edited value is skipped, so the clone equals
 * the original by value). Never mutates the inputs. This is the load-bearing
 * "narrow-only, no path redirect" control for feature B — keep it dumb + auditable.
 *
 * @param {object} originalInput  the agent's proposed tool input
 * @param {*} editedInput         the client-supplied override (untrusted)
 * @param {string} toolName       the tool the permission is for
 * @returns {object}
 */
export function mergeEditedInput(originalInput, editedInput, toolName) {
  if (!editedInput || typeof editedInput !== 'object' || Array.isArray(editedInput)) return originalInput
  const allowed = EDITABLE_INPUT_FIELDS[toolName]
  if (!allowed) return originalInput
  const merged = { ...originalInput }
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(editedInput, field) && typeof editedInput[field] === 'string') {
      merged[field] = editedInput[field]
    }
  }
  return merged
}

/**
 * #6794 / #6806 — is a single path value protected, resolved against `base`?
 * `resolve()` absorbs absolute paths, a leading `./`, and `..` traversal, giving
 * the true target the write lands on.
 *
 * #6806 — WHICH segments we scan reconciles two goals that pull opposite ways:
 *   (1) floor any write that RESOLVES into a protected config dir/file,
 *       regardless of how `..` is arranged; and
 *   (2) preserve the #6794 worktree guard — a session whose OWN cwd lives under
 *       a real `.claude/` (the chroxy agent-worktree topology
 *       `…/.claude/worktrees/agent-*`) must still write its own workspace files,
 *       so cwd's own protected prefix segments must NOT false-floor it.
 * The discriminator is whether the resolved target stays INSIDE the session's
 * own workspace subtree (cwd):
 *   - UNDER cwd → scan the path RELATIVE to cwd, so cwd's own prefix segments
 *     (its `.claude`) are excluded and a benign in-workspace write is never
 *     floored (goal 2). Under-cwd relatives never contain `..`.
 *   - ESCAPES cwd (a `..`-traversal ABOVE it — itself suspicious) → scan the
 *     RESOLVED ABSOLUTE path, so a protected segment sitting in cwd's PREFIX
 *     (e.g. the very `.claude/` the worktree lives under, reached by
 *     `../../settings.local.json`) is caught (goal 1). A protected segment that
 *     appears BELOW the `..`s (an out-of-cwd `.git`) is caught either way. The
 *     floor only ever forces a PROMPT, so over-flooring a sibling traversal
 *     (which is already escaping the workspace) is safe and conservative.
 *
 * Segments are lowercased first: on case-insensitive filesystems (macOS APFS,
 * Windows) `.GIT/config` IS `.git/config`, so a case-sensitive match would let
 * case variants evade the floor. Over-flooring a genuinely distinct `.GIT` on
 * case-sensitive Linux is fine — the floor only forces a prompt, never denies.
 * @param {string} target  a path value from a tool input
 * @param {string} base    the resolution base (session cwd)
 * @returns {boolean}
 */
function isProtectedPathValue(target, base) {
  const resolved = resolve(base, target)
  const rel = relative(base, resolved)
  // Target is inside cwd's own subtree when the relative path neither is nor
  // begins with `..` (and isn't a foreign absolute — a Windows cross-drive
  // `relative()` can return one). Empty rel = the target IS cwd (still "inside").
  const underCwd = rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
  const scanned = underCwd ? rel : resolved
  const segments = scanned.split(sep)
    .filter((s) => s.length > 0 && s !== '..')
    .map((s) => s.toLowerCase())
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (PROTECTED_DIR_SEGMENTS.has(seg)) return true
    if (seg === '.env' || seg.startsWith('.env.')) return true
    if (seg === '.config' && segments[i + 1] === 'git') return true
  }
  return false
}

/**
 * #6794 — does this tool input target a protected path? Inspects EVERY present
 * {@link PROTECTED_PATH_INPUT_FIELDS} value (a benign `file_path` must not
 * shadow a protected `path`), resolves each against the session cwd (so
 * absolute paths, a leading `./`, and `..` traversal all normalize), then
 * tests the resolved path segment-by-segment. ANY protected field floors the
 * input. See {@link isProtectedPathValue} for the #6806 relative-vs-absolute
 * framing that decides which segments are scanned.
 *
 * #6805/#6828 — codex `apply_patch` carries its per-file targets in an ARRAY:
 * `input.changes` is `FileUpdateChange[] = { path, kind, diff }` (see
 * codex-app-server-session.js `_describeApproval`), with the top-level
 * `file_path` set to the approval's `grantRoot` — typically the benign repo
 * root. Scanning only the flat fields therefore let a member edit under
 * `.git/`/`.env*` escape the floor (and, with a persisted `{apply_patch,
 * allow}` rule from #6771, be durably auto-approved). Every array entry's
 * `path` is now checked with the same matcher — ANY protected member floors
 * the WHOLE request. A string-shaped `changes` (codex's legacy unified-diff
 * `item.patch` passthrough) carries no parseable paths and is skipped, same
 * as any other non-array field.
 *
 * A benign in-workspace write is never floored — a git worktree that itself
 * lives under a real `.claude/` dir writing to `packages/…` stays UNfloored
 * because a target under cwd is scanned relative to cwd (its own `.claude`
 * prefix excluded). But a `..`-traversal back UP into that same `.claude`
 * (`../../settings.local.json` → the real agent config) IS floored, because an
 * above-cwd target is scanned as its resolved ABSOLUTE path (#6806). See
 * {@link isProtectedPathValue} for the full reconciliation.
 *
 * Segment rules (a match on ANY segment floors the write; see
 * {@link isProtectedPathValue} for the lowercase rationale):
 *   - a segment in {@link PROTECTED_DIR_SEGMENTS} (`.git` / `.claude` / `.vscode`)
 *   - a `.config` segment immediately followed by `git` (the XDG git-config dir)
 *   - a segment that is `.env` or starts with `.env.` (`.env` / `.env.local` / …)
 *
 * Returns false for any missing / non-string path field, so a command-shaped
 * tool (Bash, WebFetch) is never floored. Pure + side-effect-free (string ops
 * only — no regex, so the `.env.*` match can't be mangled by later edits).
 *
 * @param {object} input  the tool input
 * @param {string} [cwd]  the session cwd (falls back to process.cwd())
 * @returns {boolean}
 */
export function isProtectedPathTarget(input, cwd) {
  if (!input || typeof input !== 'object') return false
  const base = (typeof cwd === 'string' && cwd.length > 0) ? cwd : process.cwd()
  for (const field of PROTECTED_PATH_INPUT_FIELDS) {
    if (typeof input[field] !== 'string' || input[field].length === 0) continue
    if (isProtectedPathValue(input[field], base)) return true
  }
  // #6805/#6828 — walk the array-shaped per-file targets (codex apply_patch).
  if (Array.isArray(input.changes)) {
    for (const change of input.changes) {
      if (!change || typeof change.path !== 'string' || change.path.length === 0) continue
      if (isProtectedPathValue(change.path, base)) return true
    }
  }
  return false
}

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
  constructor({ timeoutMs, log, maxPendingPermissions, cwd, ruleStore, mcpTrustLookup } = {}) {
    super()
    this._timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS
    this._log = log || console
    // #6834 — injectable DNS resolver for the MCP-trust prompt's resolved-address
    // display. Defaults to node:dns/promises lookup (via resolveTrustAddress)
    // when unset; tests pass a fake so they never touch real DNS.
    this._mcpTrustLookup = typeof mcpTrustLookup === 'function' ? mcpTrustLookup : null
    // #6448 — bound on concurrent pending permissions; injectable so the cap is
    // testable without minting 1000 real requests.
    this._maxPendingPermissions = maxPendingPermissions || MAX_PENDING_PERMISSIONS
    // #6794 — session cwd anchors the protected-path floor (see
    // isProtectedPathTarget). Optional: when unset the floor resolves targets
    // against process.cwd(), which still catches relative protected paths.
    this._cwd = (typeof cwd === 'string' && cwd.length > 0) ? cwd : null
    // #6771 — durable per-project rule store (PermissionRuleStore). Optional:
    // when present, an `allowAlways` decision persists a rule keyed by this
    // session's cwd, and this session seeds its persistent rules from the store
    // on construction (below) so a prior grant takes effect without re-prompting
    // after a daemon restart.
    this._ruleStore = ruleStore || null
    // #6830 (PR #6842 review) — direct audit callback for persisted-rule
    // auto-approves. Deliberately NOT an EventEmitter event: emitting
    // `permission_resolved` here would ride wirePermissionManager →
    // SessionManager → ws-forwarding → broadcastToSession, spamming every
    // subscribed client with a wire message per rule-matched tool call. The
    // sink is a plain function the WsServer wires straight into its
    // PermissionAuditLog (see ws-server.js _attachPermissionAuditSink), so
    // the signal stays in the audit lane only. Null until wired.
    this._auditSink = null

    this._pendingPermissions = new Map() // requestId -> { resolve, input }
    this._permissionTimers = new Map()   // requestId -> timer
    this._permissionCounter = 0
    // Per-instance (per-session) nonce so requestIds are globally unique
    // across sessions. Without it the id was `perm-${counter}-${ms}` with a
    // counter that restarts at 0 every session — two sessions could mint the
    // same id (same counter + same millisecond), and the parent-level
    // subagent routing table (byok-session.js) would then alias a parent's
    // own pending id against a child's (#5121). The counter is retained for
    // human-readable ordering in logs; global uniqueness comes from the
    // nonce. The id is opaque to all consumers — nothing parses its shape.
    // Full 128-bit UUID (dashes stripped so the nonce stays a single id
    // segment) — 32 bits would be birthday-bound vulnerable at scale.
    this._idNonce = randomUUID().replace(/-/g, '')
    this._lastPermissionData = new Map() // requestId -> emitted permission_request payload

    // Session-scoped permission rules
    this._sessionRules = [] // [{ tool, decision }]

    // #6771 — durable per-project rules seeded from the store for THIS
    // session's cwd. Kept SEPARATE from `_sessionRules` so `setRules`/
    // `clearRules` (the session-scoped `set_permission_rules` path, and the
    // clearRules() on a permission-mode switch) never wipe a project-level
    // "always allow", and vice-versa. `_matchesRule` consults both.
    this._persistentRules = (this._ruleStore && this._cwd)
      ? this._ruleStore.getRules(this._cwd)
      : []

    // AskUserQuestion handling
    this._pendingUserAnswer = null // { resolve, input, toolUseId } when waiting for user answer
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
    // #6448 — bound the session rules array (it is matched on every tool call).
    if (rules.length > MAX_SESSION_RULES) {
      throw new Error(`too many rules (max ${MAX_SESSION_RULES})`)
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
   * Clear all session-scoped permission rules. Persistent (project-scoped)
   * rules are UNTOUCHED — a mode switch or a `set_permission_rules []` must not
   * silently revoke a durable "always allow" (#6771).
   */
  clearRules() {
    this._sessionRules = []
  }

  /**
   * Return a copy of the durable (project-scoped) rules currently applied to
   * this session, each tagged `persist: 'project'` so a client can render them
   * distinctly from session rules (#6771).
   *
   * @returns {Array<{tool: string, decision: string, persist: 'project'}>}
   */
  getPersistentRules() {
    return this._persistentRules.map((r) => ({ tool: r.tool, decision: r.decision, persist: 'project' }))
  }

  /**
   * Replace this session's durable rule set in memory (does NOT persist —
   * callers that own the store persist separately). Used to re-seed after the
   * store changes out-of-band (e.g. a client edited the project's rules).
   *
   * @param {Array<{tool: string, decision: string}>} rules
   */
  setPersistentRules(rules) {
    this._persistentRules = Array.isArray(rules)
      ? rules
        .filter((r) => r && typeof r.tool === 'string' && (r.decision === 'allow' || r.decision === 'deny'))
        .map((r) => ({ tool: r.tool, decision: r.decision }))
      : []
  }

  /**
   * Check whether a toolName matches a session or persistent rule. Session
   * rules are consulted FIRST (a live, intentional session decision wins over a
   * standing project grant), then the durable project rules (#6771).
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
    for (const rule of this._persistentRules) {
      if (rule.tool === toolName) {
        return rule.decision
      }
    }
    return null
  }

  /**
   * #6830 — was the 'allow' decision _matchesRule just returned for `toolName`
   * SOURCED from a durable project-scoped rule (as opposed to a session rule)?
   * Mirrors _matchesRule's own precedence (session rules are checked first and
   * shadow a persistent rule for the same tool) WITHOUT changing _matchesRule's
   * tested return contract (a plain 'allow'|'deny'|null string, asserted
   * directly in permission-manager.test.js). Used only to decide whether a
   * silent auto-approve needs an audit-only signal (see
   * _auditPersistedRuleAutoApprove) — a session-rule-sourced allow is an
   * explicit, non-durable decision the user already made this session and
   * needs no extra trail beyond what's already logged for it.
   * @param {string} toolName
   * @returns {boolean}
   */
  _persistentRuleSourced(toolName) {
    if (this._sessionRules.some((r) => r.tool === toolName)) return false
    return this._persistentRules.some((r) => r.tool === toolName && r.decision === 'allow')
  }

  /**
   * #6830 (PR #6842 review) — install the direct audit callback for
   * persisted-rule auto-approves. Single-slot (last writer wins — one
   * WsServer audits at a time); pass null/non-function to detach.
   * `projectKey` arrives pre-NORMALIZED (normalizeProjectKey — the
   * PermissionRuleStore key), or null for an unkeyable cwd.
   * @param {null|((info: {tool: string, projectKey: string|null}) => void)} sink
   */
  setAuditSink(sink) {
    this._auditSink = typeof sink === 'function' ? sink : null
  }

  /**
   * #6830 — audit-only signal for a persisted (project-scoped) rule silently
   * auto-approving `toolName` with NO visible prompt: handlePermission
   * short-circuits BEFORE minting a requestId or emitting permission_request,
   * so without this the audit log has ZERO trace of the tool call — an
   * auditor querying permission history can't answer "why did tool X
   * auto-approve after a restart?" from the log alone.
   *
   * PR #6842 review — this must NOT emit `permission_resolved` (or any other
   * session event): permission_resolved is a broadcast-lane event
   * (session-manager.js builtinTransient → ws-forwarding →
   * broadcastToSession), so an emission here would send a wire message to
   * every subscribed client on EVERY rule-matched tool call, at machine
   * speed. Instead it calls the WsServer-wired `_auditSink` directly — the
   * audit lane only, coalesced ring-side by
   * PermissionAuditLog.logPersistedRuleApproval. Guarded so a sink bug can
   * never break tool approval; a no-op when no server has wired a sink.
   * @param {string} toolName
   */
  _auditPersistedRuleAutoApprove(toolName) {
    if (!this._auditSink) return
    try {
      // #6842 review (Copilot) — projectKey is the store's NORMALIZED key
      // (normalizeProjectKey, the same helper every PermissionRuleStore
      // read/write path uses), NOT the raw session cwd: a relative or
      // `..`-laden cwd would otherwise stamp entries an auditor can never
      // match against the persisted rule's key in permission-rules.json.
      this._auditSink({ tool: toolName, projectKey: normalizeProjectKey(this._cwd) })
    } catch (err) {
      this._logWarn(`Permission audit sink threw: ${err?.message || err}`)
    }
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
   * @param {PermissionUpdate[]} [suggestions] - Suggestions from the SDK
   *   canUseTool callback options — the pre-built permission rules to
   *   echo back via `updatedPermissions` when the user picks "allow
   *   always". Per the Agent SDK 'Always allow' flow, these are the
   *   correct shape of rule to persist for this tool in this session.
   * @returns {Promise<{behavior: string, updatedInput?: Object, message?: string, updatedPermissions?: Array}>}
   */
  handlePermission(toolName, input, signal, permissionMode, suggestions = undefined) {
    if (toolName === 'AskUserQuestion') {
      return this._handleAskUserQuestion(input, signal)
    }

    // #6794 — protected-path floor. A path-carrying tool aimed at a protected
    // path (.git/.claude/.vscode/.config/git/.env*) must NOT be silently
    // auto-approved by auto mode, a broad `allow` rule, or acceptEdits — mirror
    // Claude Code's "always ask" floor and let it fall through to the prompt.
    // This is a FLOOR, not a hard deny: a lenient mode simply stops
    // short-circuiting for these paths. A `deny` rule still denies (the floor
    // never widens access), and if the prompt path then auto-denies on
    // no-client/timeout, that is the existing fail-closed behavior.
    const protectedTarget = isProtectedPathTarget(input, this._cwd)

    // 'auto' (= SDK bypassPermissions) short-circuit: approve every tool
    // call without consulting rules or emitting a prompt. SdkSession also
    // skips canUseTool registration when starting a turn in auto mode, but
    // a turn that started in another mode keeps its callback alive for the
    // whole turn — without this guard, flipping to auto mid-turn (#3729)
    // still emits prompts because session rules and the prompt path run
    // before any mode check. #6794: the floor takes precedence — a protected
    // target still prompts even under auto.
    if (permissionMode === 'auto' && !protectedTarget) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input || {} })
    }

    // Session rules: check before acceptEdits and the prompt path. #6794: a
    // protected target skips the `allow` branch (fall through to the prompt);
    // a `deny` rule still denies.
    const ruleDecision = this._matchesRule(toolName)
    if (ruleDecision !== null && !(protectedTarget && ruleDecision === 'allow')) {
      this._logInfo(`Permission rule matched for ${toolName}: ${ruleDecision}`)
      if (ruleDecision === 'allow') {
        // #6830 — a durable project rule (not a session rule) just silently
        // auto-approved this tool call. Record it via the direct audit sink
        // (NOT an event — see _auditPersistedRuleAutoApprove) so the
        // permission audit log has a trace even though no prompt was shown.
        if (this._persistentRuleSourced(toolName)) {
          this._auditPersistedRuleAutoApprove(toolName)
        }
        return Promise.resolve({ behavior: 'allow', updatedInput: input || {} })
      }
      return Promise.resolve({ behavior: 'deny', message: 'Denied by session rule' })
    }

    // acceptEdits: auto-approve file operations, prompt for everything else.
    // #6794: the floor takes precedence — a protected target still prompts.
    if (permissionMode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(toolName) && !protectedTarget) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input || {} })
    }

    return new Promise((resolve) => {
      const requestId = `perm-${this._idNonce}-${++this._permissionCounter}-${Date.now()}`
      // #6448 — bound concurrent pending permissions (each holds entries in
      // _pendingPermissions / _permissionTimers / _lastPermissionData plus a
      // live timer). A normal session has 1-2 pending; this only trips under a
      // flood, where the incoming request is auto-denied rather than letting
      // those grow unbounded. The per-request timeout (below) sweeps stuck old
      // entries, so the cap + timeout together bound memory.
      if (this._pendingPermissions.size >= this._maxPendingPermissions) {
        this._logInfo(`Pending-permission cap (${this._maxPendingPermissions}) reached — auto-denying ${requestId}`)
        resolve({ behavior: 'deny', message: 'Too many pending permission requests' })
        return
      }
      this._pendingPermissions.set(requestId, {
        resolve,
        input: input || {},
        // Stashed for the allowAlways branch of respondToPermission so
        // we can echo them back as updatedPermissions per the SDK
        // 'Always allow' flow.
        suggestions: Array.isArray(suggestions) ? suggestions : [],
      })

      const toolInput = input || {}
      const rawDescription = toolInput.description
        || toolInput.command
        || toolInput.file_path
        || toolInput.pattern
        || toolInput.query
        || (Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput) : toolName)
      // #6038/#6048/#6049: build the broadcast description by REDACTING the full
      // string first, THEN truncating — truncating first (the old order) could
      // leave a secret straddling the cap as a sub-floor partial prefix that the
      // pattern scan misses. String() coerces a non-string field so a malformed
      // tool input can't crash the emit path (.replace on a non-string throws).
      // #6448 — cap the raw string BEFORE redaction so a malicious multi-MB tool
      // field can't make redactValue scan the whole thing (CPU DoS). The 8KB cap
      // is far above the 200-char shown window below, so it can never split a
      // SHOWN secret — the #6038 redact-then-truncate guarantee holds for
      // everything the client sees (anything past 8KB is sliced away regardless).
      const description = redactValue(String(rawDescription).slice(0, MAX_RAW_DESCRIPTION_LEN)).slice(0, 200)

      this._logInfo(`Permission request ${requestId}: ${toolName}`)

      // #6038: redact before broadcast. The raw input/description are kept for
      // execution via the _pendingPermissions entry above; this payload is
      // broadcast/display only, so a secret in a value (or the stringified
      // fallback description) must not reach subscribed clients.
      const permPayload = {
        requestId,
        tool: toolName,
        description,
        input: sanitizeToolInput(toolInput),
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
            this.emit('permission_resolved', { requestId, decision: 'deny', reason: 'aborted' })
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
          this.emit('permission_resolved', { requestId, decision: 'deny', reason: 'timeout' })
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
      const toolUseId = `ask-${this._idNonce}-${++this._permissionCounter}-${Date.now()}`
      // #3975: stash toolUseId on the pending entry so clearAll() can
      // emit it on the cleared-variant permission_resolved. Without
      // toolUseId the sdk-session re-emit gate at sdk-session.js:281
      // drops the event and the unified pipeline never prunes the
      // questionSessionMap entry — small leak (~80 bytes) per
      // message-completion-while-question-pending event, bounded only by
      // session_destroyed cleanup.
      this._pendingUserAnswer = { resolve, input: questionInput, toolUseId }
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
            this.emit('permission_resolved', { toolUseId, reason: 'aborted' })
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
          this.emit('permission_resolved', { toolUseId, reason: 'timeout' })
        }
      }, this._timeoutMs)
    })
  }

  /**
   * Resolve a pending permission request.
   *
   * @param {string} requestId - The permission request ID
   * @param {string} decision - 'allow', 'deny', or 'allowAlways'
   * @returns {boolean} true if a pending permission was found and resolved,
   *   false if the requestId was unknown (already resolved or expired).
   */
  respondToPermission(requestId, decision, editedInput) {
    const pending = this._pendingPermissions.get(requestId)
    if (!pending) {
      this._logWarn(`No pending permission for ${requestId}`)
      return false
    }
    // #6543: capture the tool name BEFORE deleting the last-permission data, so
    // the editedInput whitelist knows which content field(s) are substitutable.
    const toolName = this._lastPermissionData.get(requestId)?.tool
    this._pendingPermissions.delete(requestId)
    this._lastPermissionData.delete(requestId)
    this._clearPermissionTimer(requestId)

    this._logInfo(`Permission ${requestId} resolved: ${decision}`)

    // Emit before resolve() so listeners see the pending-count drop
    // before any follow-on work runs synchronously.
    this.emit('permission_resolved', { requestId, decision, reason: 'user' })

    // #6543 (feature B): on an approve, an operator who reviewed the proposed
    // Write/Edit per-hunk may substitute the CONTENT (never the path — see
    // mergeEditedInput). Ignored on deny. The merged input flows to the agent's
    // tool executor as `updatedInput`, which still path-confines the write.
    const approvedInput = mergeEditedInput(pending.input, editedInput, toolName)

    if (decision === 'allow') {
      pending.resolve({ behavior: 'allow', updatedInput: approvedInput })
    } else if (decision === 'allowAlways') {
      // Per the Agent SDK type contract (PermissionResult in
      // @anthropic-ai/claude-agent-sdk coreTypes.d.ts), behavior is
      // strictly 'allow' | 'deny' — there is NO 'allowAlways' variant.
      // The "always allow" flow works by returning behavior='allow'
      // AND attaching a list of permission rules to persist via
      // updatedPermissions (which the SDK sources from the `suggestions`
      // field of the canUseTool callback options, stashed on pending
      // at capture time).
      //
      // Pre-audit, we passed behavior:'allowAlways' directly to the SDK
      // callback, which the SDK silently coerced (or dropped) — the
      // user-facing "Allow Always" button effectively did nothing more
      // than a plain "Allow", and no persistent rule was added. Found
      // by Skeptic in the 2026-04-11 production readiness audit.
      const result = {
        behavior: 'allow',
        updatedInput: approvedInput,
      }
      if (pending.suggestions && pending.suggestions.length > 0) {
        result.updatedPermissions = pending.suggestions
      }
      // #6771 — persist a DURABLE project-scoped rule so this grant survives a
      // daemon restart (the SDK `updatedPermissions` above only persists within
      // the SDK's own session). Only for rule-eligible tools: the store rejects
      // NEVER_AUTO_ALLOW / non-ELIGIBLE tools, so an `allowAlways` on Bash (or a
      // codex `shell`) degrades to a one-shot allow and is NEVER durably
      // whitelisted. Seed the in-memory persistent set too so the very next tool
      // call in THIS session auto-allows without re-prompting.
      if (toolName && this._ruleStore && this._cwd) {
        const persisted = this._ruleStore.addRule(this._cwd, { tool: toolName, decision: 'allow' })
        if (persisted) {
          // Re-seed the in-memory set so the very next tool call in THIS session
          // auto-allows. The client-facing `permission_rules_updated` broadcast
          // is emitted by the WS response handler (settings-handlers.js) after
          // this resolves — getPersistentRules() reflects the update synchronously.
          this.setPersistentRules(this._ruleStore.getRules(this._cwd))
        }
      }
      pending.resolve(result)
    } else {
      pending.resolve({ behavior: 'deny', message: 'User denied' })
    }
    return true
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
    // #3988: include toolUseId on the answered emit for symmetry with the
    // other 3 question-variant emit sites (aborted/timeout/cleared). The
    // 'auto' path applies only to requestId-based prompts —
    // autoAllowPending() leaves AskUserQuestion entries untouched — so
    // there is no auto-variant question emit to mirror.
    //
    // The user-response handler at packages/server/src/handlers/input-handlers.js:451
    // already prunes questionSessionMap eagerly before calling this method,
    // so the unified-pipeline cleanup is redundant on the happy path — but
    // the sdk-session re-emit gate at sdk-session.js:281 keys on
    // (data.requestId || data.toolUseId), and any future internal path
    // (or refactor that drops the eager delete) would silently leak. Read
    // toolUseId BEFORE the null-out below, mirroring the clearAll #3975
    // pattern.
    const { resolve, input, toolUseId } = this._pendingUserAnswer
    this._pendingUserAnswer = null
    this._waitingForAnswer = false

    this._logInfo(`Question response received: "${text.slice(0, 60)}"`)

    // Emit before resolve() so listeners (e.g. the SdkSession
    // inactivity-timer resumer, #2831) see the state flip before any
    // downstream synchronous work runs.
    this.emit('permission_resolved', { toolUseId, reason: 'answered' })

    // Build structured answers map: SDK expects { [questionText]: selectedLabel }.
    // Per @anthropic-ai/claude-agent-sdk sdk-tools.d.ts (AskUserQuestionOutput.answers,
    // ~line 2696) the contract is explicit: each value is a plain string,
    // and multi-select answers are comma-separated. So this layer
    // normalizes the dashboard's wire shape (native string | string[] post-
    // #4731, or legacy JSON-stringified arrays from #4604 Chunk B
    // dashboards) into that canonical string-per-question shape before
    // resolving the canUseTool Promise — otherwise the model would receive
    // raw JSON literals like '["A","B"]' as the user's answer text (#4731).
    const answers = {}
    const questions = input.questions || []
    const questionKeys = new Set(questions.map(q => q.question))
    if (answersMap && typeof answersMap === 'object' && Object.keys(answersMap).length > 0) {
      // Per-question answers provided by the client — only copy known question keys
      for (const key of Object.keys(answersMap)) {
        if (questionKeys.has(key)) {
          answers[key] = normalizeAnswerValue(answersMap[key])
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
   * Auto-allow every outstanding permission request. Called when the
   * session switches into auto/bypass mode (#3729) — the user has just
   * declared "approve everything", so any prompt still on screen should
   * resolve as if they had clicked Allow rather than sit there until
   * timeout. Pending AskUserQuestion prompts are NOT touched: those are
   * solicited user input, not permission gates.
   *
   * #4462: MCP trust prompts (requestMcpTrust) are also exempt — their
   * allow path PERSISTS the binary to ~/.chroxy/mcp-trust.json forever
   * via byok-mcp-fleet's recordTrust call. A panic-button bypass is "I
   * trust everything for this turn" semantics, NOT "trust this MCP
   * binary forever." Treating mcp_spawn under auto as deny re-prompts
   * the user next start — they can explicitly approve then, when the
   * decision is in front of them.
   */
  autoAllowPending() {
    if (this._pendingPermissions.size === 0) return
    const pendingIds = Array.from(this._pendingPermissions.keys())
    let allowed = 0
    let deniedMcpTrust = 0
    for (const requestId of pendingIds) {
      const pending = this._pendingPermissions.get(requestId)
      if (!pending) continue
      this._pendingPermissions.delete(requestId)
      this._lastPermissionData.delete(requestId)
      this._clearPermissionTimer(requestId)
      if (pending.mcpTrust === true) {
        // Don't silently persist trust on bypass. Deny — the MCP server
        // won't spawn for this session, but no on-disk trust entry is
        // written, and the user re-prompts next start.
        pending.resolve({
          behavior: 'deny',
          message: 'MCP trust not persisted via auto-mode bypass; approve explicitly to trust this server',
        })
        this.emit('permission_resolved', { requestId, decision: 'deny', reason: 'auto_mode_mcp_trust_bypass' })
        deniedMcpTrust += 1
        continue
      }
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
      this.emit('permission_resolved', { requestId, decision: 'allow', reason: 'auto_mode' })
      allowed += 1
    }
    if (deniedMcpTrust > 0) {
      this._logInfo(
        `Auto-allowed ${allowed} pending permission(s) and denied ${deniedMcpTrust} MCP trust prompt(s) on auto mode switch (trust not persisted via bypass — #4462)`,
      )
    } else {
      this._logInfo(`Auto-allowed ${allowed} pending permission(s) on auto mode switch`)
    }
  }

  /**
   * Auto-deny all pending permissions and questions. Called on message
   * completion or session destruction.
   */
  clearAll() {
    // Collect requestIds first so we can emit permission_resolved AFTER
    // the maps are cleared — the SdkSession timeout-pause listener decrements
    // its counter on each event and should see a consistent final state.
    const pendingIds = Array.from(this._pendingPermissions.keys())
    // #3975: capture the pending-answer entry (not just a boolean) so we
    // can include its toolUseId on the cleared emit. Without toolUseId the
    // sdk-session re-emit gate drops the event and questionSessionMap
    // leaks. Reading toolUseId BEFORE the null-out below avoids races
    // with any synchronous listeners on the resolve.
    const clearedUserAnswer = this._pendingUserAnswer

    // Auto-deny pending permissions and clear timers
    for (const [requestId, pending] of this._pendingPermissions) {
      this._clearPermissionTimer(requestId)
      pending.resolve({ behavior: 'deny', message: 'Message completed' })
    }
    this._pendingPermissions.clear()
    this._lastPermissionData.clear()

    // #6027: belt-and-braces — the loop above only clears timers for entries
    // still in _pendingPermissions. A permission timer whose requestId has
    // already left that map would otherwise survive destroy() and keep the
    // suite alive without --test-force-exit. Drop any stragglers.
    for (const timer of this._permissionTimers.values()) clearTimeout(timer)
    this._permissionTimers.clear()

    // Auto-deny pending user answer
    this._clearQuestionTimer()
    if (this._pendingUserAnswer) {
      this._pendingUserAnswer.resolve({ behavior: 'deny', message: 'Message completed' })
      this._pendingUserAnswer = null
    }
    this._waitingForAnswer = false

    // Emit resolved events so listeners reset any paused state (#2831).
    for (const requestId of pendingIds) {
      this.emit('permission_resolved', { requestId, decision: 'deny', reason: 'cleared' })
    }
    if (clearedUserAnswer) {
      // #3975: toolUseId is required for the EventNormalizer to prune
      // questionSessionMap on the cleared path. The SdkSession
      // timeout-pause listener (#2831) ignores fields it doesn't know
      // about, so the extra toolUseId is harmless there.
      this.emit('permission_resolved', { toolUseId: clearedUserAnswer.toolUseId, reason: 'cleared' })
    }
  }

  /**
   * #4457: trust gate for spawning an MCP server child. Reuses the
   * existing _pendingPermissions machinery so the dashboard / mobile
   * permission UIs render this with zero changes — they receive a
   * standard `permission_request` event and call `respondToPermission`
   * with allow/deny.
   *
   * Behavior:
   *  - On allow (or allowAlways): resolves to true; caller persists trust.
   *  - On deny: resolves to false; caller marks the client DEAD.
   *  - On timeout (default permissionTimeout): treated as deny.
   *
   * #6821: also handles REMOTE (streamable-HTTP / SSE) servers, which carry a
   * `url` + `headerKeys` instead of `command`/`args`/`envKeys`. The url is
   * credential-stripped (via redactMcpUrl) before it reaches the description
   * or the broadcast input; header VALUES are never passed in.
   *
   * @param {{ name: string, command?: string, args?: string[], envKeys?: string[], url?: string, headerKeys?: string[] }} server
   * @returns {Promise<boolean>}
   */
  async requestMcpTrust(server) {
    const isRemote = typeof server.url === 'string' && server.url.length > 0
    const safeUrl = isRemote ? redactMcpUrl(server.url) : ''
    // #6834 — for a REMOTE server, best-effort-resolve the host BEFORE we build
    // the prompt so the consent string can show when a "remote" URL actually
    // points at a loopback / private / internal address (owner decision:
    // display, never block beyond the existing cloud-metadata hard-block).
    // Resolution is non-fatal — resolveTrustAddress returns a 'could not
    // resolve host' record on any failure and never throws. Only the hostname
    // is read (from the already-redacted url); only IPs come back. The stdio
    // path has no url, so no await runs and its prompt still emits synchronously
    // (autoAllowPending / pending-size assertions depend on that).
    const resolved = isRemote
      ? await resolveTrustAddress(safeUrl, { lookup: this._mcpTrustLookup || undefined })
      : null
    return new Promise((resolve) => {
      const requestId = `mcp-trust-${this._idNonce}-${++this._permissionCounter}-${Date.now()}`
      const argv0 = Array.isArray(server.args) && server.args.length > 0 ? server.args[0] : ''
      const input = {
        mcpServer: isRemote
          ? {
              name: server.name,
              url: safeUrl,
              headerKeys: Array.isArray(server.headerKeys) ? [...server.headerKeys] : [],
              // Structured mirror of the resolved-address marker embedded in
              // `description`. Plain strings/arrays/bools — survives
              // sanitizeToolInput untouched — so a client that renders MCP-trust
              // input structurally can surface it without re-parsing the string.
              resolvedAddress: resolved
                ? {
                    resolved: resolved.resolved,
                    addresses: resolved.addresses,
                    classification: resolved.classification,
                    display: resolved.display,
                  }
                : null,
            }
          : {
              name: server.name,
              command: server.command,
              args: Array.isArray(server.args) ? [...server.args] : [],
              envKeys: Array.isArray(server.envKeys) ? [...server.envKeys] : [],
            },
      }
      const description = isRemote
        ? `Connect to MCP server "${server.name}" at ${safeUrl}${resolved ? ` — ${resolved.display}` : ''}`
        : `Spawn MCP server "${server.name}" running ${server.command}${argv0 ? ' ' + argv0 : ''}`

      // Wrap pending entry so respondToPermission's standard mapping
      // ({behavior:'allow'} or {behavior:'deny'}) translates to a boolean
      // for the caller. updatedInput / suggestions are unused on the trust
      // path — we only care about allow-vs-deny.
      //
      // #4462: mark this entry as an MCP-trust prompt so autoAllowPending
      // can treat it differently. Auto-allow is the "panic button"
      // bypass — it's the right call for one-shot Read/Bash/Edit prompts
      // (the user just declared "approve everything") but the WRONG call
      // for MCP trust, which persists forever via recordTrust on allow.
      // The persistence semantics turn a bypass into a "trust this binary
      // forever" decision the user never explicitly made. We tag the
      // entry and have autoAllowPending deny it instead.
      this._pendingPermissions.set(requestId, {
        resolve: (result) => resolve(result?.behavior === 'allow'),
        input,
        suggestions: [],
        mcpTrust: true,
      })

      this._logInfo(`MCP trust request ${requestId}: ${server.name}`)

      // #6038: redact before broadcast (description embeds server.command/argv0;
      // input carries args/envKeys). Raw values for execution live on the
      // _pendingPermissions entry above.
      const permPayload = {
        requestId,
        tool: 'mcp_spawn',
        description: redactValue(String(description)).slice(0, 200),
        input: sanitizeToolInput(input),
        remainingMs: this._timeoutMs,
        createdAt: Date.now(),
      }
      this._lastPermissionData.set(requestId, permPayload)
      this.emit('permission_request', permPayload)

      const timer = setTimeout(() => {
        this._permissionTimers.delete(requestId)
        if (this._pendingPermissions.has(requestId)) {
          this._logInfo(`MCP trust ${requestId} timed out, auto-denying`)
          this._pendingPermissions.delete(requestId)
          this._lastPermissionData.delete(requestId)
          resolve(false)
          this.emit('permission_resolved', { requestId, decision: 'deny', reason: 'timeout' })
        }
      }, this._timeoutMs)
      this._permissionTimers.set(requestId, timer)
    })
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
      _fallbackLog.info(msg)
    }
  }

  /** @private */
  _logWarn(msg) {
    if (this._log.warn) {
      this._log.warn(msg)
    } else {
      _fallbackLog.warn(msg)
    }
  }
}

/**
 * #4731 — coerce a dashboard-supplied per-question answer value into the
 * SDK's canonical string shape. The SDK's `AskUserQuestionOutput.answers`
 * (see `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:2696`) types every
 * value as a plain string with multi-select answers comma-separated.
 *
 * Accepted inputs:
 *   - Array of labels (post-#4731 wire shape from updated dashboards) →
 *     joined as `"A, B, C"`.
 *   - JSON-stringified array (`'["A","B"]'` — the legacy #4604 Chunk B
 *     dashboard JSON.stringifies multi-select arrays to fit the original
 *     `Record<string,string>` schema) → parsed then joined.
 *   - Plain string (single-select, freeform, or model-side "Other"
 *     sentinel) → passed through unchanged.
 *
 * Anything else (null, undefined, object, number) coerces to the empty
 * string — the SDK then receives a null-equivalent answer and the model
 * surfaces "no preference" semantics, which is safer than throwing and
 * stalling the canUseTool Promise.
 */
function normalizeAnswerValue(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? '')).join(', ')
  }
  if (typeof value === 'string') {
    // Detect the legacy JSON-stringified-array shape. Bare strings (e.g.
    // `"Red"`) never look like JSON arrays, so this gate is tight enough
    // that no plain-string answer is accidentally parsed. The try/catch
    // means a string that merely starts with `[` but isn't valid JSON
    // (e.g. someone literally answered `"[note]"`) falls through to the
    // pass-through return below — no data loss.
    if (value.length >= 2 && value.startsWith('[') && value.endsWith(']')) {
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed)) {
          return parsed.map((v) => String(v ?? '')).join(', ')
        }
      } catch {
        // not JSON — fall through
      }
    }
    return value
  }
  return ''
}

/**
 * Wire a PermissionManager's three events to a session's own EventEmitter and
 * install the back-compat accessors (`_pendingPermissions` / `_lastPermissionData`,
 * read by ws-permissions.js + settings-handlers.js). Extracted from the two
 * in-process providers (SdkSession, ByokSession) that each hand-rolled the same
 * wiring (audit P2-9); Docker variants inherit from these.
 *
 * The only real asymmetry is SdkSession's inactivity-timer pause/resume around a
 * pending permission (#2831) — passed as optional `onRequest` (fired on both
 * permission_request and user_question, before the re-emit) and `onResolved`
 * (fired on every permission_resolved, before the requestId/toolUseId re-emit
 * guard). ByokSession passes neither.
 *
 * @param {import('events').EventEmitter} session  the session to re-emit on
 * @param {PermissionManager} permissions
 * @param {{ onRequest?: () => void, onResolved?: () => void }} [hooks]
 */
export function wirePermissionManager(session, permissions, { onRequest, onResolved } = {}) {
  permissions.on('permission_request', (data) => {
    if (onRequest) onRequest()
    session.emit('permission_request', data)
  })
  permissions.on('user_question', (data) => {
    if (onRequest) onRequest()
    session.emit('user_question', data)
  })
  permissions.on('permission_resolved', (data) => {
    if (onResolved) onResolved()
    // #3048: re-emit so the unified pipeline (SessionManager → ws-forwarding →
    // EventNormalizer → broadcast) fans the resolution out to every client.
    // #3736: AskUserQuestion resolutions carry `toolUseId` instead of
    // `requestId` — re-emit both shapes so the EventNormalizer can prune the
    // questionSessionMap entry (pre-fix this branch was dropped and the map
    // leaked one entry per timeout/abort/clear). The permission-audit listener
    // in ws-server.js gates on `data.requestId` and ignores the question variant.
    if (data && (data.requestId || data.toolUseId)) {
      session.emit('permission_resolved', data)
    }
  })
  // Backward-compatible accessors used by ws-permissions.js + settings-handlers.js.
  session._pendingPermissions = permissions._pendingPermissions
  session._lastPermissionData = permissions._lastPermissionData
  // #6830 (PR #6842 review) — public delegate so the WsServer can wire its
  // PermissionAuditLog straight into this manager's persisted-rule audit path
  // (ws-server.js _attachPermissionAuditSink) without reaching into privates.
  // Installed for every wirePermissionManager provider (sdk / byok / codex).
  session.setPermissionAuditSink = (sink) => permissions.setAuditSink(sink)
}
