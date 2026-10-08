/**
 * #8404 — the three IDE palettes settle after a transport drop instead of
 * spinning, and re-ask once the connection is back.
 *
 * #8402 made `socket.onclose` clear every `*Loading` flag. The palettes' spinner
 * condition is not the flag alone — `loading || !isCurrent` (references, code
 * search) and `loading || symbols === null` (symbol search) — and a reply that
 * was in flight when the socket died never arrives, so `isCurrent` / `symbols`
 * stayed false/null and the palette kept saying "Searching…" / "Indexing
 * symbols…" until it was reopened.
 *
 * ## What is driven, and what is not
 *
 * The REAL store and the REAL palettes. A request goes out through the store's
 * own sender on a mock socket that is OPEN, the drop is the socket's own
 * `onclose` (the handler `connect()` installed), and the reconnect is the store
 * reaching phase 'connected' on a fresh socket. Nothing in the store is mocked,
 * so the flag that clears and the phase that gates the palette are the
 * production ones. The reply is fed through the socket's `onmessage`, the
 * production wire path.
 *
 * The spinner is asserted by its TEXT, which is the whole of what the user sees
 * (there is no spinner element), and each cell first asserts the spinner IS up
 * before the drop, so a "no spinner afterwards" cell cannot pass because the
 * palette never spun in the first place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

const lsStore: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: vi.fn((key: string) => lsStore[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { lsStore[key] = value }),
    removeItem: vi.fn((key: string) => { delete lsStore[key] }),
    clear: vi.fn(() => { for (const k of Object.keys(lsStore)) delete lsStore[k] }),
    get length() { return Object.keys(lsStore).length },
    key: vi.fn((i: number) => Object.keys(lsStore)[i] ?? null),
  },
  writable: true,
})
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  url: string
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3 }
  /** Wire messages of one type this socket has been asked to send. */
  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((m) => m.type === type)
  }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
  ok: true, status: 200, json: async () => ({ status: 'ok' }),
}))

const { useConnectionStore } = await import('../store/connection')
const { resetReconnectAttempt } = await import('../store/message-handler')
const { ReferencesPalette } = await import('./ReferencesPalette')
const { CodeSearchPalette } = await import('./CodeSearchPalette')
const { SymbolSearchPalette } = await import('./SymbolSearchPalette')

type State = ReturnType<typeof useConnectionStore.getState>

/** Open a connection and return the freshly constructed socket, adopted as the live one. */
async function openConnected(): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect('wss://tunnel.example.com/ws', 'tok')
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.readyState = 1
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  // The store adopts the socket on `auth_ok`; the handshake is not what is under
  // test, so install it directly (the senders gate on `get().socket` being OPEN).
  useConnectionStore.setState({ socket: ws as unknown as WebSocket, connectionPhase: 'connected', userDisconnected: false })
  return ws
}

/**
 * The store's own reconnect: the close armed a retry timer, which builds a fresh
 * socket through `connect()`; adopt it as authenticated the way `openConnected` does.
 */
async function reconnect(): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  const ws = MockWebSocket.instances[before]
  if (!ws) throw new Error('the drop armed no reconnect attempt, so the test would prove nothing about reconnecting')
  await act(async () => {
    ws.readyState = 1
    ws.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    useConnectionStore.setState({ socket: ws as unknown as WebSocket, connectionPhase: 'connected', userDisconnected: false })
  })
  return ws
}

const reply = (ws: MockWebSocket, msg: Record<string, unknown>): void => {
  act(() => { ws.onmessage?.({ data: JSON.stringify(msg) }) })
}

const SPINNER_TEXT = /Searching…|Indexing symbols…/

const RESET: Partial<State> = {
  workspaceSymbols: null, workspaceSymbolsLoading: false,
  codeSearchResults: null, codeSearchLoading: false,
  referencesResult: null, referencesSymbol: '', referencesLoading: false, referencesOpen: false,
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  useConnectionStore.setState({ socket: null, connectionPhase: 'disconnected', userDisconnected: false, serverCapabilities: { ide: true }, ...RESET } as Partial<State>)
})

afterEach(() => {
  cleanup()
  useConnectionStore.getState().disconnect()
  useConnectionStore.setState({ ...RESET } as Partial<State>)
  vi.useRealTimers()
})

