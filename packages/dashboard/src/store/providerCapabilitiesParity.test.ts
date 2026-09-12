/**
 * #7725 — the dashboard and the mobile app each carry their OWN
 * `ProviderCapabilities` interface, describing the same server-sent object. The
 * two had silently drifted (`denyReason` and `containerized` existed only in
 * the dashboard copy) because nothing compared them: a new capability added to
 * one side type-checks perfectly, and the other side's consumers just never see
 * the field.
 *
 * This reads both declarations as TEXT — the interfaces are erased at runtime,
 * so there is no value to compare — and asserts the key ROSTERS match in BOTH
 * directions. One direction is how #7199 / #7216 / #7544 each survived: "every
 * key I listed exists" passes happily while the other file grows keys nobody
 * checked for.
 *
 * Optionality is deliberately NOT compared: the dashboard marks the
 * long-established fields required and the app marks everything optional, which
 * is a real difference in how each client tolerates an older daemon, not drift.
 */
import { describe, it, expect } from 'vitest'
// Vite's `?raw` import, not `fs` — under vitest `import.meta.url` is a dev-server
// URL, so `readFileSync(new URL(...))` throws "The URL must be of scheme file".
// `?raw` resolves at transform time with the same module resolution the app uses.
import dashboardTypesSrc from './types.ts?raw'
import appTypesSrc from '../../../app/src/store/types.ts?raw'

/**
 * Pull the `ProviderCapabilities` interface body out of a types module's source
 * and return its field names. Throws rather than returning `[]` when the
 * interface cannot be found — an empty roster would make the comparison below
 * pass for the worst possible reason.
 *
 * Every body line is accounted for: it is blank, a comment, or a field. A line
 * that is none of those THROWS rather than being skipped. The first cut matched
 * `/^\s{2}(\w+)\??:\s/` — exactly two leading spaces and a space after the
 * colon — so `  foo:boolean;` or a re-indented field parsed as nothing, and if
 * the same formatting were used in BOTH files the key would vanish from both
 * rosters while the comparison still passed. "Could not parse this" reading as
 * "there is nothing here" is the docs/false-safety-guards.md class (#7195,
 * #7210); the `> 5` floor below bounds that blast radius but does not close it,
 * because keys can be dropped from both sides one at a time.
 */
function providerCapabilityKeys(src: string, label: string): string[] {
  const start = src.indexOf('export interface ProviderCapabilities {')
  if (start === -1) throw new Error(`no ProviderCapabilities interface in ${label}`)
  const end = src.indexOf('\n}', start)
  if (end === -1) throw new Error(`unterminated ProviderCapabilities interface in ${label}`)
  // slice(1) drops the `export interface ProviderCapabilities {` line itself.
  const body = src.slice(start, end).split('\n').slice(1)
  const keys: string[] = []
  const unparsed: string[] = []
  for (const raw of body) {
    const line = raw.trim()
    if (line === '' || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue
    const match = /^([A-Za-z_$][\w$]*)\s*\??\s*:\s*\S/.exec(line)
    if (match) keys.push(match[1]!)
    else unparsed.push(line)
  }
  if (unparsed.length > 0) {
    throw new Error(
      `could not parse ${unparsed.length} line(s) of ProviderCapabilities in ${label} — ` +
      `a skipped line is a key silently missing from this roster: ${unparsed.join(' | ')}`
    )
  }
  if (keys.length === 0) throw new Error(`parsed zero fields from ${label}`)
  return keys.sort()
}

describe('ProviderCapabilities parity: dashboard vs mobile app (#7725)', () => {
  it('both clients declare the same capability keys', () => {
    const dashboard = providerCapabilityKeys(dashboardTypesSrc, 'dashboard/src/store/types.ts')
    const app = providerCapabilityKeys(appTypesSrc, 'app/src/store/types.ts')
    // Sanity floor: a parser that returned one plausible-looking key from each
    // file would otherwise "match" on a pair of ruined rosters.
    expect(dashboard.length).toBeGreaterThan(5)
    expect(app).toEqual(dashboard)
  })

  it('both declare thinkingKeywords, the flag the composer highlight reads', () => {
    expect(providerCapabilityKeys(dashboardTypesSrc, 'dashboard/src/store/types.ts')).toContain('thinkingKeywords')
    expect(providerCapabilityKeys(appTypesSrc, 'app/src/store/types.ts')).toContain('thinkingKeywords')
  })
})
