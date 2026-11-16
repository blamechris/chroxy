/**
 * #8596 — the transcript publishes its bottom edge (viewport clientHeight minus
 * rect.bottom) as --toast-bottom-offset so the toast stack rests on it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { StrictMode, useRef, useState } from 'react'
import { useToastBottomOffset } from './useToastBottomOffset'
import { ChatView } from './ChatView'

const VAR = '--toast-bottom-offset'
const get = () => document.documentElement.style.getPropertyValue(VAR)
type RO = { cb: () => void; observed: Element[]; disconnect: ReturnType<typeof vi.fn> }
let instances: RO[]
/** Rect bottom per element's data-testid, falling back to a layout derived from panels below. */
let bottomOf: (el: Element) => number
/** testids of elements with no layout box (display:none). */
let hidden: Set<string>
const isHidden = (el: Element) => hidden.has(el.getAttribute('data-testid') ?? '')

beforeEach(() => {
  instances = []
  hidden = new Set()
  bottomOf = () => 700
  class FakeRO {
    cb: () => void
    observed: Element[] = []
    disconnect = vi.fn()
    constructor(cb: () => void) { this.cb = cb; instances.push(this as unknown as RO) }
    observe(e: Element) { this.observed.push(e) }
  }
  vi.stubGlobal('ResizeObserver', FakeRO)
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800)
  // innerHeight deliberately different: the offset must use clientHeight.
  Object.defineProperty(window, 'innerHeight', { value: 9999, configurable: true })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (isHidden(this) ? [] : [{}]) as unknown as DOMRectList
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (isHidden(this)) return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    const b = bottomOf(this)
    return { top: b - 100, bottom: b, height: 100, left: 0, right: 0, width: 0, x: 0, y: b - 100, toJSON: () => ({}) } as DOMRect
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.style.removeProperty(VAR)
})

function Transcript({ id = 'transcript' }: { id?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useToastBottomOffset(ref)
  return <div ref={ref} data-testid={id} />
}

/** A flex column like the app: a panel mounted below the transcript shrinks it. */
function Column() {
  const [panel, setPanel] = useState(false)
  return (
    <div>
      <Transcript />
      {panel && <div data-testid="panel" />}
      <button data-testid="toggle" onClick={() => setPanel((p) => !p)} />
    </div>
  )
}

describe('useToastBottomOffset (#8596)', () => {
  it('publishes clientHeight - transcript bottom (not innerHeight), republishes on RO + window resize', () => {
    render(<Transcript />)
    expect(get()).toBe('100px')
    bottomOf = () => 650
    instances[0]!.cb()
    expect(get()).toBe('150px')
    bottomOf = () => 600
    window.dispatchEvent(new Event('resize'))
    expect(get()).toBe('200px')
  })

  it('observes the transcript element and nothing else', () => {
    const { getByTestId } = render(<Transcript />)
    expect(instances).toHaveLength(1)
    expect(instances[0]!.observed).toEqual([getByTestId('transcript')])
  })

  it('a hidden (no layout box) instance never sets the offset', () => {
    hidden = new Set(['transcript'])
    render(<Transcript />)
    expect(get()).toBe('')
  })

  it('all hidden -> variable removed (even after having been set)', () => {
    render(<Transcript />)
    expect(get()).toBe('100px')
    hidden = new Set(['transcript'])
    instances[0]!.cb()
    expect(get()).toBe('')
  })

  it('hidden -> visible transition republishes', () => {
    hidden = new Set(['transcript'])
    render(<Transcript />)
    expect(get()).toBe('')
    hidden = new Set()
    instances[0]!.cb()
    expect(get()).toBe('100px')
  })

  it('one hidden + one visible: the visible one wins regardless of registration and callback order', () => {
    function Pair({ order }: { order: 'hf' | 'fh' }) {
      return order === 'hf' ? <><Transcript id="h" /><Transcript id="v" /></> : <><Transcript id="v" /><Transcript id="h" /></>
    }
    hidden = new Set(['h'])
    bottomOf = (el) => (el.getAttribute('data-testid') === 'v' ? 600 : 700)
    for (const order of ['hf', 'fh'] as const) {
      const { unmount } = render(<Pair order={order} />)
      expect(get()).toBe('200px')
      for (const i of instances) { i.cb(); expect(get()).toBe('200px') } // any callback order
      for (const i of [...instances].reverse()) { i.cb(); expect(get()).toBe('200px') }
      window.dispatchEvent(new Event('resize'))
      expect(get()).toBe('200px')
      unmount()
      instances = []
    }
  })

  it('vertically stacked transcripts: the bottom-most wins', () => {
    function Stack() { return <><Transcript id="top" /><Transcript id="low" /></> }
    bottomOf = (el) => (el.getAttribute('data-testid') === 'low' ? 750 : 400)
    render(<Stack />)
    expect(get()).toBe('50px')
  })

  it('a panel mounted below the transcript shifts the offset through the layout callback', () => {
    const { getByTestId, queryByTestId } = render(<Column />)
    expect(get()).toBe('100px')
    // mounting the panel resizes the transcript (flex column): its bottom moves up 120px
    fireEvent.click(getByTestId('toggle'))
    bottomOf = (el) => (queryByTestId('panel') && el.getAttribute('data-testid') === 'transcript' ? 580 : 700)
    instances[0]!.cb()
    expect(get()).toBe('220px')
  })

  it('removes the variable and stops listening on unmount', () => {
    const { unmount } = render(<Transcript />)
    unmount()
    expect(instances[0]!.disconnect).toHaveBeenCalledTimes(1)
    expect(get()).toBe('')
    window.dispatchEvent(new Event('resize'))
    expect(get()).toBe('')
  })

  it("one instance's unmount does not clobber another's value (split mode)", () => {
    function Two({ showB }: { showB: boolean }) {
      return <><Transcript id="a" />{showB && <Transcript id="b" />}</>
    }
    bottomOf = (el) => (el.getAttribute('data-testid') === 'b' ? 500 : 700)
    const { rerender } = render(<Two showB />)
    expect(get()).toBe('100px') // a (bottom 700) is bottom-most
    rerender(<Two showB={false} />)
    expect(get()).toBe('100px') // survivor still published, variable not removed
    rerender(<></>)
    expect(get()).toBe('')
  })

  it('survives StrictMode: variable set, one live observer, cleaned on unmount', () => {
    const { unmount } = render(<StrictMode><Transcript /></StrictMode>)
    expect(get()).toBe('100px')
    expect(instances.filter((i) => i.disconnect.mock.calls.length === 0)).toHaveLength(1)
    unmount()
    expect(get()).toBe('')
  })

  it('publishes nothing without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    render(<Transcript />)
    expect(get()).toBe('')
  })

  it('ChatView inside a display:none wrapper does not publish', () => {
    hidden = new Set(['chat-view'])
    render(<div style={{ display: 'none' }}><ChatView messages={[]} isStreaming={false} /></div>)
    expect(get()).toBe('')
  })

  it('ChatView wires it onto its .chat-view root', () => {
    const { getByTestId, unmount } = render(<ChatView messages={[]} isStreaming={false} />)
    expect(get()).toBe('100px')
    expect(instances[0]!.observed).toContain(getByTestId('chat-view'))
    unmount()
    expect(get()).toBe('')
  })
})