const REFERENCES_REPLY = {
  type: 'references_result', symbol: 'widget', truncated: false, error: null,
  results: [{ file: 'src/a.ts', line: 3, column: 7, text: 'const widget = 1' }],
}
const SEARCH_REPLY = {
  type: 'code_search_results', query: 'target', truncated: false, error: null,
  results: [{ file: 'src/a.ts', line: 3, column: 7, text: 'const target = 1' }],
}
const SYMBOLS_REPLY = {
  type: 'symbols_snapshot', path: null, truncated: false, error: null,
  symbols: [{ name: 'Widget', kind: 'class', file: 'src/ui/Widget.tsx', line: 10, exported: true }],
}

describe('#8404 ReferencesPalette after a transport drop', () => {
  it('settles to an offline state instead of "Searching…", then re-asks and renders on reconnect', async () => {
    const ws = await openConnected()
    act(() => { useConnectionStore.getState().requestFindReferences('widget', 'src/a.ts') })
    render(<ReferencesPalette isOpen onClose={() => {}} />)
    expect(ws.sentOfType('find_references').length, 'control: the request went out').toBe(1)
    expect(screen.getByText(SPINNER_TEXT), 'control: spinning before the drop').toBeTruthy()

    act(() => { ws.onclose?.({ code: 1006 }) })
    expect(useConnectionStore.getState().referencesLoading, 'control: #8402 cleared the flag').toBe(false)
    expect(screen.queryByText(SPINNER_TEXT), 'still spinning after the drop').toBeNull()
    expect(screen.getByTestId('references-offline')).toBeTruthy()
    expect(screen.queryByTestId('references-empty'), 'a lost request is not "no references"').toBeNull()

    const ws2 = await reconnect()
    expect(ws2.sentOfType('find_references').map((m) => m.symbol), 'the request is re-issued once').toEqual(['widget'])
    expect(screen.getByText(SPINNER_TEXT)).toBeTruthy()
    expect(screen.queryByTestId('references-offline')).toBeNull()

    reply(ws2, REFERENCES_REPLY)
    expect(screen.getByTestId('references-item-0')).toBeTruthy()
    expect(screen.queryByText(SPINNER_TEXT)).toBeNull()
  })

  it('a result that already landed stays on screen through a drop', async () => {
    const ws = await openConnected()
    act(() => { useConnectionStore.getState().requestFindReferences('widget') })
    render(<ReferencesPalette isOpen onClose={() => {}} />)
    reply(ws, REFERENCES_REPLY)
    expect(screen.getByTestId('references-item-0')).toBeTruthy()
    act(() => { ws.onclose?.({ code: 1006 }) })
    expect(screen.getByTestId('references-item-0')).toBeTruthy()
    expect(screen.queryByTestId('references-offline')).toBeNull()
  })

  it('does not re-ask on a reconnect that happens while the palette is closed', async () => {
    const ws = await openConnected()
    act(() => { useConnectionStore.getState().requestFindReferences('widget') })
    const view = render(<ReferencesPalette isOpen onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    view.rerender(<ReferencesPalette isOpen={false} onClose={() => {}} />)
    const ws2 = await reconnect()
    expect(ws2.sentOfType('find_references')).toEqual([])
  })
})

describe('#8404 the retry is one-shot and does not change the connected behaviour', () => {
  it('closing and reopening the references palette after the reconnect does not re-ask again', async () => {
    const ws = await openConnected()
    act(() => { useConnectionStore.getState().requestFindReferences('widget') })
    const view = render(<ReferencesPalette isOpen onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('find_references').length, 'control: the one re-ask').toBe(1)
    view.rerender(<ReferencesPalette isOpen={false} onClose={() => {}} />)
    view.rerender(<ReferencesPalette isOpen onClose={() => {}} />)
    expect(ws2.sentOfType('find_references').length, 'the armed re-ask must be spent').toBe(1)
  })

  it('a reopen shows "Indexing symbols…" over the previous table while the rescan is in flight (#6476)', async () => {
    const ws = await openConnected()
    const view = render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    reply(ws, SYMBOLS_REPLY)
    expect(screen.queryByText(SPINNER_TEXT), 'control: the first scan landed').toBeNull()
    view.rerender(<SymbolSearchPalette isOpen={false} onClose={() => {}} />)
    view.rerender(<SymbolSearchPalette isOpen onClose={() => {}} />)
    expect(useConnectionStore.getState().workspaceSymbolsLoading, 'control: the reopen armed a rescan').toBe(true)
    expect(screen.getByText(SPINNER_TEXT)).toBeTruthy()
  })
})

describe('#8404 CodeSearchPalette after a transport drop', () => {
  async function typeQuery(q: string): Promise<void> {
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: q } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  }

  it('settles to an offline state instead of "Searching…", then re-asks the same query on reconnect', async () => {
    const ws = await openConnected()
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    await typeQuery('target')
    expect(ws.sentOfType('search_content').map((m) => m.query), 'control: the debounced request went out').toEqual(['target'])
    expect(screen.getByText(SPINNER_TEXT), 'control: spinning before the drop').toBeTruthy()

    act(() => { ws.onclose?.({ code: 1006 }) })
    expect(useConnectionStore.getState().codeSearchLoading, 'control: #8402 cleared the flag').toBe(false)
    expect(screen.queryByText(SPINNER_TEXT), 'still spinning after the drop').toBeNull()
    expect(screen.getByTestId('code-search-offline')).toBeTruthy()
    expect(screen.queryByTestId('code-search-empty'), 'a lost request is not "No matches"').toBeNull()

    const ws2 = await reconnect()
    expect(ws2.sentOfType('search_content').map((m) => m.query), 'the request is re-issued once').toEqual(['target'])
    expect(screen.getByText(SPINNER_TEXT)).toBeTruthy()

    reply(ws2, SEARCH_REPLY)
    expect(screen.getByTestId('code-search-item-0')).toBeTruthy()
    expect(screen.queryByText(SPINNER_TEXT)).toBeNull()
  })

  it('typing again while offline does not bring the spinner back, and the latest query is what is re-asked', async () => {
    const ws = await openConnected()
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    await typeQuery('target')
    act(() => { ws.onclose?.({ code: 1006 }) })
    await typeQuery('targets')
    expect(screen.queryByText(SPINNER_TEXT)).toBeNull()
    expect(screen.getByTestId('code-search-offline')).toBeTruthy()
    const ws2 = await reconnect()
    expect(ws2.sentOfType('search_content').map((m) => m.query)).toEqual(['targets'])
  })

  it('the short-query hint is unaffected by a drop', async () => {
    const ws = await openConnected()
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    expect(screen.getByTestId('code-search-hint')).toBeTruthy()
    expect(screen.queryByTestId('code-search-offline')).toBeNull()
  })
})

