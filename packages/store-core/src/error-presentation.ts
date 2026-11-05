/**
 * Canonical error-presentation registry (chat redesign epic #6389, Phase 2 #6392).
 *
 * The dashboard chat stream renders an inline "chip" for recoverable error
 * messages — a stalled stream, an AskUserQuestion delivery that failed, a
 * conversation that couldn't be resumed — instead of a bare red bubble. Today
 * each chip hard-codes its own headline copy + ARIA role, so the error taxonomy
 * is scattered across StreamStallChip / AskUserQuestionStallChip /
 * ResumeUnknownChip. This module defines that mapping ONCE — pure data, no DOM /
 * React Native deps — the same way {@link ./tool-presentation} centralised
 * tool-card presentation. A forthcoming single `ChatErrorFrame` (and a mobile
 * twin) consume it so the two surfaces can't drift, and a new recoverable error
 * code becomes a one-line addition here.
 *
 * `code` is the optional free-form `ChatMessage.code`, mirroring the server's
 * error wire message. The AskUserQuestion family is matched via the existing
 * single-source-of-truth predicate ({@link isRetryableAskUserQuestionError})
 * rather than re-listing its six codes here.
 */

import { parseAuthRequiredCause, type AuthRequiredCause } from '@chroxy/protocol'
import { isRetryableAskUserQuestionError } from './ask-user-question-errors'

/**
 * #8223 — the command that signs the `claude` CLI in on a host: claude 2.1.x spells
 * it `auth login` (plain `claude login` is stale). Defined HERE, beside the
 * `AUTH_REQUIRED` presentation entry that tells the user to run it, so the
 * dashboard and the app chips read one string instead of each hard-coding it. The
 * server keeps its own single definition (`utils/claude-login-command.js`) — the
 * packages cannot share a module — and a store-core test pins the two together.
 */
export const CLAUDE_LOGIN_COMMAND = 'claude auth login'

/** Coarse classification of a recoverable chat error by what it represents.
 *  `generic` is the catch-all for an unrecognised / missing error code. */
export type ErrorKind = 'stall' | 'question' | 'resume' | 'auth' | 'generic'

export interface ErrorPresentation {
  // Fields are `readonly`: getErrorPresentation returns shared module-level
  // singletons, so a consumer that mutated one would corrupt the registry for
  // every later caller. readonly blocks that at compile time for all (TS) consumers.
  readonly kind: ErrorKind
  /** ARIA live politeness: `status` (polite) for recoverable / auto-handled
   *  errors, `alert` (assertive) for terminal ones the user must act on. */
  readonly role: 'status' | 'alert'
  /** Default human-facing headline. Consumers may override for the dynamic
   *  cases (e.g. the stall chip's "No response for 30s — retry?"). */
  readonly headline: string
}

/** Per-code presentation. The AskUserQuestion teardown family (six codes, #5793)
 *  is matched via {@link isRetryableAskUserQuestionError}, not listed here, so a
 *  new code lights up in one place. */
const PRESENTATION_BY_CODE: Readonly<Record<string, ErrorPresentation>> = {
  // Server emits this after the configured stream-inactivity window (#4475).
  stream_stall: {
    kind: 'stall',
    role: 'status',
    headline: 'Stream stalled — retry?',
  },
  // #8223: the claude CLI is logged out or its login expired (claude-tui's
  // scan / `claude auth status` probe, claude-sdk's authentication_failed).
  // Retrying cannot help — the user has to sign in on the host — so this is
  // assertive, and it is not a "retry?" headline like the stall family.
  AUTH_REQUIRED: {
    kind: 'auth',
    role: 'alert',
    headline: 'Claude is not signed in on this host',
  },
  // CliSession already auto-fell-back to a fresh conversation (#4944) — polite.
  resume_unknown: {
    kind: 'resume',
    role: 'status',
    headline: 'Previous conversation could not be resumed — starting fresh',
  },
  // Auto-respawn gave up (#5004) — terminal, the user must act, so assertive.
  resume_unknown_exhausted: {
    kind: 'resume',
    role: 'alert',
    headline: 'Auto-recovery exhausted — start a new session manually to continue',
  },
}

