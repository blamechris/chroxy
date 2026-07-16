// `chroxy tokens` — list and revoke persisted paired-device session tokens
// (#6599, part of epic #6597). Operates on the on-disk session-token store
// (`~/.chroxy/session-tokens.json`, #6598) — the same encrypted store the daemon
// loads at boot.
//
// Like `chroxy identity rotate`, this edits the PERSISTED store and takes effect
// on the daemon's next start: a running daemon keeps its already-issued tokens in
// memory (and would re-persist them on the next change), so restart the daemon to
// enforce a revoke. Live revocation against a running daemon is a follow-up.
//
// Revoke targets a token by a unique handle PREFIX (from `tokens list`); the full
// token is never printed. `--all` is the panic button and requires `--yes`.

import { homedir } from 'os'
import { join } from 'path'
import { createSessionTokenStore } from '../session-token-store.js'

/** Resolve the chroxy config dir the same way server-cli does. */
function resolveChroxyDir(env = process.env) {
  return env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
}

/** Human-readable age; null when the entry has no createdAt. */
function formatAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'unknown'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.floor(hr / 24)}d`
}

const ENFORCE_NOTE =
  'Restart the daemon to enforce — a running daemon keeps already-issued tokens in memory until restart.'

/**
 * List persisted session tokens. Pure aside from the injected store/writer/clock,
 * so a test drives it with an in-memory store.
 *
 * @param {object} [deps] - { store, write, now }
 * @returns {{ count: number, tokens: Array<{ handle: string, sessionId: string, ageMs: number|null }> }}
 */
export function runTokensList(deps = {}) {
  const out = deps.write || console.log
  const store = deps.store || createSessionTokenStore({ dir: resolveChroxyDir() })
  const now = typeof deps.now === 'number' ? deps.now : Date.now()

  const entries = store.load()
  if (!Array.isArray(entries) || entries.length === 0) {
    out('No paired session tokens. Devices pair via the dashboard QR / pairing code.')
    return { count: 0, tokens: [] }
  }

  const rows = entries.map(([token, meta]) => ({
    handle: String(token).slice(0, 12),
    sessionId: (meta && typeof meta.sessionId === 'string' && meta.sessionId) || '(none)',
    ageMs: meta && typeof meta.createdAt === 'number' ? now - meta.createdAt : null,
  }))

  out(`${rows.length} paired session token(s):`)
  for (const r of rows) {
    out(`  ${r.handle}…  session=${r.sessionId}  age=${formatAge(r.ageMs)}`)
  }
  out('')
  out('Revoke one:  chroxy tokens revoke <handle-prefix>')
  out('Revoke all:  chroxy tokens revoke --all --yes')
  return { count: rows.length, tokens: rows }
}

/**
 * Revoke a session token by handle prefix, or every token with `--all`.
 *
 * @param {string|undefined} target - handle prefix (ignored when `options.all`)
 * @param {{ all?: boolean, yes?: boolean }} [options]
 * @param {object} [deps] - { store, write }
 * @returns {{ revoked: number, mode: 'all'|'one', confirmed?: boolean, error?: string, matches?: number }}
 */
export function runTokensRevoke(target, options = {}, deps = {}) {
  const out = deps.write || console.log
  const store = deps.store || createSessionTokenStore({ dir: resolveChroxyDir() })
  const entries = store.load()
  const list = Array.isArray(entries) ? entries : []

  if (options.all) {
    if (!options.yes) {
      out(
        [
          `chroxy tokens revoke --all — the panic button: revoke ALL ${list.length} paired device token(s).`,
          '',
          'Every paired device must re-pair (dashboard QR / pairing code) after this.',
          `${ENFORCE_NOTE}`,
          '',
          'This is consequential — re-run with --yes to proceed:',
          '  chroxy tokens revoke --all --yes',
        ].join('\n'),
      )
      return { revoked: 0, mode: 'all', confirmed: false }
    }
    store.save([])
    out(`Revoked all ${list.length} session token(s). ${ENFORCE_NOTE}`)
    return { revoked: list.length, mode: 'all', confirmed: true }
  }

  if (!target) {
    out('Specify a token handle prefix (see: chroxy tokens list), or --all to revoke every token.')
    return { revoked: 0, mode: 'one', error: 'no-target' }
  }

  const matches = list.filter(([token]) => String(token).startsWith(target))
  if (matches.length === 0) {
    out(`No session token matches "${target}". Run: chroxy tokens list`)
    return { revoked: 0, mode: 'one', error: 'no-match' }
  }
  if (matches.length > 1) {
    // Never guess which token to drop — demand a longer, unambiguous prefix.
    out(`"${target}" matches ${matches.length} tokens — use a longer handle prefix to disambiguate.`)
    return { revoked: 0, mode: 'one', error: 'ambiguous', matches: matches.length }
  }

  const remaining = list.filter(([token]) => !String(token).startsWith(target))
  store.save(remaining)
  out(`Revoked 1 session token (${target}…). ${ENFORCE_NOTE}`)
  return { revoked: 1, mode: 'one', confirmed: true }
}

export function registerTokensCommand(program) {
  const tokens = program
    .command('tokens')
    .description('List and revoke persisted paired-device session tokens (#6599)')

  tokens
    .command('list')
    .description('List paired-device session tokens (handle, session, age)')
    .action(() => {
      try {
        runTokensList()
      } catch (err) {
        console.error(`tokens list failed: ${err.message}`)
        process.exitCode = 1
      }
    })

  tokens
    .command('revoke [handle]')
    .description('Revoke a session token by handle prefix, or --all to revoke every token')
    .option('--all', 'Revoke EVERY paired-device token (panic button — all devices re-pair)')
    .option('--yes', 'Confirm --all (without it, the command only explains what it would do)')
    .action((handle, options) => {
      try {
        runTokensRevoke(handle, options)
      } catch (err) {
        console.error(`tokens revoke failed: ${err.message}`)
        process.exitCode = 1
      }
    })
}