describe('#8404 SymbolSearchPalette after a transport drop', () => {
  it('settles to an offline state instead of "Indexing symbols…", then re-requests the scan on reconnect', async () => {
    const ws = await openConnected()
    render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    expect(ws.sentOfType('list_symbols').length, 'control: the scan was requested on open').toBe(1)
    expect(screen.getByText(SPINNER_TEXT), 'control: spinning before the drop').toBeTruthy()

    act(() => { ws.onclose?.({ code: 1006 }) })
    expect(useConnectionStore.getState().workspaceSymbolsLoading, 'control: #8402 cleared the flag').toBe(false)
    expect(useConnectionStore.getState().workspaceSymbols, 'control: no table ever arrived').toBeNull()
    expect(screen.queryByText(SPINNER_TEXT), 'still spinning after the drop').toBeNull()
    expect(screen.getByTestId('symbol-search-offline')).toBeTruthy()
    expect(screen.queryByTestId('symbol-search-empty'), 'a lost scan is not "No symbols"').toBeNull()

    const ws2 = await reconnect()
    expect(ws2.sentOfType('list_symbols').length, 'the scan is re-requested once').toBe(1)
    expect(screen.getByText(SPINNER_TEXT)).toBeTruthy()

    reply(ws2, SYMBOLS_REPLY)
    expect(screen.getByTestId('symbol-search-item-Widget')).toBeTruthy()
    expect(screen.queryByText(SPINNER_TEXT)).toBeNull()
  })

  it('a palette opened while already disconnected is offline, not "Indexing…", and loads on connect', async () => {
    render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    expect(screen.queryByText(SPINNER_TEXT)).toBeNull()
    expect(screen.getByTestId('symbol-search-offline')).toBeTruthy()
    const ws = await openConnected()
    expect(ws.sentOfType('list_symbols').length).toBe(1)
  })
})

