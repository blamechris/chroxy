import { JsonlSubprocessSession } from './jsonl-subprocess-session.js'
import { buildBaseSessionOpts } from './base-session.js'
import { homedir } from 'os'
import { join } from 'path'
import { resolveBinary } from './utils/resolve-binary.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import {
  CONTEXT_WINDOW_HEADROOM,
  getRatchetCap,
  maybeRatchetContextWindow,
} from './utils/context-window-learn.js'
import { BILLING_CLASSES } from './billing-class.js'
import { hasCodexOAuthCreds } from './auth-probes.js'
import {
  CODEX_SANDBOX_MODES as PROTOCOL_CODEX_SANDBOX_MODES,
  CODEX_DEFAULT_SANDBOX as PROTOCOL_CODEX_DEFAULT_SANDBOX,
} from '@chroxy/protocol'

/**
 * Manages a Codex CLI session using `codex exec --json`.
 *
 * Implements the same EventEmitter interface as SdkSession/CliSession so
 * SessionManager and WsServer work identically regardless of provider.
 *
 * Codex CLI outputs JSONL events via --json flag:
 *   thread.started  { thread_id }
 *   turn.started    {}
 *   item.completed  { item: { id, type, text, ... } }
 *   turn.completed  { usage: { input_tokens, output_tokens, cached_input_tokens } }
 *
 * Events emitted (standard provider contract):
 *   ready        { model }
 *   stream_start { messageId }
 *   stream_delta { messageId, delta }
 *   stream_end   { messageId }
 *   tool_start   { messageId, toolUseId, tool, input }
 *   tool_result  { toolUseId, result }
 *   result       { cost, duration, usage, sessionId }
 *   error        { message }
 */

/**
 * No default model is hard-coded here.
 *
 * Previously this module shipped `DEFAULT_MODEL = 'gpt-5.4'`, which pinned
 * the server to a specific Codex release and caused `codex exec -c model=...`
 * to fail whenever that version wasn't available on the host. Instead we now
 * pass `null` through to `BaseSession` when no model is supplied, and
 * `buildCodexArgs()` below omits the `-c model=...` override so Codex CLI
 * falls back to whatever default is configured in `~/.codex/config.toml`.
 */
const DEFAULT_MODEL = null

// Resolve the codex binary once at module load. Under a GUI launch
// (e.g. Tauri on macOS) PATH is minimal and may exclude the user's
// install dir — fall through to known locations so `spawn()` succeeds.
// Covers curl|sh installers (~/.local/bin) and `npm install -g` without
// sudo (~/.npm-global/bin).
const BINARY_CANDIDATES = [
  join(homedir(), '.local/bin/codex'),
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/usr/bin/codex',
  join(homedir(), '.npm-global/bin/codex'),
]

// NOTE: the codex binary is intentionally NOT cached in a module-load const.
// A frozen path is spawned even after XProtect/Gatekeeper quarantines or moves
// the binary out from under a long-running daemon (#6708 defect #3). The
// `resolvedBinary` getter re-resolves fresh per access instead.

/**
 * Codex CLI sandbox modes. Source: `codex exec --sandbox <MODE>` accepts
 * exactly these three values (verified against codex-cli 0.128.0). Exported
 * so tests and consumers can pin the canonical list without re-declaring it.
 */
// #6689: single-sourced from @chroxy/protocol (the wire contract) so the
// server, the create_session schema, and both client selectors share exactly
// one list. Frozen re-export preserves the pre-#6689 API for the server
// consumers that already `import { CODEX_SANDBOX_MODES } from './codex-session.js'`.
export const CODEX_SANDBOX_MODES = Object.freeze([...PROTOCOL_CODEX_SANDBOX_MODES])

/**
 * Default sandbox mode when nothing overrides it. Matches the #3846 stopgap
 * — Codex would otherwise fall back to read-only in any non-trusted dir and
 * be unable to edit files in fresh chroxy sessions.
 */
