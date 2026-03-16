/**
 * FileBrowserPanel — tests for file tree navigation, file viewing, and git status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { FileBrowserPanel } from './FileBrowserPanel'

// Mock the connection store
const mockRequestFileListing = vi.fn()
const mockRequestFileContent = vi.fn()
const mockRequestGitStatus = vi.fn()
let fileBrowserCallback: ((listing: any) => void) | null = null
let fileContentCallback: ((content: any) => void) | null = null
let gitStatusCallback: ((result: any) => void) | null = null

let mockSessionStates: Record<string, any> = {}
let mockActiveSessionId: string | null = 's1'

vi.mock('../store/connection', () => {
  const storeState = () => ({
    requestFileListing: mockRequestFileListing,
    requestFileContent: mockRequestFileContent,
    requestGitStatus: mockRequestGitStatus,
    setFileBrowserCallback: (cb: any) => { fileBrowserCallback = cb },
    setFileContentCallback: (cb: any) => { fileContentCallback = cb },
    setGitStatusCallback: (cb: any) => { gitStatusCallback = cb },
    activeSessionId: mockActiveSessionId,
    sessionStates: mockSessionStates,
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