describe('#8404 review: a close disarms the re-ask (close -> reconnect -> reopen sends only what the palette itself sends)', () => {
  it('symbol search: the reopen sends one list_symbols, not two', async () => {
    const ws = await openConnected()
    const view = render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    view.rerender(<SymbolSearchPalette isOpen={false} onClose={() => {}} />)
    const ws2 = await reconnect()
    expect(ws2.sentOfType('list_symbols'), 'a reconnect while closed sends nothing').toEqual([])
    view.rerender(<SymbolSearchPalette isOpen onClose={() => {}} />)
    expect(ws2.sentOfType('list_symbols').length, 'the open request plus a leaked re-ask would be 2').toBe(1)
  })

  it('references: the reopen sends nothing, so the click\'s file-ranked request is never overwritten', async () => {
    const ws = await openConnected()
    act(() => { useConnectionStore.getState().requestFindReferences('widget', 'src/a.ts') })
    expect(ws.sentOfType('find_references')[0]).toMatchObject({ symbol: 'widget', file: 'src/a.ts' })
    const view = render(<ReferencesPalette isOpen onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    view.rerender(<ReferencesPalette isOpen={false} onClose={() => {}} />)
    const ws2 = await reconnect()
    view.rerender(<ReferencesPalette isOpen onClose={() => {}} />)
    expect(ws2.sentOfType('find_references'), 'a leaked re-ask would arrive without the file').toEqual([])
  })

  it('code search: the reopen does not re-send the stale pre-close query', async () => {
    const ws = await openConnected()
    const view = render(<CodeSearchPalette isOpen onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'target' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    act(() => { ws.onclose?.({ code: 1006 }) })
    view.rerender(<CodeSearchPalette isOpen={false} onClose={() => {}} />)
    const ws2 = await reconnect()
    view.rerender(<CodeSearchPalette isOpen onClose={() => {}} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(ws2.sentOfType('search_content'), 'a leaked re-ask would carry the old query').toEqual([])
  })
})

describe('#8404 review: connected with nothing outstanding and a result that is not current is still "searching"', () => {
  it('references', async () => {
    await openConnected()
    act(() => { useConnectionStore.getState().requestFindReferences('widget') })
    render(<ReferencesPalette isOpen onClose={() => {}} />)
    act(() => {
      useConnectionStore.setState({
        referencesLoading: false,
        referencesResult: { type: 'references_result', symbol: 'other', truncated: false, error: null, results: [] },
      } as Partial<State>)
    })
    expect(screen.getByText(SPINNER_TEXT)).toBeTruthy()
    expect(screen.queryByTestId('references-empty')).toBeNull()
  })

  it('code search (the debounce window before the request goes out)', async () => {
    await openConnected()
    useConnectionStore.setState({
      codeSearchResults: { type: 'code_search_results', query: 'other', truncated: false, error: null, results: [] },
    } as Partial<State>)
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'target' } })
    expect(useConnectionStore.getState().codeSearchLoading, 'control: nothing sent yet').toBe(false)
    expect(screen.getByText(SPINNER_TEXT)).toBeTruthy()
    expect(screen.queryByTestId('code-search-empty')).toBeNull()
  })

  it('symbol search', async () => {
    await openConnected()
    render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    act(() => { useConnectionStore.setState({ workspaceSymbolsLoading: false } as Partial<State>) })
    expect(useConnectionStore.getState().workspaceSymbols, 'control: no table yet').toBeNull()
    expect(screen.getByText(SPINNER_TEXT)).toBeTruthy()
    expect(screen.queryByTestId('symbol-search-empty')).toBeNull()
  })
})

describe('#8404 review: a result that is already current is not re-asked, and stays on screen', () => {
  it('references', async () => {
    const ws = await openConnected()
    act(() => { useConnectionStore.getState().requestFindReferences('widget') })
    render(<ReferencesPalette isOpen onClose={() => {}} />)
    reply(ws, REFERENCES_REPLY)
    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('find_references')).toEqual([])
    expect(screen.getByTestId('references-item-0')).toBeTruthy()
  })

  it('code search', async () => {
    const ws = await openConnected()
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'target' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    reply(ws, SEARCH_REPLY)
    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('search_content')).toEqual([])
    expect(screen.getByTestId('code-search-item-0')).toBeTruthy()
  })

  it('symbol search', async () => {
    const ws = await openConnected()
    render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    reply(ws, SYMBOLS_REPLY)
    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('list_symbols')).toEqual([])
    expect(screen.getByTestId('symbol-search-item-Widget')).toBeTruthy()
  })
})