export const CODEX_DEFAULT_SANDBOX = PROTOCOL_CODEX_DEFAULT_SANDBOX

/**
 * Module-level cache of invalid `CHROXY_CODEX_SANDBOX` values we have
 * already warned about (#3981). Because `resolveCodexSandbox()` runs on
 * every `sendMessage()`, a single typo in an operator's environment would
 * otherwise spam `console.warn` for every turn of every session for the
 * lifetime of the server. We still want loud-on-first-call so the typo is
 * discoverable, but bounded volume after that — one log line per distinct
 * bad value per process.
 *
 * Keyed by the trimmed raw string so a later typo-correction to a *different*
 * invalid value still surfaces. Never cleared; the set is bounded by the
 * number of distinct invalid values an operator types, which in practice is
 * 1 or 2.
 */
const _warnedSandboxValues = new Set()

/**
 * Resolve the Codex sandbox mode from the environment (#3847).
 *
 * Operators may pin a non-default sandbox without source edits by setting
 * `CHROXY_CODEX_SANDBOX` to one of {@link CODEX_SANDBOX_MODES}. Unknown values
 * log a warning (once per distinct value per process — see #3981) and fall
 * back to {@link CODEX_DEFAULT_SANDBOX} — refusing to start the whole server
 * would be the wrong failure mode for a stopgap env knob, and a silent
 * fall-through would hide typos.
 *
 * Read at call time (not module-load time) so the override responds to test
 * harnesses, hot reload, and in-process env changes.
 *
 * #6638: a per-session `override` (from create_session `codexSandbox`) wins over
 * the env when it is a valid mode — so a session can pick read-only / full-access
 * without changing the server-wide env. An invalid override is ignored and the
 * env → default resolution proceeds (the schema already gates the wire value, so
 * this only bites an internal caller passing garbage).
 *
 * @param {string} [override] - per-session sandbox mode, wins over the env if valid
 * @returns {'read-only'|'workspace-write'|'danger-full-access'}
 */
export function resolveCodexSandbox(override) {
  if (typeof override === 'string' && CODEX_SANDBOX_MODES.includes(override.trim())) {
    return override.trim()
  }
  const raw = process.env.CHROXY_CODEX_SANDBOX
  if (typeof raw !== 'string' || raw.length === 0) return CODEX_DEFAULT_SANDBOX
  const trimmed = raw.trim()
  if (trimmed.length === 0) return CODEX_DEFAULT_SANDBOX
  if (CODEX_SANDBOX_MODES.includes(trimmed)) return trimmed
  // Case-sensitive match — Codex CLI is case-sensitive on these values, so
  // silently coercing `Read-Only` would mask a typo that would have failed
  // loudly downstream.
  if (!_warnedSandboxValues.has(trimmed)) {
    _warnedSandboxValues.add(trimmed)
    console.warn(
      `[codex] CHROXY_CODEX_SANDBOX="${trimmed}" is not a valid sandbox mode `
      + `(expected one of: ${CODEX_SANDBOX_MODES.join(', ')}); `
      + `falling back to ${CODEX_DEFAULT_SANDBOX}`,
    )
  }
  return CODEX_DEFAULT_SANDBOX
}