/** Shared presentation for the AskUserQuestion teardown family (#5793) — the
 *  prompt is dead but the user can recover by resending their request. */
const QUESTION_PRESENTATION: ErrorPresentation = {
  kind: 'question',
  role: 'status',
  headline: 'Question delivery failed — retry?',
}

/** Catch-all for an unrecognised / missing code — an unexpected error the user
 *  should notice. Consumers typically show the raw server text as well. */
const GENERIC_PRESENTATION: ErrorPresentation = {
  kind: 'generic',
  role: 'alert',
  headline: 'Something went wrong',
}

/** Presentation descriptor for a chat error `code`: kind + ARIA role + a default
 *  headline. The AskUserQuestion family is matched via the shared predicate; any
 *  unrecognised / missing code falls back to `generic` — never throws. */
export function getErrorPresentation(
  code: string | null | undefined,
): ErrorPresentation {
  if (!code) return GENERIC_PRESENTATION
  if (isRetryableAskUserQuestionError(code)) return QUESTION_PRESENTATION
  return PRESENTATION_BY_CODE[code] ?? GENERIC_PRESENTATION
}

/** #8273 / #8970: why a session reported `AUTH_REQUIRED`, as the server tags it on the wire. */
export type { AuthRequiredCause }

/** Narrow an untrusted wire value to a known cause; anything else is `undefined`. */
export function parseAuthCause(value: unknown): AuthRequiredCause | undefined {
  return parseAuthRequiredCause(value)
}

export interface AuthRequiredPresentation {
  readonly role: 'alert'
  readonly headline: string
  /** Whether the host `claude auth login` command row applies to this cause. */
  readonly showLoginCommand: boolean
}

const AUTH_LOGIN_PRESENTATION: AuthRequiredPresentation = {
  role: 'alert',
  headline: getErrorPresentation('AUTH_REQUIRED').headline,
  showLoginCommand: true,
}

export const AUTH_PRESENTATION_BY_CAUSE: Readonly<Record<AuthRequiredCause, AuthRequiredPresentation>> = {
  login: AUTH_LOGIN_PRESENTATION,
  // The session authenticates with ANTHROPIC_API_KEY, so signing in is not the fix.
  api_key: { role: 'alert', headline: 'Your Anthropic API key was rejected', showLoginCommand: false },
  // A host login does not reach the container; its credential is its env.
  container: {
    role: 'alert',
    headline: 'The session container needs ANTHROPIC_API_KEY',
    showLoginCommand: false,
  },
  // #8970: none of these mechanisms uses `claude auth login`, so the login
  // command row is wrong advice for every one of them.
  bedrock: { role: 'alert', headline: 'Amazon Bedrock rejected the AWS credentials', showLoginCommand: false },
  vertex: { role: 'alert', headline: 'Google Vertex AI rejected the Google Cloud credentials', showLoginCommand: false },
  auth_token: { role: 'alert', headline: 'Your ANTHROPIC_AUTH_TOKEN was rejected', showLoginCommand: false },
  api_key_helper: { role: 'alert', headline: 'The apiKeyHelper key was rejected or the helper failed', showLoginCommand: false },
}

/**
 * Presentation of an `AUTH_REQUIRED` chip for the server's `authCause`. An absent
 * or unrecognised cause (an older server, or one the server could not determine)
 * gets the login presentation, which is what the chip showed before the cause
 * existed. Never throws.
 */
export function getAuthRequiredPresentation(cause: unknown): AuthRequiredPresentation {
  const known = parseAuthCause(cause)
  return known ? AUTH_PRESENTATION_BY_CAUSE[known] : AUTH_LOGIN_PRESENTATION
}
