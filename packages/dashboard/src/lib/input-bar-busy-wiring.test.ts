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

/** The only values that need no justification: the shared derivation itself. */
const DERIVED = new Set(['{busyProps.isBusy}', '{busyProps.isStreaming}'])

/**
 * A site may be hardcoded INERT, but only deliberately and only to `{false}`.
 *
 * `{false}` used to be blanket-allowed, and a mutation showed what that bought:
 * hardcoding the live InputBar to `isBusy={false} isStreaming={false}` kills the
 * Stop button, the follow-up placeholder and the `isBusy && !isStreaming` block,
 * and the guard stayed green. Only the system pane — a static ChatView that
 * never streams and shows no input — has a reason to be inert.
 *
 * So an exemption must be WRITTEN, in the style of the repo's other deliberate
 * opt-outs (`lint-ignore-opt-forwarding: <key>`), within the few lines above the
 * prop:
 *
 *     {/* busy-wiring-exempt: static system pane, never streams *\/}
 *
 * Note what is still impossible even with a marker: the value must be `{false}`.
 * An exemption can make a site inert; it can never re-introduce an inline
 * predicate, which is the thing #7378 removed.
 */
const EXEMPT_MARKER = 'busy-wiring-exempt:'
const EXEMPT_LOOKBACK = 8

interface PropSite {
  line: number
  name: string
  value: string
  text: string
}

/**
 * Every non-comment line of App.tsx, with its 1-based number.
 *
 * Comment lines are dropped because prose is not code: App.tsx's #7378 comment
 * quotes `isBusy={!isIdle}` on purpose, to record what the old spelling was.
 */
function codeLines(): Array<{ line: number; text: string }> {
  return readFileSync(APP_TSX, 'utf8')
    .split('\n')
    .map((raw, i) => ({ line: i + 1, text: raw }))
    .filter(({ text }) => {
      const t = text.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
}

/** Lines carrying at least one busy attribute, whether or not its value parses. */
function busyPropLines(): Array<{ line: number; text: string }> {
  return codeLines().filter(({ text }) => /\b(isBusy|isStreaming)=/.test(text))
}

/**
 * Read a JSX attribute value starting at `i` (the char after `=`).
 *
 * Returns undefined if a `{` never closes on this line — a multi-line prop the
 * scanner cannot judge. That is reported as unreadable rather than skipped.
 */
function readValue(text: string, i: number): string | undefined {
  if (text[i] !== '{') {
    const m = /^\S+/.exec(text.slice(i))
    return m ? m[0] : undefined
  }
  let depth = 0
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++
    else if (text[j] === '}' && --depth === 0) return text.slice(i, j + 1)
  }
  return undefined
}

/**
 * All busy attribute occurrences, ANYWHERE on a line.
 *
 * The first version anchored to `^(isBusy|isStreaming)=` on the trimmed line, so
 * a prop written on the JSX opening tag — `<InputBar isBusy={!isIdle}` — was
 * invisible and the suite passed. Twice now this guard has been caught treating
 * "cannot see it" as "nothing to check"; matching the attribute wherever it
 * appears, and reporting anything unreadable, is the fix for both.
 */
function busyPropSites(): PropSite[] {
  const sites: PropSite[] = []
  for (const { line, text } of codeLines()) {
    const re = /\b(isBusy|isStreaming)=/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const value = readValue(text, m.index + m[0].length)
      if (value !== undefined) {
        sites.push({ line, name: m[1]!, value, text: text.trim() })
      }
    }
  }
  return sites
}

/** Is this site covered by a written exemption in the lines just above it? */
function isExempt(line: number): boolean {
  const all = readFileSync(APP_TSX, 'utf8').split('\n')
  const from = Math.max(0, line - 1 - EXEMPT_LOOKBACK)
  return all.slice(from, line).some(l => l.includes(EXEMPT_MARKER))
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

  it('every busy attribute parses — an unreadable site is an error, not a skip', () => {
    // Two mutations have now exploited the gap this closes: a value containing
    // spaces (the `(\S+)` regex), and a prop on the JSX opening line (the
    // `^`-anchored match). Both made a site vanish from `sites`, so every rule
    // below simply never saw it.
    const parsed = new Set(sites.map(s => s.line))
    const unreadable = busyPropLines()
      .filter(l => !parsed.has(l.line))
      .map(l => `App.tsx:${l.line}  ${l.text.trim()}`)
    expect(
      unreadable,
      `these lines carry a busy attribute whose value could not be read, so no rule ` +
        `was applied to them:\n  ${unreadable.join('\n  ')}`,
    ).toEqual([])
  })

  it('every busy prop reads the shared derivation, or is a WRITTEN inert exemption', () => {
    const offenders = sites
      .filter(s => !DERIVED.has(s.value))
      .filter(s => !(s.value === '{false}' && isExempt(s.line)))
      .map(s => `App.tsx:${s.line}  ${s.name}=${s.value}`)
    expect(
      offenders,
      'each isBusy=/isStreaming= prop must come from `busyProps` (inputBarBusyProps). ' +
        `A site may be hardcoded {false} only with a '${EXEMPT_MARKER} <reason>' comment above ` +
        'it — and never to anything else, since an inline predicate is what #7378 removed:\n  ' +
        offenders.join('\n  '),
    ).toEqual([])
  })

  it('exemptions stay rare and inert', () => {
    // Only the static system pane has a reason to be inert. This is a deliberate
    // cap on a set that should NOT grow quietly: raising it should take an
    // argument, not a copy-paste.
    const exempt = sites.filter(s => s.value === '{false}' && isExempt(s.line))
    expect(exempt.every(s => s.value === '{false}')).toBe(true)
    expect(
      exempt.length,
      `exempt busy props: ${exempt.map(s => `App.tsx:${s.line} ${s.name}`).join(', ')}`,
    ).toBeLessThanOrEqual(2)
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