/**
 * Build the argv passed to `codex exec`. Exported for unit testing.
 *
 * `--skip-git-repo-check` is always passed: chroxy owns its own session-trust
 * gate, and Codex's git-repo heuristic refuses non-git directories outright
 * with a bare `exit 1`, which surfaced as an undiagnosable error in the UI
 * (#3834).
 *
 * REVISIT (#3840): if chroxy ever grows a directory-trust prompt (i.e. a
 * per-cwd "you've never opened this directory before, allow?" confirmation
 * driven by chroxy's UX, distinct from the skills-content `trustStore` in
 * `base-session.js`), gate this flag on that confirmation — pass it for
 * trusted cwds, omit it for untrusted ones so Codex's own git-repo heuristic
 * adds a second line of defense. Until that UX lands, always-on is correct
 * because the user picking a cwd in chroxy IS today's trust signal.
 *
 * `--sandbox <mode>` is always passed (#3837 stopgap): without it Codex
 * falls back to `read-only` in any directory that isn't explicitly listed
 * under `[projects."…"]` with `trust_level = "trusted"` in
 * `~/.codex/config.toml`, which makes Codex unable to write files in
 * fresh chroxy sessions and looks like a chroxy bug. The user picking
 * a directory in chroxy IS the trust signal, so `workspace-write` is the
 * right default. Operators may override the default via the
 * `CHROXY_CODEX_SANDBOX` env var (#3847) — e.g. on a multi-tenant host
 * where Codex should start `read-only` until the user opts in. A
 * per-session sandbox selector is tracked separately under #3837.
 *
 * SECURITY INVARIANT (#3843, #3869): `text`, `model`, and `threadId` are
 * interpolated into argv passed directly to `spawn()` — no shell, so shell
 * metacharacters can't escape.
 *
 * - `model` is interpolated into `-c model="${model}"` *without* re-validation
 *   here. **Callers MUST pre-validate the model ID against
 *   `CodexSession.getAllowedModels()` before calling.** The production gate is
 *   `handleSetModel` in `handlers/settings-handlers.js`, which rejects any
 *   value not in the per-provider allowlist before `session.setModel()`
 *   writes to `this.model`.
 *
 * - `threadId` (#3865) is **trusted because it comes from Codex CLI's own
 *   `thread.started` JSONL stdout** — captured in `_processJsonlLine`, never
 *   from user input. If a future caller wires this to a different source
 *   (e.g. a user-supplied resume input from the dashboard), validate it as a
 *   UUID first. Note that `codex exec resume <id>` silently falls back to a
 *   *new* thread when the id is malformed or unknown rather than erroring —
 *   so a "resume isn't resuming" bug report likely means the threadId path
 *   is wrong, not that the CLI rejected the value.
 *
 * If a future refactor exposes `buildCodexArgs` to a new caller (e.g. an
 * alternate spawn path), preserve these invariants or add validation here.
 *
 * @param {string} text   User prompt
 * @param {string|null} model  Optional model ID. Caller must validate against
 *                              `CodexSession.getAllowedModels()`. If falsy,
 *                              no `-c model=` flag is appended — Codex CLI
 *                              uses its own default.
 * @param {string|null} threadId  Optional Codex thread_id captured from a
 *                                 previous turn's `thread.started` event.
 *                                 When set, switches to `exec resume <id>`
 *                                 form so the CLI replays prior conversation
 *                                 state instead of treating each message as
 *                                 a fresh thread (#3865).
 * @param {string} [sandboxOverride]  #6638 — per-session sandbox mode; wins over
 *                                 the CHROXY_CODEX_SANDBOX env / default if valid.
 * @returns {string[]}
 */
export function buildCodexArgs(text, model, threadId = null, sandboxOverride = undefined) {
  // INVARIANT: --sandbox must be passed to the parent `exec`, not to the
  // `resume` subcommand. `codex exec resume --sandbox ...` errors out with
  // `unexpected argument '--sandbox' found` (verified against codex-cli
  // 0.128.0) because --sandbox is only declared on the parent `exec` command.
  // Keep --sandbox BEFORE the `resume` subcommand on the resume path.
  const sandbox = resolveCodexSandbox(sandboxOverride)
  const args = threadId
    ? ['exec', '--sandbox', sandbox, 'resume', threadId, text, '--json', '--skip-git-repo-check']
    : ['exec', text, '--json', '--skip-git-repo-check', '--sandbox', sandbox]
  if (model) {
    args.push('-c', `model="${model}"`)
  }
  return args
}

