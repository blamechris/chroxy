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

beforeEach(() => {
  instances = []
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
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
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

  it('observes only the transcript element', () => {
    const { getByTestId } = render(<Transcript />)
    expect(instances).toHaveLength(1)
    expect(instances[0]!.observed).toEqual([getByTestId('transcript')])
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
    expect(get()).toBe('300px') // b published last
    rerender(<Two showB={false} />)
    expect(get()).toBe('100px') // survivor a republished, variable not removed
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

  it('ChatView wires it onto its .chat-view root', () => {
    const { getByTestId, unmount } = render(<ChatView messages={[]} isStreaming={false} />)
    expect(get()).toBe('100px')
    expect(instances[0]!.observed).toContain(getByTestId('chat-view'))
    unmount()
    expect(get()).toBe('')
  })
})
