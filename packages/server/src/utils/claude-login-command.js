/**
 * #8223 — the ONE spelling of the command that signs the `claude` CLI in on a
 * host. The AUTH_REQUIRED messages (claude-tui's in claude-tui/pty-driver.js,
 * claude-sdk's in sdk-session.js), the provider credential hints and the doctor
 * row all tell an operator to run it, and four hand-typed copies were already one
 * edit from disagreeing. claude 2.1.x spells it `auth login`; plain `claude login`
 * is stale.
 *
 * A module of its own, not an export of pty-driver.js, because sdk-session.js needs
 * it and pty-driver.js resolves the claude binary at import time, which the SDK
 * provider must not do. The dashboard and the app read the same string from
 * `@chroxy/store-core` (`CLAUDE_LOGIN_COMMAND`, next to the AUTH_REQUIRED
 * presentation entry); the two packages cannot share a module, so each side keeps
 * exactly one definition.
 */
export const CLAUDE_LOGIN_COMMAND = 'claude auth login'
