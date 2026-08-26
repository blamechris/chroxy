/**
 * #7378 — App.tsx must not recompute "busy" inline.
 *
 * `isSessionBusy`'s contract is that it matches EXACTLY what the InputBar shows
 * as busy (`isStreaming || isBusy`) — the #5952 invariant, because that decides
 * whether an optimistic send renders as "Queued" or as a fresh turn. Until
 * #7378 nothing enforced it: App.tsx wrote the props by hand at six JSX sites as
 * `isBusy={!isIdle}` / `isStreaming={streamingMessageId !== null}`, a third copy
 * of the predicate in a spelling that disagrees with the other two whenever
 * `isIdle` is nullish (`!undefined` is busy, `undefined === false` is idle —
 * they invert).
 *
 * `inputBarBusyProps` makes the disjunction correct BY CONSTRUCTION, and
 * `session-busy.test.ts` pins that identity. This file pins the other half —
 * that App.tsx actually uses it — because a helper nothing calls is not a fix.
 * A seventh site added by copy-paste from a neighbour is the realistic
 * regression, and it is exactly the "hardcoded copy beside a set that grows"
 * shape in docs/false-safety-guards.md.
 *
 * ANCHORED, not a file-wide grep. The rule is asserted per prop site: each
 * `isBusy=` / `isStreaming=` JSX attribute must carry an approved value. A
 * whole-file search for `!isIdle` would be satisfiable by any unrelated line —
 * and would trip on this file's own prose, and on the explanatory comment in
 * App.tsx that quotes the old form deliberately. Comment lines are excluded for
 * that reason, and the count assertion below is the positive control: if the
 * scan ever finds nothing, it fails loudly instead of passing over an empty set.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Vitest transforms this module, so `import.meta.url` is not a file: URL here.
// Resolve from the package root (vitest's cwd) instead, and assert the file is
// really there — a cwd change must fail loudly, not silently read nothing.
const APP_TSX = resolve(process.cwd(), 'src/App.tsx')

/**
 * Values a busy prop is allowed to carry.
 *
 * `{false}` is on the list for the system pane, a static ChatView of
 * system-side messages that never streams and shows no input — inert on
 * purpose, not an oversight.
 */
const ALLOWED = new Set([
  '{busyProps.isBusy}',
  '{busyProps.isStreaming}',
  '{false}',
])

interface PropSite {
  line: number
  name: string
  value: string
  text: string
}

/** Non-comment lines in App.tsx that OPEN a busy prop, parsed or not. */
function busyPropLines(): Array<{ line: number; text: string }> {
  return readFileSync(APP_TSX, 'utf8')
    .split('\n')
    .map((raw, i) => ({ line: i + 1, text: raw.trim() }))
    .filter(({ text }) => {
      // Prose is not code. App.tsx's #7378 comment quotes `isBusy={!isIdle}` on
      // purpose, to say what the old spelling was and why it was wrong.
      if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) return false
      return /^(isBusy|isStreaming)=/.test(text)
    })
}

/**
 * The value regex deliberately accepts SPACES.
 *
 * It did not, at first — `(\S+)` — and a mutation caught it: reverting a site to
 * `isStreaming={streamingMessageId !== null}` left the suite green, because the
 * spaces in that expression meant the line failed to parse and was **skipped**
 * rather than flagged. A prop the scanner cannot read is the one most likely to
 * be wrong; treating "cannot check this" as "nothing to check" is the exact
 * false-safety shape in docs/false-safety-guards.md. `every busy prop line
 * parses` below now makes an unreadable site an error in its own right.
 */
function busyPropSites(): PropSite[] {
  const sites: PropSite[] = []
  for (const { line, text } of busyPropLines()) {
    const m = /^(isBusy|isStreaming)=(.+?)\s*$/.exec(text)
    if (m) sites.push({ line, name: m[1]!, value: m[2]!, text })
  }
  return sites
}

describe('InputBar busy props are wired, not rewritten (#7378)', () => {
  const sites = busyPropSites()

  it('resolves App.tsx', () => {
    expect(existsSync(APP_TSX), `App.tsx not found at ${APP_TSX}`).toBe(true)
  })

  it('finds the busy prop sites in App.tsx', () => {
    // Positive control. Every assertion below quantifies over `sites`; if the
    // scan breaks they all pass vacuously and report a clean green.
    expect(sites.length).toBeGreaterThanOrEqual(8)
    expect(sites.filter(s => s.name === 'isBusy').length).toBeGreaterThanOrEqual(5)
    expect(sites.filter(s => s.name === 'isStreaming').length).toBeGreaterThanOrEqual(3)
  })

  it('every busy prop line parses — an unreadable site is an error, not a skip', () => {
    // The gap a mutation found: a value containing spaces did not match the
    // pattern, so the site vanished from `sites` and every rule below simply
    // never saw it. Any line that opens a busy prop must end up parsed.
    const lines = busyPropLines()
    const parsed = new Set(sites.map(s => s.line))
    const unreadable = lines.filter(l => !parsed.has(l.line)).map(l => `App.tsx:${l.line}  ${l.text}`)
    expect(
      unreadable,
      `these lines open a busy prop but could not be parsed, so no rule was applied to them:\n  ${unreadable.join('\n  ')}`,
    ).toEqual([])
    expect(lines.length).toBe(sites.length)
  })

  it('every busy prop reads the shared derivation, none recompute it', () => {
    const offenders = sites
      .filter(s => !ALLOWED.has(s.value))
      .map(s => `App.tsx:${s.line}  ${s.text}`)
    expect(
      offenders,
      'each isBusy=/isStreaming= prop must come from `busyProps` (inputBarBusyProps) ' +
        'or be the literal {false}. Recomputing it inline re-creates the third copy #7378 ' +
        `removed:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  it('App.tsx imports the helper it is supposed to be using', () => {
    // Without this, deleting the import and hardcoding `busyProps` as a local
    // object literal would satisfy every assertion above.
    const src = readFileSync(APP_TSX, 'utf8')
    expect(src).toContain("import { inputBarBusyProps } from './lib/session-busy'")
    expect(src).toMatch(/const busyProps = useMemo\(\s*\n?\s*\(\) => inputBarBusyProps\(/)
  })

  it('the old inline spellings are gone from JSX', () => {
    // The specific regression, named. Checked over prop sites only, so the
    // deliberate explanatory comments quoting the old form do not trip it.
    const revived = sites
      .filter(s => /!isIdle|streamingMessageId/.test(s.value))
      .map(s => `App.tsx:${s.line}  ${s.text}`)
    expect(
      revived,
      `these props recompute the predicate inline instead of using busyProps:\n  ${revived.join('\n  ')}`,
    ).toEqual([])
  })
})
