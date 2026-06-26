import { homedir } from 'os'
import { join } from 'path'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { ALLOWED_MODEL_IDS } from './models.js'
import { CLAUDE_FALLBACK_MODELS, claudeModelMetadata } from './claude-model-catalog.js'
import { BILLING_CLASSES } from './billing-class.js'

// Minimum `claude` CLI version that ships the `--channels` MCP transport.
// Verified present in v2.1.163 (the locally-installed CLI) and documented
// from v2.1.80+; permission relay needs ≥ v2.1.81 but that surface lands
// with sub 4 (#3955), so the scaffold gates on the channel-transport floor
// only. See docs/architecture/claude-channels-provider-spike.md.
export const CLAUDE_CHANNEL_MIN_VERSION = '2.1.80'

/**
 * ClaudeChannelSession — provider scaffold for the `claude --channels` MCP
 * transport (#3953, parent #3951). Research preview.
 *
 * This is intentionally a NO-OP session: `start()` throws "not yet
 * implemented" so the bridge wiring (spawn + IPC round-trip) can land in
 * isolation as sub 3 (#3954). Everything the dashboard and `chroxy doctor`
 * need to LIST and reason about the provider — capabilities, displayLabel,
 * dataDir, preflight (binary + minVersion + credentials), model metadata,
 * and auth/billing detail — is fully wired here so the registry surface can
 * be reviewed without any PTY spawning or MCP child process.
 *
 * Auth/billing mirrors `claude-tui`: a subscription/console-authenticated
 * interactive `claude` session. The channel path bypasses programmatic
 * credit metering for the same reason the TUI path does — the events arrive
 * in a real interactive session, not a `claude -p` subprocess. It does NOT
 * accept ANTHROPIC_API_KEY.
 *
 * Capability honesty (see the spike's matrix): channels win on `streaming`
 * and a documented permission contract, but do NOT solve model switch or
 * permission-mode switch — those stay `false`, same gap `claude-tui` has.
 */
export class ClaudeChannelSession extends BaseSession {
  // #5858: Claude-family flag — single source of truth for isClaudeProvider().
  static claudeFamily = true

  // Single source of truth for the scaffold's "not yet implemented" error
  // so start()/sendMessage()/interrupt() stay in lockstep and tests can
  // assert on the same string.
  static get NOT_IMPLEMENTED_MESSAGE() {
    return 'claude-channel provider not yet implemented (bridge wiring lands in #3954, see #3951)'
  }

  static get displayLabel() {
    return 'Claude Code (Channel · subscription · research preview)'
  }

  static get dataDir() {
    return join(homedir(), '.claude')
  }

  static get capabilities() {
    return {
      // Permissions land in sub 4 (#3955) via the first-party
      // `claude/channel/permission` relay — declared true here so the
      // capability matrix matches the spike + #3953, but the actual
      // round-trip is not wired until the bridge exists.
      permissions: true,
      // Verdicts round-trip over IPC, not in-process — same as claude-tui.
      inProcessPermissions: false,
      // Channel surface does not expose model switching (spike R5).
      modelSwitch: false,
      // No documented channel mechanism for permission-mode switch (initially).
      permissionModeSwitch: false,
      planMode: false,
      resume: false,
      terminal: false,
      thinkingLevel: false,
      // Channel notifications stream as they arrive — the headline win
      // over claude-tui's deliver-on-complete model.
      streaming: true,
      tools: true,
    }
  }

  static get preflight() {
    return {
      label: 'Claude Channel',
      binary: {
        name: 'claude',
        args: ['--version'],
        // Gate on the channel-transport floor. The doctor's checkBinary
        // comparator parses the leading semver out of `claude --version`
        // (e.g. "2.1.163 (Claude Code)") and fails below this.
        minVersion: CLAUDE_CHANNEL_MIN_VERSION,
        candidates: [
          join(homedir(), '.local/bin/claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          join(homedir(), '.claude/local/node_modules/.bin/claude'),
          join(homedir(), '.npm-global/bin/claude'),
        ],
        installHint: `install Claude Code CLI ≥ ${CLAUDE_CHANNEL_MIN_VERSION} (research preview — channels)`,
      },
      credentials: {
        envVars: [],
        hint: 'run `claude login` (subscription required — this provider does NOT accept ANTHROPIC_API_KEY)',
        optional: true,
      },
    }
  }

  /**
   * Resolve runtime auth state for the dashboard (#4769 pattern).
   *
   * Same path as claude-tui: subscription via OAuth/Keychain, never the
   * API key. Marked ready up front because the on-disk OAuth probe can't
   * see Keychain credentials. Detail flags the research-preview status and
   * the credit-metering bypass so the dashboard billing panel reads true.
   *
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string, billingClass:string}}
   */
  static resolveAuth() {
    const envVars = this.preflight.credentials.envVars
    return {
      ready: true,
      source: 'oauth',
      envVar: null,
      envVars,
      hint: 'run `claude login` if not yet authed',
      detail: 'Claude subscription (channel MCP — bypasses programmatic credit metering · research preview)',
      // Channel MCP bypasses credit metering — flat subscription billing in
      // both eras (#5629 leaves this UNCHANGED).
      billingClass: BILLING_CLASSES.SUBSCRIPTION,
    }
  }

  static getFallbackModels() {
    return CLAUDE_FALLBACK_MODELS
  }

  static getAllowedModels() {
    return [...ALLOWED_MODEL_IDS]
  }

  static getModelMetadata(modelId) {
    return claudeModelMetadata(modelId)
  }

  constructor(opts = {}) {
    super(buildBaseSessionOpts(opts, { provider: opts.provider || 'claude-channel' }))
  }

  /**
   * Scaffold no-op. The live bridge — spawn `claude --channels`, wire the
   * stdio MCP child + IPC socket, normalize outbound events — is sub 3
   * (#3954). Throwing here (rather than spawning anything) is the whole
   * point of #3953: `chroxy --provider claude-channel` fails fast with a
   * clear message, no PTY, no MCP child.
   */
  async start() {
    throw new Error(ClaudeChannelSession.NOT_IMPLEMENTED_MESSAGE)
  }

  /**
   * Required by the ProviderSession interface (validateProviderClass).
   * Unlike start/destroy/setModel/setPermissionMode, BaseSession does not
   * provide sendMessage/interrupt — each provider owns them — so the
   * scaffold must define them or the registry validator rejects the class.
   * Both throw the same not-implemented error until the bridge (#3954)
   * gives them something to do. They should never be reached anyway: start()
   * throws first, so no session ever becomes ready enough to message.
   */
  async sendMessage() {
    throw new Error(ClaudeChannelSession.NOT_IMPLEMENTED_MESSAGE)
  }

  interrupt() {
    throw new Error(ClaudeChannelSession.NOT_IMPLEMENTED_MESSAGE)
  }

  /**
   * Safe no-op teardown. There is nothing to tear down (start() never
   * spawns anything), and destroy() must not throw — SessionManager calls
   * it on cleanup paths where a throw would mask the original error.
   */
  destroy() {
    this._destroying = true
    this._processReady = false
  }
}