describe('#8404 review: a daemon that comes back with the IDE surface off is not asked, and does not leave a palette spinning', () => {
  const ideOff = (): void => { useConnectionStore.setState({ serverCapabilities: {} } as Partial<State>) }
  const ideOn = (): void => { act(() => { useConnectionStore.setState({ serverCapabilities: { ide: true } } as Partial<State>) }) }

  it('symbol search: offline while ide is off, asks once when it comes on', async () => {
    const ws = await openConnected()
    render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    ideOff()
    const ws2 = await reconnect()
    expect(ws2.sentOfType('list_symbols')).toEqual([])
    expect(screen.queryByText(SPINNER_TEXT)).toBeNull()
    expect(screen.getByTestId('symbol-search-ide-off')).toBeTruthy()
    ideOn()
    expect(ws2.sentOfType('list_symbols').length).toBe(1)
  })

  it('code search', async () => {
    const ws = await openConnected()
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'target' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    act(() => { ws.onclose?.({ code: 1006 }) })
    ideOff()
    const ws2 = await reconnect()
    expect(ws2.sentOfType('search_content')).toEqual([])
    expect(screen.queryByText(SPINNER_TEXT)).toBeNull()
    expect(screen.getByTestId('code-search-ide-off')).toBeTruthy()
  })

  it('references', async () => {
    const ws = await openConnected()
    act(() => { useConnectionStore.getState().requestFindReferences('widget') })
    render(<ReferencesPalette isOpen onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    ideOff()
    const ws2 = await reconnect()
    expect(ws2.sentOfType('find_references')).toEqual([])
    expect(screen.queryByText(SPINNER_TEXT)).toBeNull()
    expect(screen.getByTestId('references-ide-off')).toBeTruthy()
  })
})

/**
 * #8429 — a result can be "current" and stale. #8427 skipped the reconnect re-ask
 * whenever the palette already showed a current result, which suppressed the only
 * refresh in two cases: the request that was in flight at the drop, and the
 * request that was attempted while offline (the store's sender is a no-op on a
 * dead socket). The re-ask is now owed by what happened to the request, not by
 * how the stored result looks.
 */
describe('#8429 symbol search: a retained table does not hide an owed refresh', () => {
  it('reopened with a retained table, the refresh is in flight when the socket drops: reconnect re-asks once', async () => {
    const ws = await openConnected()
    const view = render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    reply(ws, SYMBOLS_REPLY)
    view.rerender(<SymbolSearchPalette isOpen={false} onClose={() => {}} />)
    view.rerender(<SymbolSearchPalette isOpen onClose={() => {}} />)
    expect(ws.sentOfType('list_symbols').length, 'control: the reopen asked for a refresh').toBe(2)
    expect(useConnectionStore.getState().workspaceSymbols, 'control: the old table is retained').not.toBeNull()

    act(() => { ws.onclose?.({ code: 1006 }) })
    expect(useConnectionStore.getState().workspaceSymbolsLoading, 'control: #8402 cleared the flag').toBe(false)
    const ws2 = await reconnect()
    expect(ws2.sentOfType('list_symbols').length, 'the lost refresh is re-asked, once').toBe(1)
    expect(screen.getByText(SPINNER_TEXT)).toBeTruthy()
    reply(ws2, SYMBOLS_REPLY)
    expect(screen.queryByText(SPINNER_TEXT)).toBeNull()
  })

  it('closed, dropped, reopened while offline: the open request was a no-op, so reconnect asks once', async () => {
    const ws = await openConnected()
    const view = render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    reply(ws, SYMBOLS_REPLY)
    view.rerender(<SymbolSearchPalette isOpen={false} onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    const sentBefore = ws.sentOfType('list_symbols').length
    view.rerender(<SymbolSearchPalette isOpen onClose={() => {}} />)
    expect(ws.sentOfType('list_symbols').length, 'control: nothing can go out on the dead socket').toBe(sentBefore)
    expect(useConnectionStore.getState().workspaceSymbols, 'control: the table is retained, so it looks current').not.toBeNull()

    const ws2 = await reconnect()
    expect(ws2.sentOfType('list_symbols').length, 'the refresh the open request owed is sent, once').toBe(1)
  })

  it('a table fetched and answered before the drop is still not re-asked (the #8427 intent)', async () => {
    const ws = await openConnected()
    const view = render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    reply(ws, SYMBOLS_REPLY)
    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('list_symbols')).toEqual([])
    view.rerender(<SymbolSearchPalette isOpen onClose={() => {}} />)
    expect(ws2.sentOfType('list_symbols'), 'one reconnect, no extra request').toEqual([])
    expect(screen.getByTestId('symbol-search-item-Widget')).toBeTruthy()
  })

  it('an attempt made while offline is forgotten when the palette closes (it does not fire on a later drop)', async () => {
    const ws = await openConnected()
    const view = render(<SymbolSearchPalette isOpen={false} onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    view.rerender(<SymbolSearchPalette isOpen onClose={() => {}} />)
    view.rerender(<SymbolSearchPalette isOpen={false} onClose={() => {}} />)
    const ws2 = await reconnect()
    view.rerender(<SymbolSearchPalette isOpen onClose={() => {}} />)
    expect(ws2.sentOfType('list_symbols').length, 'control: the reopen asked on its own').toBe(1)
    reply(ws2, SYMBOLS_REPLY)
    act(() => { ws2.onclose?.({ code: 1006 }) })
    const ws3 = await reconnect()
    expect(ws3.sentOfType('list_symbols'), 'the closed-over offline attempt was spent by the close').toEqual([])
  })

  it('an answered refresh is not owed after a later drop', async () => {
    const ws = await openConnected()
    const view = render(<SymbolSearchPalette isOpen onClose={() => {}} />)
    reply(ws, SYMBOLS_REPLY)
    view.rerender(<SymbolSearchPalette isOpen={false} onClose={() => {}} />)
    view.rerender(<SymbolSearchPalette isOpen onClose={() => {}} />)
    reply(ws, SYMBOLS_REPLY)
    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('list_symbols')).toEqual([])
  })
})

describe('#8429 code search: an unchanged query does not hide an owed refresh', () => {
  const type = async (q: string): Promise<void> => {
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: q } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  }

  it('the same query is in flight when the socket drops: reconnect re-asks it once', async () => {
    const ws = await openConnected()
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    await type('target')
    reply(ws, SEARCH_REPLY)
    await type('targetx')
    await type('target')
    expect(ws.sentOfType('search_content').map((m) => m.query), 'control: the same query was asked again').toEqual(['target', 'targetx', 'target'])
    expect(useConnectionStore.getState().codeSearchResults?.query, 'control: the retained result is for this query').toBe('target')

    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('search_content').map((m) => m.query)).toEqual(['target'])
  })

  it('closed, dropped, reopened offline and the same query typed: reconnect asks it once', async () => {
    const ws = await openConnected()
    const view = render(<CodeSearchPalette isOpen onClose={() => {}} />)
    await type('target')
    reply(ws, SEARCH_REPLY)
    view.rerender(<CodeSearchPalette isOpen={false} onClose={() => {}} />)
    act(() => { ws.onclose?.({ code: 1006 }) })
    view.rerender(<CodeSearchPalette isOpen onClose={() => {}} />)
    const sentBefore = ws.sentOfType('search_content').length
    await type('target')
    expect(ws.sentOfType('search_content').length, 'control: nothing can go out on the dead socket').toBe(sentBefore)
    expect(screen.getByTestId('code-search-item-0'), 'control: the retained result looks current').toBeTruthy()

    const ws2 = await reconnect()
    expect(ws2.sentOfType('search_content').map((m) => m.query)).toEqual(['target'])
  })

  it('a result answered before the drop is still not re-asked (the #8427 intent)', async () => {
    const ws = await openConnected()
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    await type('target')
    reply(ws, SEARCH_REPLY)
    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('search_content')).toEqual([])
  })

  it('typing ~100 ms before the connect edge sends the query once, not the re-ask plus the debounce', async () => {
    const ws = await openConnected()
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    await type('target')
    expect(ws.sentOfType('search_content').length, 'control: a request is in flight at the drop').toBe(1)
    act(() => { ws.onclose?.({ code: 1006 }) })

    // Step to the moment the store builds the retry socket, type, and let the
    // connection come up with the debounce still pending.
    const before = MockWebSocket.instances.length
    for (let i = 0; i < 400 && MockWebSocket.instances.length === before; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    }
    const ws2 = MockWebSocket.instances[before]
    if (!ws2) throw new Error('the drop armed no reconnect attempt')
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'targets' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => {
      ws2.readyState = 1
      ws2.onopen?.()
      await vi.advanceTimersByTimeAsync(0)
      useConnectionStore.setState({ socket: ws2 as unknown as WebSocket, connectionPhase: 'connected', userDisconnected: false })
    })
    expect(ws2.sentOfType('search_content'), 'control: the debounce had not fired at the edge, so only the re-ask could have gone out').toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(ws2.sentOfType('search_content').map((m) => m.query)).toEqual(['targets'])
  })
})

