/**
 * FileBrowserPanel — tests for file tree navigation, file viewing, and git status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { FileBrowserPanel, contentReplyMatchesSelection } from './FileBrowserPanel'

// Mock the connection store
const mockRequestFileListing = vi.fn()
const mockRequestFileContent = vi.fn()
const mockRequestGitStatus = vi.fn()
const mockRequestSymbols = vi.fn()
// #6475 go-to-definition
const mockRequestResolveSymbol = vi.fn()
const mockRequestFindReferences = vi.fn()
const mockOpenFileInBrowser = vi.fn()
let mockSymbolLocation: any = null
let fileBrowserCallback: ((listing: any) => void) | null = null
let fileContentCallback: ((content: any) => void) | null = null
let gitStatusCallback: ((result: any) => void) | null = null

let mockSessionStates: Record<string, any> = {}
let mockActiveSessionId: string | null = 's1'
// #6472 symbol-panel store state
let mockSymbols: any = null
let mockSymbolsLoading = false
let mockIdeCapability = false
let mockFileBrowserPendingOpen: any = null

vi.mock('../store/connection', () => {
  const storeState = () => ({
    requestFileListing: mockRequestFileListing,
    requestFileContent: mockRequestFileContent,
    requestGitStatus: mockRequestGitStatus,
    requestSymbols: mockRequestSymbols,
    setFileBrowserCallback: (cb: any) => { fileBrowserCallback = cb },
    setFileContentCallback: (cb: any) => { fileContentCallback = cb },
    setGitStatusCallback: (cb: any) => { gitStatusCallback = cb },
    activeSessionId: mockActiveSessionId,
    sessionStates: mockSessionStates,
    symbols: mockSymbols,
    symbolsLoading: mockSymbolsLoading,
    serverCapabilities: { ide: mockIdeCapability },
    fileBrowserPendingOpen: mockFileBrowserPendingOpen,
    requestResolveSymbol: mockRequestResolveSymbol,
    requestFindReferences: mockRequestFindReferences,
    openFileInBrowser: mockOpenFileInBrowser,
    symbolLocation: mockSymbolLocation,
  })

  const useConnectionStore = Object.assign(
    (selector: any) => selector(storeState()),
    {
      getState: () => storeState(),
      setState: (partial: any) => {
        if (partial.sessionStates) mockSessionStates = partial.sessionStates
      },
    },
  )

  return { useConnectionStore }
})

// Mock syntax tokenizer
vi.mock('../lib/syntax', () => ({
  tokenize: (line: string, _lang: string) => [{ text: line, type: 'plain' }],
}))

import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  fileBrowserCallback = null
  fileContentCallback = null
  gitStatusCallback = null
  mockSessionStates = {}
  mockActiveSessionId = 's1'
  mockSymbols = null
  mockSymbolsLoading = false
  mockIdeCapability = false
  mockFileBrowserPendingOpen = null
  mockSymbolLocation = null
})

describe('FileBrowserPanel', () => {
  it('renders and requests initial listing on mount', () => {
    render(<FileBrowserPanel />)
    expect(mockRequestFileListing).toHaveBeenCalledOnce()
    expect(mockRequestGitStatus).toHaveBeenCalledOnce()
    expect(screen.getByText('Loading...')).toBeTruthy()
  })

  it('shows directory entries after listing callback', async () => {
    render(<FileBrowserPanel />)

    // Simulate server response
    fileBrowserCallback!({
      path: '/home/user/project',
      parentPath: null,
      entries: [
        { name: 'src', isDirectory: true, size: null },
        { name: 'package.json', isDirectory: false, size: 1024 },
        { name: 'README.md', isDirectory: false, size: 256 },
      ],
      error: null,
    })

    await waitFor(() => {
      expect(screen.getByText('src')).toBeTruthy()
      expect(screen.getByText('package.json')).toBeTruthy()
      expect(screen.getByText('README.md')).toBeTruthy()
    })
  })

  it('navigates into a directory when clicked', async () => {
    render(<FileBrowserPanel />)

    fileBrowserCallback!({
      path: '/home/user/project',
      parentPath: null,
      entries: [{ name: 'src', isDirectory: true, size: null }],
      error: null,
    })

    await waitFor(() => {
      fireEvent.click(screen.getByText('src'))
    })

    expect(mockRequestFileListing).toHaveBeenCalledWith('/home/user/project/src')
  })

  it('requests file content when a file is clicked', async () => {
    render(<FileBrowserPanel />)

    fileBrowserCallback!({
      path: '/home/user/project',
      parentPath: null,
      entries: [{ name: 'index.ts', isDirectory: false, size: 512 }],
      error: null,
    })

    await waitFor(() => {
      fireEvent.click(screen.getByText('index.ts'))
    })

    expect(mockRequestFileContent).toHaveBeenCalledWith('/home/user/project/index.ts')
  })

  it('shows file content with syntax highlighting', async () => {
    render(<FileBrowserPanel />)

    fileBrowserCallback!({
      path: '/home/user/project',
      parentPath: null,
      entries: [{ name: 'hello.js', isDirectory: false, size: 32 }],
      error: null,
    })

    await waitFor(() => fireEvent.click(screen.getByText('hello.js')))

    fileContentCallback!({
      path: '/home/user/project/hello.js',
      content: 'console.log("hello")\n',
      language: 'js',
      size: 32,
      truncated: false,
      error: null,
    })

    await waitFor(() => {
      // Syntax highlighting splits code into token spans — verify the code is rendered
      // by checking that key tokens appear in the document
      expect(document.body.textContent).toContain('console')
      expect(document.body.textContent).toContain('hello')
    })
  })

  it('displays git status decorations', async () => {
    render(<FileBrowserPanel />)

    fileBrowserCallback!({
      path: '/home/user/project',
      parentPath: null,
      entries: [
        { name: 'modified.js', isDirectory: false, size: 100 },
        { name: 'new-file.ts', isDirectory: false, size: 200 },
      ],
      error: null,
    })

    gitStatusCallback!({
      branch: 'feat/test',
      staged: [],
      unstaged: [{ path: 'modified.js', status: 'modified' }],
      untracked: ['new-file.ts'],
      error: null,
    })

    await waitFor(() => {
      expect(screen.getByText('M')).toBeTruthy()
      expect(screen.getByText('U')).toBeTruthy()
      expect(screen.getByText('feat/test')).toBeTruthy()
    })
  })

  it('shows error state', async () => {
    render(<FileBrowserPanel />)

    fileBrowserCallback!({
      path: null,
      parentPath: null,
      entries: [],
      error: 'Permission denied',
    })

    await waitFor(() => {
      expect(screen.getByText('Permission denied')).toBeTruthy()
    })
  })

  it('shows parent navigation (..) when not at root', async () => {
    render(<FileBrowserPanel />)

    // First call sets root
    fileBrowserCallback!({
      path: '/home/user/project',
      parentPath: null,
      entries: [{ name: 'src', isDirectory: true, size: null }],
      error: null,
    })

    // Navigate into src
    await waitFor(() => fireEvent.click(screen.getByText('src')))

    fileBrowserCallback!({
      path: '/home/user/project/src',
      parentPath: '/home/user/project',
      entries: [{ name: 'index.ts', isDirectory: false, size: 100 }],
      error: null,
    })

    await waitFor(() => {
      expect(screen.getByText('..')).toBeTruthy()
    })
  })

  it('closes file viewer when close button is clicked', async () => {
    render(<FileBrowserPanel />)

    act(() => {
      fileBrowserCallback!({
        path: '/home/user/project',
        parentPath: null,
        entries: [{ name: 'test.js', isDirectory: false, size: 10 }],
        error: null,
      })
    })

    const fileBtn = screen.getByText('test.js')
    expect(fileBtn).toBeTruthy()

    act(() => {
      fireEvent.click(fileBtn)
    })

    // File viewer header should appear with close button
    const closeBtn = screen.getByLabelText('Close file')
    expect(closeBtn).toBeTruthy()

    act(() => {
      fireEvent.click(closeBtn)
    })

    // File viewer should be gone
    expect(screen.queryByLabelText('Close file')).toBeNull()
  })

  it('persists selected file path to session state', async () => {
    mockActiveSessionId = 's1'
    mockSessionStates = { s1: { selectedFilePath: null } }

    render(<FileBrowserPanel />)

    act(() => {
      fileBrowserCallback!({
        path: '/home/user/project',
        parentPath: null,
        entries: [{ name: 'readme.md', isDirectory: false, size: 50 }],
        error: null,
      })
    })

    act(() => {
      fireEvent.click(screen.getByText('readme.md'))
    })

    // Session state should have the selected file path
    expect(mockSessionStates.s1.selectedFilePath).toBe('/home/user/project/readme.md')
  })

  it('restores selected file on remount from session state', () => {
    mockActiveSessionId = 's1'
    mockSessionStates = { s1: { selectedFilePath: '/home/user/project/index.ts' } }

    render(<FileBrowserPanel />)

    // Should request file content for the saved path on mount
    expect(mockRequestFileContent).toHaveBeenCalledWith('/home/user/project/index.ts')
  })
})

describe('FileBrowserPanel — symbol panel (#6472)', () => {
  const SNAPSHOT = {
    path: 'foo.ts',
    truncated: false,
    error: null,
    symbols: [
      { name: 'doThing', kind: 'function', file: 'foo.ts', line: 5, exported: true },
      { name: 'helper', kind: 'function', file: 'foo.ts', line: 9, exported: false },
      { name: 'Widget', kind: 'class', file: 'foo.ts', line: 14, exported: true },
    ],
  }

  // Render the panel, load a root listing with one file, click it, and land its
  // content — so the file viewer (and, when ide is on, the symbol panel) shows.
  async function openFile(opts: { ide: boolean; symbols?: any }) {
    mockIdeCapability = opts.ide
    mockSymbols = opts.symbols ?? null
    render(<FileBrowserPanel />)
    act(() => {
      fileBrowserCallback!({
        path: '/root',
        parentPath: null,
        entries: [{ name: 'foo.ts', isDirectory: false, size: 200 }],
        error: null,
      })
    })
    await waitFor(() => screen.getByText('foo.ts'))
    fireEvent.click(screen.getByText('foo.ts'))
    act(() => {
      fileContentCallback!({
        content: Array.from({ length: 20 }, (_, i) => `const v${i} = ${i}`).join('\n'),
        language: 'typescript',
        size: 200,
        truncated: false,
        error: null,
      })
    })
  }

  it('requests symbols scoped to the file when the ide capability is on', async () => {
    await openFile({ ide: true, symbols: SNAPSHOT })
    expect(mockRequestSymbols).toHaveBeenCalledWith('foo.ts')
  })

  it('renders the open file symbols grouped by kind', async () => {
    await openFile({ ide: true, symbols: SNAPSHOT })
    await waitFor(() => {
      expect(screen.getByTestId('symbol-panel')).toBeTruthy()
      expect(screen.getByTestId('symbol-group-function')).toBeTruthy()
      expect(screen.getByTestId('symbol-group-class')).toBeTruthy()
      expect(screen.getByTestId('symbol-item-doThing')).toBeTruthy()
      expect(screen.getByTestId('symbol-item-Widget')).toBeTruthy()
    })
  })

  it('scrolls the viewer to a symbol line on click', async () => {
    const scrollSpy = vi.fn()
    const prevScrollIntoView = (Element.prototype as any).scrollIntoView
    ;(Element.prototype as any).scrollIntoView = scrollSpy // jsdom lacks it
    try {
      await openFile({ ide: true, symbols: SNAPSHOT })
      const item = await screen.findByTestId('symbol-item-doThing')
      fireEvent.click(item)
      expect(scrollSpy).toHaveBeenCalled()
      const line = document.querySelector('[data-line="5"]')
      expect(line?.classList.contains('file-viewer-line--active')).toBe(true)
    } finally {
      ;(Element.prototype as any).scrollIntoView = prevScrollIntoView
    }
  })

  it('shows no symbol panel and sends no request when the ide capability is off', async () => {
    await openFile({ ide: false, symbols: SNAPSHOT })
    await waitFor(() => screen.getByLabelText('Close file')) // file is open
    expect(screen.queryByTestId('symbol-panel')).toBeNull()
    expect(mockRequestSymbols).not.toHaveBeenCalled()
  })
})

describe('FileBrowserPanel — external open (#6473 Cmd+P)', () => {
  it('opens a file requested via fileBrowserPendingOpen', () => {
    mockFileBrowserPendingOpen = { path: '/root/deep/thing.ts', nonce: 1 }
    render(<FileBrowserPanel />)
    // The pending-open effect fires on mount → loads the file into the viewer.
    expect(mockRequestFileContent).toHaveBeenCalledWith('/root/deep/thing.ts')
    expect(screen.getByLabelText('Close file')).toBeTruthy()
  })

  it('scrolls to the requested line after the file loads (#6476 jump-to-def)', async () => {
    const scrollSpy = vi.fn()
    const prev = (Element.prototype as any).scrollIntoView
    ;(Element.prototype as any).scrollIntoView = scrollSpy // jsdom lacks it
    try {
      mockFileBrowserPendingOpen = { path: '/root/x.ts', line: 3, nonce: 1 }
      render(<FileBrowserPanel />)
      // Content lands → lines render with data-line anchors → deferred scroll fires.
      act(() => {
        fileContentCallback!({
          content: 'l1\nl2\nl3\nl4\nl5', language: 'typescript', size: 10, truncated: false, error: null,
        })
      })
      await waitFor(() => expect(scrollSpy).toHaveBeenCalled())
    } finally {
      ;(Element.prototype as any).scrollIntoView = prev
    }
  })
})

describe('FileBrowserPanel — go-to-definition (#6475)', () => {
  // Open a file whose content is a single bare identifier, so the tokenizer emits
  // one clickable `syn-plain` token we can cmd/ctrl+click.
  async function openIdentifierFile(ide: boolean) {
    mockIdeCapability = ide
    render(<FileBrowserPanel />)
    act(() => {
      fileBrowserCallback!({
        path: '/root',
        parentPath: null,
        entries: [{ name: 'foo.ts', isDirectory: false, size: 20 }],
        error: null,
      })
    })
    await waitFor(() => screen.getByText('foo.ts'))
    fireEvent.click(screen.getByText('foo.ts'))
    act(() => {
      fileContentCallback!({
        content: 'widget', language: 'typescript', size: 20, truncated: false, error: null,
      })
    })
    await waitFor(() => screen.getByText('widget'))
  }

  it('cmd/ctrl+click on a token resolves the symbol, passing the open file as a hint', async () => {
    await openIdentifierFile(true)
    fireEvent.click(screen.getByText('widget'), { metaKey: true })
    expect(mockRequestResolveSymbol).toHaveBeenCalledWith('widget', 'foo.ts')
  })

  it('a plain click (no modifier) does NOT resolve', async () => {
    await openIdentifierFile(true)
    fireEvent.click(screen.getByText('widget'))
    expect(mockRequestResolveSymbol).not.toHaveBeenCalled()
    expect(mockRequestFindReferences).not.toHaveBeenCalled()
  })

  it('alt/option+click on a token finds references (#6477), passing the open file', async () => {
    await openIdentifierFile(true)
    fireEvent.click(screen.getByText('widget'), { altKey: true })
    expect(mockRequestFindReferences).toHaveBeenCalledWith('widget', 'foo.ts')
    expect(mockRequestResolveSymbol).not.toHaveBeenCalled()
  })

  it('cmd wins over alt when both are held (definition is primary)', async () => {
    await openIdentifierFile(true)
    fireEvent.click(screen.getByText('widget'), { metaKey: true, altKey: true })
    expect(mockRequestResolveSymbol).toHaveBeenCalledWith('widget', 'foo.ts')
    expect(mockRequestFindReferences).not.toHaveBeenCalled()
  })

  it('does nothing on cmd+click when the ide capability is off', async () => {
    await openIdentifierFile(false)
    fireEvent.click(screen.getByText('widget'), { metaKey: true })
    expect(mockRequestResolveSymbol).not.toHaveBeenCalled()
  })

  it('jumps to the definition on a resolve hit (opens target file + line)', () => {
    mockSymbolLocation = { symbol: 'widget', file: 'src/widget.ts', line: 12, error: null, nonce: 1 }
    render(<FileBrowserPanel />)
    // The go-to-def effect fires on mount → opens the target via the store.
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/widget.ts', 12)
  })

  it('shows a transient "not found" pill on a resolve miss', async () => {
    mockSymbolLocation = { symbol: 'ghost', file: null, line: null, error: 'Definition not found', nonce: 1 }
    render(<FileBrowserPanel />)
    // Open a file so the viewer (which hosts the pill) is mounted.
    act(() => {
      fileBrowserCallback!({
        path: '/root', parentPath: null,
        entries: [{ name: 'foo.ts', isDirectory: false, size: 20 }], error: null,
      })
    })
    await waitFor(() => screen.getByText('foo.ts'))
    fireEvent.click(screen.getByText('foo.ts'))
    act(() => {
      fileContentCallback!({ path: '/root/foo.ts', content: 'x', language: 'typescript', size: 1, truncated: false, error: null })
    })
    const pill = await screen.findByTestId('def-not-found')
    expect(pill.textContent).toContain('ghost')
    expect(mockOpenFileInBrowser).not.toHaveBeenCalled()
  })
})

describe('contentReplyMatchesSelection (#6497)', () => {
  it('matches an exact absolute path (tree click)', () => {
    expect(contentReplyMatchesSelection('/root/a.ts', '/root/a.ts')).toBe(true)
  })
  it('matches a resolved absolute reply against a workspace-relative selection (symbol jump)', () => {
    // The server echoes the absolute path; a #6475/#6476 jump selected 'src/util.ts'.
    expect(contentReplyMatchesSelection('/root/src/util.ts', 'src/util.ts')).toBe(true)
    expect(contentReplyMatchesSelection('/root/src/util.ts', './src/util.ts')).toBe(true)
  })
  it('normalizes Windows separators on both sides', () => {
    expect(contentReplyMatchesSelection('C:\\root\\a.ts', 'C:\\root\\a.ts')).toBe(true)
    expect(contentReplyMatchesSelection('C:\\root\\src\\util.ts', 'src/util.ts')).toBe(true)
  })
  it('rejects a reply for a different file', () => {
    expect(contentReplyMatchesSelection('/root/other.ts', '/root/a.ts')).toBe(false)
    expect(contentReplyMatchesSelection('/root/other.ts', 'src/util.ts')).toBe(false)
  })
  it('does not partial-match a different file that shares a suffix substring', () => {
    // '/root/barfoo.ts' must NOT match selection 'foo.ts' (segment boundary).
    expect(contentReplyMatchesSelection('/root/barfoo.ts', 'foo.ts')).toBe(false)
  })
  it('requires an EXACT match for an absolute selection (no tail-match) (#6501 review)', () => {
    // A different root that happens to end with the same absolute string must not match.
    expect(contentReplyMatchesSelection('/other/root/a.ts', '/root/a.ts')).toBe(false)
    expect(contentReplyMatchesSelection('/root/a.ts', '/root/a.ts')).toBe(true)
    // Windows absolute selection: exact only.
    expect(contentReplyMatchesSelection('D:/x/root/a.ts', 'C:/root/a.ts')).toBe(false)
  })
  it('keeps a reply that cannot be correlated (null path)', () => {
    expect(contentReplyMatchesSelection(null, '/root/a.ts')).toBe(true)
    expect(contentReplyMatchesSelection('/root/a.ts', null)).toBe(true)
  })
})

describe('FileBrowserPanel — stale content guard (#6497)', () => {
  it('ignores a file_content reply for a since-deselected file', async () => {
    render(<FileBrowserPanel />)
    act(() => {
      fileBrowserCallback!({
        path: '/root', parentPath: null,
        entries: [{ name: 'a.ts', isDirectory: false, size: 10 }], error: null,
      })
    })
    await waitFor(() => screen.getByText('a.ts'))
    fireEvent.click(screen.getByText('a.ts')) // selectedFile = /root/a.ts
    // A late reply for a DIFFERENT file must not flash into the viewer.
    act(() => {
      fileContentCallback!({ path: '/root/other.ts', content: 'STALE', language: 'typescript', size: 5, truncated: false, error: null })
    })
    expect(screen.queryByText('STALE')).toBeNull()
    // The correct reply lands and renders.
    act(() => {
      fileContentCallback!({ path: '/root/a.ts', content: 'CORRECT', language: 'typescript', size: 7, truncated: false, error: null })
    })
    await waitFor(() => screen.getByText('CORRECT'))
  })
})