// Per-provider model metadata — #2956.
// Source of truth for `set_model` validation, fallback model list, and
// per-model context window/label surfaced in the dashboard dropdown. Keep
// this list small and explicit until Codex CLI grows a native
// `supportedModels()` equivalent.
//
// Context-window values come from the OpenAI model docs; `contextWindow` is
// used both in the token-usage HUD and as the Codex-side override for the
// generic 200k default shipped by `models.js`.
//
// #3857: gpt-5 / gpt-5-codex bumped from 272k → 400k. The 272k value was an
// internal pre-launch limit that was never updated when OpenAI shipped the
// public 400k Codex window — surfaced as a permanent 100% footer meter at
// ~321k tokens even though Codex kept responding coherently (issue #3857,
// also captured upstream in openai/codex#19319 + community.openai.com:
// "Input tokens exceed the configured limit of 272,000 tokens"). The runtime
// learn-loop in `_processJsonlLine` ratchets these upward when the SDK
// reports an `input_tokens` value larger than the static entry, so a future
// upstream bump (1M variants on certain plans) self-corrects without
// requiring another source-code change.
const CODEX_MODEL_METADATA = Object.freeze({
  'gpt-5-codex': { label: 'GPT-5 Codex', contextWindow: 400_000 },
  'gpt-5':       { label: 'GPT-5',        contextWindow: 400_000 },
  'gpt-4.1':     { label: 'GPT-4.1',      contextWindow: 1_000_000 },
  'gpt-4o':      { label: 'GPT-4o',       contextWindow: 128_000 },
  'o1':          { label: 'o1',           contextWindow: 200_000 },
  'o3':          { label: 'o3',           contextWindow: 200_000 },
})

const CODEX_ALLOWED_MODELS = Object.freeze(Object.keys(CODEX_MODEL_METADATA))

const CODEX_FALLBACK_MODELS = Object.freeze(CODEX_ALLOWED_MODELS.map(id => {
  const meta = CODEX_MODEL_METADATA[id]
  return Object.freeze({
    id,
    label: meta.label,
    fullId: id,
    contextWindow: meta.contextWindow,
  })
}))

/**
 * Headroom multiplier for the learn-loop. Re-exported from the shared
 * `CONTEXT_WINDOW_HEADROOM` constant in `utils/context-window-learn.js`
 * (#4414) so the value lives in one place and any future provider that
 * adopts the learn-loop picks up the same headroom.
 *
 * Kept exported under the legacy `CODEX_*` name so existing tests and any
 * consumers continue to compile unchanged.
 */
export const CODEX_CONTEXT_WINDOW_HEADROOM = CONTEXT_WINDOW_HEADROOM

/**
 * Sanity cap on the learn-loop ratchet target for the Codex provider —
 * a single `turn.completed` event with a corrupt or malicious
 * `input_tokens` value (overflow, JSONL parse glitch, future Codex CLI
 * bug) must not be able to balloon the registered window to an absurd
 * number. 2,000,000 tokens is well above today's largest published Codex
 * window (1M for gpt-4.1 / certain 1M GPT-5 variants on plan tiers).
 *
 * Sourced from the per-provider cap table in `utils/context-window-learn.js`
 * (#4414) — bump it there if a legit future Codex model exceeds 2M.
 */
export const CODEX_CONTEXT_WINDOW_RATCHET_CAP = getRatchetCap('codex')

/**
 * #3857 learn-loop helper. Thin Codex-specific wrapper around the shared
 * `maybeRatchetContextWindow` (#4414) so the existing test suite and any
 * direct callers continue to compile unchanged.
 *
 * @param {import('events').EventEmitter} session  The CodexSession instance
 * @param {string} modelId  Short id or fullId of the active Codex model
 * @param {number} inputTokens  `usage.input_tokens` from `turn.completed`
 * @returns {boolean}  true when the registry was updated, false when no-op
 */
export function _maybeRatchetContextWindow(session, modelId, inputTokens) {
  // #4413 persistence behavior is preserved by the shared helper, which
  // calls `registry.saveCache()` after a successful update. Both Codex
  // and Gemini providers route through the same path now.
  return maybeRatchetContextWindow('codex', modelId, inputTokens, session.emit.bind(session))
}

