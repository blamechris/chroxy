/**
 * #7466 — the Devices / Snapshots panels must fetch ONCE on mount, not forever.
 *
 * These two panels hoist a `resolvedFetch` fallback for testability:
 *
 *     const resolvedFetch = fetchImpl ?? ((input, init) => window.fetch(input, init))
 *     const refresh = useCallback(..., [resolvedFetch, resolvedGetToken])
 *     useEffect(() => { void refresh() }, [refresh])
 *
 * When `fetchImpl` is omitted — which is exactly what production does
 * (`<PairedDevicesPanel />` / `<SnapshotsPanel />` in App.tsx) — the `??`
 * allocates a FRESH arrow every render, so `refresh` gets a new identity every
 * render, so the mount effect re-fires every render, so `refresh` sets state,
 * which renders again. An unbounded fetch/render loop that flashes the panel
 * header's "Loading…"/"Refresh" label.
 *
 * Every pre-existing test in PairedDevicesPanel.test.tsx / SnapshotsPanel.test.tsx
 * passes `fetchImpl` as a prop, which pins the identity and hides the loop
 * completely — the guard was false-safe because the tests never rendered the
 * shape that ships. These tests render the PRODUCTION shape (no props) and are
 * StrictMode-honest: production mounts under `<StrictMode>` (main.tsx), whose
 * deliberate mount/unmount/remount doubles the legitimate mount fetch to two.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { StrictMode, useState } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { PairedDevicesPanel } from './PairedDevicesPanel'
import { SnapshotsPanel } from './SnapshotsPanel'

/**
 * Yield to the macrotask queue repeatedly. A render→effect→fetch→setState cycle
 * needs one full turn per iteration, so N turns give a runaway loop N chances to
 * re-arm. 25 is far more than the 1 (or 2 under StrictMode) legitimate mount
 * fetches, and keeps the test sub-second.
 */
async function settle(turns = 25) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function installFetchSpy(payload: Record<string, unknown>) {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  const original = window.fetch
  // The panels call `window.fetch` explicitly, so stub that (not just the global).
  Object.defineProperty(window, 'fetch', { value: spy, writable: true, configurable: true })
  return {
    spy,
    restore: () => {
      Object.defineProperty(window, 'fetch', { value: original, writable: true, configurable: true })
    },
  }
}

/**
 * A parent that re-renders its child on demand. Re-rendering a parent is the
 * OTHER way an unstable dep reaches the child — the loop tests above only
 * exercise the child re-rendering itself. These two cases pin the bound: a bump
 * that changes nothing must cost zero fetches, and a bump that genuinely swaps
 * the token resolver must cost exactly ONE, not an unbounded run.
 */
function Bumper({ children }: { children: (n: number) => React.ReactNode }) {
  const [n, setN] = useState(0)
  return (
    <div>
      <button type="button" data-testid="bump" onClick={() => setN((v) => v + 1)}>
        bump
      </button>
      {children(n)}
    </div>
  )
}

describe('#7466 — panels rendered the way production renders them do not refetch in a loop', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('PairedDevicesPanel with no props fetches once and stops', async () => {
    const { spy, restore } = installFetchSpy({ devices: [] })
    try {
      render(<PairedDevicesPanel />)
      await settle()
      expect(spy.mock.calls.length).toBe(1)
    } finally {
      restore()
    }
  })

  it('PairedDevicesPanel under StrictMode fetches exactly twice (the double mount) and stops', async () => {
    const { spy, restore } = installFetchSpy({ devices: [] })
    try {
      render(
        <StrictMode>
          <PairedDevicesPanel />
        </StrictMode>,
      )
      await settle()
      expect(spy.mock.calls.length).toBe(2)
    } finally {
      restore()
    }
  })

  it('SnapshotsPanel with no props fetches once and stops', async () => {
    const { spy, restore } = installFetchSpy({ snapshots: [] })
    try {
      render(<SnapshotsPanel />)
      await settle()
      expect(spy.mock.calls.length).toBe(1)
    } finally {
      restore()
    }
  })

  it('SnapshotsPanel under StrictMode fetches exactly twice (the double mount) and stops', async () => {
    const { spy, restore } = installFetchSpy({ snapshots: [] })
    try {
      render(
        <StrictMode>
          <SnapshotsPanel />
        </StrictMode>,
      )
      await settle()
      expect(spy.mock.calls.length).toBe(2)
    } finally {
      restore()
    }
  })

  it('a parent re-render does not re-arm the mount fetch (production shape, no props)', async () => {
    const { spy, restore } = installFetchSpy({ devices: [] })
    try {
      render(<Bumper>{() => <PairedDevicesPanel />}</Bumper>)
      await settle()
      expect(spy.mock.calls.length).toBe(1)
      fireEvent.click(document.querySelector('[data-testid="bump"]')!)
      fireEvent.click(document.querySelector('[data-testid="bump"]')!)
      await settle()
      expect(spy.mock.calls.length).toBe(1)
    } finally {
      restore()
    }
  })

  it('a parent re-render passing a fresh inline getToken does not re-arm the mount fetch', async () => {
    const { spy, restore } = installFetchSpy({ devices: [] })
    try {
      // A NEW arrow every parent render, so `refresh` legitimately re-arms once
      // per bump. The point is the CEILING: with `resolvedFetch` unmemoized this
      // same input ran away to 35 fetches in 25 macrotask turns.
      render(<Bumper>{(n) => <PairedDevicesPanel getToken={() => `tok-${n}`} />}</Bumper>)
      await settle()
      expect(spy.mock.calls.length).toBe(1)
      fireEvent.click(document.querySelector('[data-testid="bump"]')!)
      await settle()
      // One extra fetch: the resolver prop genuinely changed (tok-0 -> tok-1), so
      // re-reading the roster with the new credential is correct. What must NOT
      // happen is an unbounded run — 25 macrotask turns produce exactly one.
      expect(spy.mock.calls.length).toBe(2)
    } finally {
      restore()
    }
  })

  it('a CHANGING fetchImpl prop re-arms exactly once — the resolver tracks the prop', async () => {
    // The mirror of the getToken control above, and the input that was missing:
    // nothing proved `resolvedFetch` tracks a changing `fetchImpl`. While the
    // fallback was a `useMemo`, mutating its dep list from `[fetchImpl]` to `[]`
    // left the whole suite green at 17 passed / exit 0. The module-level constant
    // makes that mutant unwritable, but "unwritable" is not "unnecessary" — this
    // pins the behaviour the dep list was supposed to defend, so a future edit
    // that reintroduces a wrapper cannot silently drop it.
    const { restore } = installFetchSpy({ devices: [] })
    try {
      const calls: number[] = []
      const makeFetch = (n: number) =>
        (async () => {
          calls.push(n)
          return new Response(JSON.stringify({ devices: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }) as unknown as typeof fetch

      render(<Bumper>{(n) => <PairedDevicesPanel fetchImpl={makeFetch(n)} />}</Bumper>)
      await settle()
      expect(calls).toEqual([0])

      fireEvent.click(document.querySelector('[data-testid="bump"]')!)
      await settle()
      // Tracked the new prop (n=1 fetched, not n=0 again) and stopped there.
      expect(calls).toEqual([0, 1])

      fireEvent.click(document.querySelector('[data-testid="bump"]')!)
      await settle()
      expect(calls).toEqual([0, 1, 2])
    } finally {
      restore()
    }
  })
})