describe('#8429 the unavailable copy says which kind of unavailable it is', () => {
  const WILL_RELOAD = /when the connection is back/
  const palettes = [
    { name: 'symbol search', ui: () => <SymbolSearchPalette isOpen onClose={() => {}} />, offline: 'symbol-search-offline', ideOff: 'symbol-search-ide-off' },
    { name: 'references', ui: () => <ReferencesPalette isOpen onClose={() => {}} />, offline: 'references-offline', ideOff: 'references-ide-off' },
  ]

  for (const p of palettes) {
    it(`${p.name}: disconnected says it will reload; a connected daemon with the IDE off does not promise that`, async () => {
      useConnectionStore.setState({ referencesSymbol: 'widget', referencesOpen: true } as Partial<State>)
      const view = render(p.ui())
      expect(screen.getByTestId(p.offline).textContent, 'disconnected').toMatch(WILL_RELOAD)
      expect(screen.queryByTestId(p.ideOff)).toBeNull()

      view.unmount()
      useConnectionStore.setState({ connectionPhase: 'connected', serverCapabilities: {} } as Partial<State>)
      render(p.ui())
      const text = screen.getByTestId(p.ideOff).textContent ?? ''
      expect(WILL_RELOAD.test(text), `IDE-off copy must not promise a reload: ${text}`).toBe(false)
      expect(screen.queryByTestId(p.offline)).toBeNull()
    })
  }

  it('code search', async () => {
    const view = render(<CodeSearchPalette isOpen onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'target' } })
    expect(screen.getByTestId('code-search-offline').textContent).toMatch(/when the connection is back/)
    expect(screen.queryByTestId('code-search-ide-off')).toBeNull()

    view.unmount()
    useConnectionStore.setState({ connectionPhase: 'connected', serverCapabilities: {} } as Partial<State>)
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'target' } })
    const text = screen.getByTestId('code-search-ide-off').textContent ?? ''
    expect(/when the connection is back/.test(text), `IDE-off copy must not promise a reload: ${text}`).toBe(false)
    expect(screen.queryByTestId('code-search-offline')).toBeNull()
  })
})

