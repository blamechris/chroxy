/**
 * useSidebarTreeFlow (#8888) — geometry is stubbed (jsdom lays nothing out), so
 * this pins the decision rule and its stability; sidebar-layout.test.mjs is the
 * live proof in a real browser.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { useRef } from 'react'
import { useSidebarTreeFlow } from './useSidebarTreeFlow'

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(public cb: ResizeObserverCallback) { FakeResizeObserver.instances.push(this) }
  observe(el: Element) { this.disconnected = false; this.observed.push(el) }
  unobserve() {}
  // Like the real one: disconnect drops every target; observe starts again.
  disconnect() { this.disconnected = true; this.observed = [] }
  fire() { this.cb([], this as unknown as ResizeObserver) }
}

type Geometry = { clientHeight: number, scrollHeight: number, treeHeight: number }
let geo: Geometry = { clientHeight: 0, scrollHeight: 0, treeHeight: 0 }

// jsdom lays nothing out: serve the heights from `geo`, by element.
function stubGeometry() {
  const id = (el: HTMLElement) => el.getAttribute('data-testid')
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return id(this) === 'col' ? geo.clientHeight : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return id(this) === 'col' ? geo.scrollHeight : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return id(this) === 'tree' ? geo.treeHeight : 0 } })
}

function Harness({ mounted = true }: { mounted?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const flow = useSidebarTreeFlow(scrollRef, treeRef, mounted)
  return (
    <div ref={scrollRef} data-testid="col">
      <div>other</div>
      <div ref={treeRef} data-testid="tree" className={flow ? 'flow' : 'boxed'} />
      <div>footer</div>
    </div>
  )
}

afterEach(() => {
  cleanup()
  FakeResizeObserver.instances.length = 0
  vi.unstubAllGlobals()
  for (const k of ['clientHeight', 'scrollHeight', 'offsetHeight']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]
})

// The tree floor falls back to 96 (no stylesheet in this file).
function setup(geometry: Geometry) {
  geo = geometry
  stubGeometry()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  const view = render(<Harness />)
  const tree = view.getByTestId('tree')
  const fire = () => act(() => { FakeResizeObserver.instances.forEach(o => o.fire()) })
  return { tree, fire, view }
}

describe('useSidebarTreeFlow', () => {
  it('flows when the column overflows with the tree at its floor', () => {
    const { tree } = setup({ clientHeight: 400, scrollHeight: 900, treeHeight: 96 })
    // need = 900 - 96 + 96 = 900 > 400
    expect(tree.className).toBe('flow')
  })

  it('stays boxed when the column fits', () => {
    const { tree } = setup({ clientHeight: 1000, scrollHeight: 1000, treeHeight: 600 })
    // need = 1000 - 600 + 96 = 496 <= 1000
    expect(tree.className).toBe('boxed')
  })

  it('does not oscillate: the same window gives the same answer from the flow state', () => {
    const { tree, fire } = setup({ clientHeight: 400, scrollHeight: 900, treeHeight: 96 })
    expect(tree.className).toBe('flow')
    // Flowing, the tree is content height (700) and the column scrolls by the
    // same amount more; the other sections are unchanged, so need is unchanged.
    geo = { clientHeight: 400, scrollHeight: 900 - 96 + 700, treeHeight: 700 }
    fire()
    fire()
    expect(tree.className).toBe('flow')
    // The window grows until the others plus the floor fit: boxed, and stays.
    geo = { clientHeight: 1200, scrollHeight: 1200, treeHeight: 700 }
    fire()
    fire()
    expect(tree.className).toBe('boxed')
  })

  it('observes the column and each child, and disconnects on unmount', () => {
    const { view } = setup({ clientHeight: 400, scrollHeight: 900, treeHeight: 96 })
    const ro = FakeResizeObserver.instances[0]!
    expect(ro.observed.length).toBe(4) // the column + its three children
    view.unmount()
    expect(FakeResizeObserver.instances.every(o => o.disconnected)).toBe(true)
  })

  it('evaluates once without ResizeObserver (jsdom) and does not throw', () => {
    geo = { clientHeight: 400, scrollHeight: 900, treeHeight: 96 }
    stubGeometry()
    vi.stubGlobal('ResizeObserver', undefined)
    const view = render(<Harness />)
    expect(view.getByTestId('tree').className).toBe('flow') // the one-shot evaluation ran
  })

  it('uses the floor-adjusted rule, not the raw scrollHeight (a naive rule would flow here)', () => {
    // client 1000, scroll 1504, tree 700: need = 1504 - 700 + 96 = 900 <= 1000.
    // The raw scrollHeight (1504) would say flow although the others fit.
    const { tree } = setup({ clientHeight: 1000, scrollHeight: 1504, treeHeight: 700 })
    expect(tree.className).toBe('boxed')
  })

  it('observes a child added after mount (sections mount and unmount)', async () => {
    const { view } = setup({ clientHeight: 400, scrollHeight: 900, treeHeight: 96 })
    const col = view.getByTestId('col')
    const extra = document.createElement('div')
    await act(async () => { col.appendChild(extra); await Promise.resolve() })
    const observed = FakeResizeObserver.instances.flatMap(o => (o.disconnected ? [] : o.observed))
    expect(observed.includes(extra)).toBe(true)
  })

  it('re-runs when `mounted` flips', () => {
    geo = { clientHeight: 400, scrollHeight: 900, treeHeight: 96 }
    stubGeometry()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const view = render(<Harness mounted={false} />)
    const before = FakeResizeObserver.instances.length
    view.rerender(<Harness mounted />)
    expect(FakeResizeObserver.instances.length).toBe(before + 1)
  })

  it('stays boxed when the column has no height (not laid out)', () => {
    const { tree } = setup({ clientHeight: 0, scrollHeight: 0, treeHeight: 0 })
    expect(tree.className).toBe('boxed')
  })
})