export class CodexSession extends JsonlSubprocessSession {
  // ------------------------------------------------------------------
  // Static provider identity — required by JsonlSubprocessSession
  // ------------------------------------------------------------------

  static get binaryCandidates() {
    return BINARY_CANDIDATES
  }

  static get resolvedBinary() {
    // Re-resolve fresh on every access (NOT a frozen module-load const) so a
    // binary quarantined / moved / reinstalled after daemon start is spawned
    // from its CURRENT path — and matches what preflight verified (#6708).
    return resolveBinary('codex', BINARY_CANDIDATES)
  }

  static get apiKeyEnv() {
    return 'OPENAI_API_KEY'
  }

  /**
   * #6563 — Codex authenticates via OPENAI_API_KEY OR OAuth tokens cached in
   * ~/.codex/auth.json by `codex login`. Reuse the SAME probe resolveAuth() and
   * the preflight use so all three layers (display, runtime, preflight) agree
   * that a `codex login`-only user is authenticated — start() must not throw for
   * them just because the env key is unset.
   */
  static hasAlternativeCredentials() {
    return hasCodexOAuthCreds()
  }

  static get providerName() {
    return 'codex'
  }

  /**
   * Human-readable label shown in the startup banner and anywhere else the
   * server needs to name this provider (#2953). Each provider owns its own
   * display name so `server-cli.js` no longer has to maintain a hardcoded
   * `PROVIDER_LABELS` map that drifts every time a new provider lands.
   */
  static get displayLabel() {
    return 'OpenAI Codex'
  }

  /**
   * Root data directory for this provider (#2965).
   * Consumers (conversation-scanner, ws-file-ops) use this to locate
   * provider-specific subdirs (projects/, agents/, commands/) without
   * hardcoding the path.
   */
  static get dataDir() {
    return join(homedir(), '.codex')
  }

  static get messageIdPrefix() {
    return 'codex'
  }

  static get capabilities() {
    return {
      permissions: false,
      inProcessPermissions: false,
      modelSwitch: true,
      permissionModeSwitch: false,
      planMode: false,
      resume: false,
      terminal: false,
      thinkingLevel: false,
      // #3932: declared explicitly so the capability matrix matches across
      // providers — claude-tui is the only one that sets this to false.
      streaming: true,
    }
  }

  /**
   * Model IDs this provider accepts in `set_model`. Returns a plain array so
   * the settings handler can surface it to the client on rejection.
   * @returns {string[]}
   */
  static getAllowedModels() {
    return CODEX_ALLOWED_MODELS
  }

  /**
   * Minimal model list shown in the dashboard when the SDK has not pushed
   * a dynamic update for this provider. Mirrors the shape returned by
   * `createModelsRegistry().getModels()` so it can be dropped straight
   * into the per-provider registry (#2956).
   *
   * @returns {ReadonlyArray<{id:string,label:string,fullId:string,contextWindow:number}>}
   */
  static getFallbackModels() {
    return CODEX_FALLBACK_MODELS
  }

  /**
   * Lookup metadata for a known Codex model. Returns null for unknown
   * ids so the registry can fall through to its generic heuristic
   * (useful when Codex adds a new model before the server is updated).
   *
   * @param {string} modelId
   * @returns {{id:string,label:string,fullId:string,contextWindow:number,description?:string}|null}
   */
  static getModelMetadata(modelId) {
    const meta = CODEX_MODEL_METADATA[modelId]
    if (!meta) return null
    return {
      id: modelId,
      label: meta.label,
      fullId: modelId,
      contextWindow: meta.contextWindow,
      description: meta.description || '',
    }
  }