/**
 * #8429 review: a reply to an OLDER request replaces `result` and clears `*Loading`
 * while a NEWER request is still outstanding. The in-flight mark must not be the
 * only thing owing the re-ask, or the palette is left on "Searching…" for ever.
 */
describe('#8429 review: a reply to an older request does not hide the newer one that was lost', () => {
  it('code search: ab, abc, the reply for ab lands, drop, reconnect re-asks abc', async () => {
    const ws = await openConnected()
    render(<CodeSearchPalette isOpen onClose={() => {}} />)
    for (const q of ['ab', 'abc']) {
      fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: q } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    }
    expect(ws.sentOfType('search_content').map((m) => m.query), 'control: both were asked').toEqual(['ab', 'abc'])
    reply(ws, { ...SEARCH_REPLY, query: 'ab' })
    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('search_content').map((m) => m.query)).toEqual(['abc'])
  })

  it('references: alpha, beta, the reply for alpha lands, drop, reconnect re-asks beta', async () => {
    const ws = await openConnected()
    act(() => { useConnectionStore.getState().requestFindReferences('alpha') })
    render(<ReferencesPalette isOpen onClose={() => {}} />)
    act(() => { useConnectionStore.getState().requestFindReferences('beta') })
    expect(ws.sentOfType('find_references').map((m) => m.symbol), 'control: both were asked').toEqual(['alpha', 'beta'])
    reply(ws, { ...REFERENCES_REPLY, symbol: 'alpha' })
    act(() => { ws.onclose?.({ code: 1006 }) })
    const ws2 = await reconnect()
    expect(ws2.sentOfType('find_references').map((m) => m.symbol)).toEqual(['beta'])
  })
})
