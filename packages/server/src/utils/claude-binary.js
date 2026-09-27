/**
 * #7986 — the ONE `claude` binary candidate list + resolver.
 *
 * Before this module there were five copies of the candidate list:
 * `cli-session.js` (the module const, used by both its `resolveClaudeBinary`
 * and its `static get preflight`), `claude-tui-session.js`'s preflight,
 * `claude-channel-session.js`'s preflight, `claude-tui/pty-driver.js`'s own
 * const, plus the SDK provider's separate 2-entry subset. A drifted copy is
 * invisible until one provider finds `~/.local/bin/claude` and another
 * doesn't — the same "hardcoded list next to a set that grows" defect class
 * this repo's false-safety-guards catalogue names repeatedly. This is now the
 * one place the list is written; every claude-family provider imports it.
 *
 * `resolveClaudeBinary()` re-resolves FRESH on every call (NOT a frozen
 * module-load const) so a binary quarantined / moved / reinstalled after
 * daemon start is spawned from its CURRENT path — and matches what preflight
 * verified (#6708 defect #3).
 */
import { homedir } from 'os'
import { join } from 'path'
import { resolveBinary } from './resolve-binary.js'

// Well-known fallback locations for the `claude` binary. Under a GUI launch
// (e.g. Tauri on macOS) PATH is minimal and may exclude the user's install dir.
export const CLAUDE_BINARY_CANDIDATES = [
  join(homedir(), '.local/bin/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join(homedir(), '.claude/local/node_modules/.bin/claude'),
  join(homedir(), '.npm-global/bin/claude'),
]

export function resolveClaudeBinary() {
  return resolveBinary('claude', CLAUDE_BINARY_CANDIDATES)
}