  /**
   * Preflight dependency spec used by `chroxy doctor`.
   */
  static get preflight() {
    return {
      label: 'Codex',
      binary: {
        name: 'codex',
        args: ['--version'],
        candidates: BINARY_CANDIDATES,
        installHint: 'install Codex CLI',
      },
      credentials: {
        envVars: ['OPENAI_API_KEY'],
        hint: 'set OPENAI_API_KEY',
        // #6563: the env var is OPTIONAL when OAuth creds exist (`codex login`),
        // so `chroxy doctor` downgrades the missing env var from fail→warn instead
        // of a hard credentials failure — doctor can't read the OAuth token, but it
        // must not report a false failure when resolveAuth() is ready on OAuth. Same
        // probe as resolveAuth() + hasAlternativeCredentials() → one definition of
        // "has a usable credential".
        optional: hasCodexOAuthCreds(),
      },
    }
  }

  /**
   * Resolve runtime auth state for the dashboard (#4769).
   *
   * Codex authenticates via OPENAI_API_KEY env OR the OAuth tokens cached
   * under `~/.codex/auth.json` by `codex login`. The CLI works fine even
   * when the file's OPENAI_API_KEY field is null because the tokens block
   * carries the round-trip (#4301). Env wins; OAuth file fallback covers
   * users who logged in via the CLI instead of exporting a key.
   *
   * @param {NodeJS.ProcessEnv} env
   * @param {{ hasCodexOAuthCreds: () => boolean }} helpers
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string}}
   */
  static resolveAuth(env, helpers) {
    const credSpec = this.preflight.credentials
    const envVars = credSpec.envVars
    const hint = credSpec.hint || `set ${envVars.join(' or ')}`

    const matched = envVars.find(v => env[v])
    if (matched) {
      return {
        ready: true,
        source: 'env',
        envVar: matched,
        envVars,
        hint: '',
        detail: `OpenAI API (${matched} set)`,
        billingClass: BILLING_CLASSES.API_KEY,
      }
    }
    if (helpers.hasCodexOAuthCreds()) {
      return {
        ready: true,
        source: 'oauth',
        envVar: null,
        envVars,
        hint,
        detail: 'OpenAI API (OAuth from `codex login`)',
        billingClass: BILLING_CLASSES.API_KEY,
      }
    }
    const resolvedHint = hint
      ? `${hint} or run \`codex login\``
      : 'run `codex login` or set OPENAI_API_KEY'
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint: resolvedHint,
      detail: envVars.length ? `Not configured — ${resolvedHint}` : 'Not configured',
      // Non-Claude provider — always per-token api-key billing, era-independent.
      billingClass: BILLING_CLASSES.API_KEY,
    }
  }

  constructor(opts = {}) {
    // `model` may be null/undefined — BaseSession coerces to null and
    // _buildArgs() omits the `-c model=...` flag so Codex CLI defers
    // to its own default from ~/.codex/config.toml.
    // #5367: forward every BaseSession opt via the canonical picker (which
    // preserves the #3899 hardTimeoutMs / #4790 streamStallTimeoutMs plumbing
    // that used to be hand-maintained here). Overrides: provider default,
    // `model || DEFAULT_MODEL`, and `resumeSessionId` — the last is a
    // JsonlSubprocessSession-local opt (not a BaseSession key) so it must ride
    // through the overrides bag to reach the middle layer.
    super(buildBaseSessionOpts(opts, {
      provider: opts.provider || 'codex',
      model: opts.model || DEFAULT_MODEL,
      resumeSessionId: opts.resumeSessionId,
    }))
    // #6638: per-session sandbox override — honored on the exec path too, so a
    // read-only/full-access session isn't a silent no-op under CHROXY_CODEX_APPSERVER=0.
    this._codexSandbox = opts.codexSandbox || null
    // #6929 review — resolve ONCE here rather than on every `_buildArgs`/
    // `getCodexSandbox()` call. `opts.codexSandbox` is fixed for the life of this
    // session and nothing between construction and the first spawn can change it,
    // so resolving now and reusing the stored value keeps every turn's `--sandbox`
    // AND the displayed `getCodexSandbox()` value in permanent agreement — a later
    // `CHROXY_CODEX_SANDBOX` env change can no longer retroactively change what a
    // running session reports (display/reality drift).
    this._resolvedCodexSandbox = resolveCodexSandbox(this._codexSandbox)
  }

  /**
   * #6901: the ACTIVE/resolved sandbox mode this session runs under, so
   * `SessionManager.listSessions()` can surface it in `session_list`
   * (`SessionInfo.codexSandbox`) for a running codex session. #6929 review:
   * returns the value resolved ONCE at construction (see ctor) instead of
   * re-resolving `CHROXY_CODEX_SANDBOX` on every call, so a later env change
   * can't make the display drift from what this session's turns actually spawn
   * with. Display-only: a mid-session change needs a new session (Codex
   * applies `--sandbox` fresh per turn here, but always with this same value).
   * @returns {string} one of CODEX_SANDBOX_MODES
   */
  getCodexSandbox() {
    return this._resolvedCodexSandbox
  }

  // ------------------------------------------------------------------
  // JsonlSubprocessSession overrides
  // ------------------------------------------------------------------

  _buildArgs(text) {
    return buildCodexArgs(text, this.model, this.resumeSessionId, this._resolvedCodexSandbox)
  }

  _buildChildEnv() {
    return buildSpawnEnv('codex')
  }

  _processJsonlLine(event, ctx) {
    if (!event.type) return

    switch (event.type) {
      case 'thread.started': {
        // Codex CLI emits this as the first JSONL line of every `codex exec`
        // invocation. Capturing thread_id is what lets subsequent turns
        // resume the conversation (#3865) — without it, every sendMessage
        // spawns `codex exec "<prompt>"` with no prior context.
        if (event.thread_id) {
          this.resumeSessionId = event.thread_id
        }
        break
      }

      case 'item.completed': {
        const item = event.item
        if (!item) break

        if (item.type === 'agent_message' && item.text) {
          if (!ctx.didStreamStart) {
            this.emit('stream_start', { messageId: ctx.messageId })
            ctx.didStreamStart = true
          }
          this.emit('stream_delta', { messageId: ctx.messageId, delta: item.text })
        } else if (item.type === 'tool_call') {
          const toolMessageId = `codex-tool-${++this._messageCounter}`
          this.emit('tool_start', {
            messageId: toolMessageId,
            toolUseId: item.id || toolMessageId,
            tool: item.name || 'unknown',
            input: item.arguments || item.input || {},
          })
        } else if (item.type === 'tool_output') {
          this.emit('tool_result', {
            toolUseId: item.call_id || item.id || `codex-tool-${this._messageCounter}`,
            result: item.output || item.text || '',
          })
        }
        break
      }

      case 'turn.completed': {
        ctx.didEmitResult = true
        // End stream before result (standard provider contract)
        if (ctx.didStreamStart) {
          this.emit('stream_end', { messageId: ctx.messageId })
          ctx.didStreamStart = false
        }
        const usage = event.usage || {}
        const inputTokens = usage.input_tokens || 0
        const outputTokens = usage.output_tokens || 0
        // #3857 learn-loop: when Codex reports an `input_tokens` value that
        // exceeds the registered context window for the active model, the
        // static window is stale (this is exactly how we found the original
        // 272k drift — 321k turns kept succeeding past 100%). Ratchet the
        // registry upward to at least `input_tokens * 1.1` so the next turn's
        // meter reflects reality, and emit `models_updated` so connected
        // dashboards pick up the corrected value without waiting for a
        // refresh. Mirrors the Claude path in sdk-session.js:741 — except
        // the SDK there has an explicit `contextWindow` field; here we infer
        // it from the observed token count.
        //
        // Only ratchets *up* — a single small turn must never shrink the
        // registered window (the model didn't change, only the prompt size
        // for this one turn did).
        if (this.model && inputTokens > 0) {
          _maybeRatchetContextWindow(this, this.model, inputTokens)
        }
        this.emit('result', {
          cost: null,
          duration: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
          sessionId: this.resumeSessionId,
        })
        break
      }

      default:
        break
    }
  }
}
