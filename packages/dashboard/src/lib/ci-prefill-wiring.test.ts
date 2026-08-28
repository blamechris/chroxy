/**
 * #7423 — the CI prefill must actually be WIRED, not merely implemented.
 *
 * `onPrefill` is optional on `SessionCiChipProps` and `onPrefillSessionPrStatus`
 * is optional on `AppHeaderProps` — deliberately, so the chip is usable without
 * the action. The cost of that is that deleting either wiring line **type-checks
 * and leaves the whole suite green while the button silently disappears**: the
 * chip renders, every unit test that passes `onPrefill` directly still passes,
 * and nothing observes the App-level composition. That is the "a guard wired to
 * only some of its callers" shape in `docs/false-safety-guards.md` — correct for
 * every input it sees, never reached by the real one.
 *
 * So this file pins the composition itself, in the same spirit as
 * `input-bar-busy-wiring.test.ts` (#7378) and `hooks/notificationPermissionWiring.test.ts`.
 *
 * ANCHORED, not a file-wide grep. Each assertion slices the region it cares
 * about — the `<SessionCiChip …>` element in AppHeader, the `<AppHeader …>`
 * element in App.tsx, the `runCiPrefill` call's effects bag — and asserts within
 * it. A whole-file search for `onPrefill` would be satisfiable by the prop
 * declaration alone, which is exactly the line that survives deleting the wiring.
 *
 * Every assertion collapses to a boolean before comparing, never
 * `expect(src).toMatch(...)`: a failing match against a 2,400-line source file
 * carries the entire file as the error payload, which has wedged the runner
 * elsewhere in this repo (#7340).
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Resolved RELATIVE TO THIS FILE, matching the package's other source-level
// wiring guards. `process.cwd()` would make the guard depend on where the runner
// was invoked from.
const APP_TSX = path.resolve(__dirname, '..', 'App.tsx')
const APP_HEADER_TSX = path.resolve(__dirname, '..', 'components', 'AppHeader.tsx')

function read(file: string): string {
  expect(existsSync(file), `${file} should exist`).toBe(true)
  return readFileSync(file, 'utf8')
}

/**
 * The text of the first JSX element opening with `<${tag}`, up to its closing
 * `/>`. Returns null when the element is absent — which the callers assert on,
 * so a renamed component fails loudly instead of scanning an empty string and
 * passing.
 */
function jsxElement(src: string, tag: string): string | null {
  const start = src.indexOf(`<${tag}`)
  if (start === -1) return null
  const end = src.indexOf('/>', start)
  if (end === -1) return null
  return src.slice(start, end + 2)
}

describe('#7423 CI prefill wiring', () => {
  it('AppHeader passes onPrefill to SessionCiChip', () => {
    const element = jsxElement(read(APP_HEADER_TSX), 'SessionCiChip')
    expect(element, 'AppHeader should render a <SessionCiChip … /> element').not.toBeNull()
    expect(element!.includes('onPrefill={props.onPrefillSessionPrStatus}')).toBe(true)
  })

  it('positive control: the slice is the element, not the whole file', () => {
    // If `jsxElement` ever returned the entire source, the assertion above would
    // pass on the prop DECLARATION alone — the one line that survives deleting
    // the wiring. Pin that it does not reach the declaration.
    const element = jsxElement(read(APP_HEADER_TSX), 'SessionCiChip')!
    expect(element.includes('onPrefillSessionPrStatus?: () => void')).toBe(false)
    expect(element.length).toBeLessThan(600)
  })

  it('App.tsx passes a handler to AppHeader', () => {
    const element = jsxElement(read(APP_TSX), 'AppHeader')
    expect(element, 'App.tsx should render an <AppHeader … /> element').not.toBeNull()
    expect(element!.includes('onPrefillSessionPrStatus={handlePrefillSessionPrStatus}')).toBe(true)
  })

  it('the handler calls runCiPrefill with every effect the helper needs', () => {
    const src = read(APP_TSX)
    const start = src.indexOf('const handlePrefillSessionPrStatus')
    expect(start, 'App.tsx should define handlePrefillSessionPrStatus').toBeGreaterThan(-1)
    // Bounded by the next top-level `const`-with-comment boundary rather than
    // the file end, so the assertions below cannot be satisfied by an unrelated
    // callback further down.
    const body = src.slice(start, start + 900)

    // The helper is CALLED — a handler that formatted the line itself would
    // bypass the draft-clobber guard entirely.
    expect(body.includes('runCiPrefill(sessionPrStatus, {')).toBe(true)
    // Both halves of the draft write. Dropping the ref write leaves the staged
    // text invisible to the session-switch restore effect, so switching tabs and
    // back would silently discard it.
    expect(body.includes('inputDraftsRef.current.set(activeSessionId, next)')).toBe(true)
    expect(body.includes('setInputDraftValue(next)')).toBe(true)
    // The stale-line refresh path. Without `getLastStaged` every second click
    // refuses, and the composer keeps a reading the chip has superseded.
    expect(body.includes('getLastStaged:')).toBe(true)
    expect(body.includes('ciPrefillStagedRef.current.set(activeSessionId, next)')).toBe(true)
    // The refusal has to reach the user; a silent no-op reads as a broken button.
    expect(body.includes('notify: addInfoNotification')).toBe(true)
  })

  it('the staged-line ref obeys the #3977 per-session eviction invariant', () => {
    const src = read(APP_TSX)
    const start = src.indexOf('const evictSessionComposerState')
    expect(start, 'App.tsx should define evictSessionComposerState').toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('}', start) + 1)
    // Unbounded growth over a long-lived dashboard process is the failure this
    // invariant exists to prevent.
    expect(body.includes('ciPrefillStagedRef.current.delete(sessionId)')).toBe(true)
  })
})
