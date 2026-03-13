import { useFileOperationsStore } from '../../store/file-operations'
import { getCallback, clearAllCallbacks } from '../../store/imperative-callbacks'

// Track wsSend calls
const wsSendCalls = []

// Mock message-handler's wsSend
jest.mock('../../store/message-handler', () => ({
  wsSend: (socket, payload) => {
    wsSendCalls.push({ socket, payload })
  },
}))

// Mock useConnectionStore to provide a fake socket
const mockSocket = { readyState: 1 }
jest.mock('../../store/connection', () => ({
  useConnectionStore: {
    getState: () => ({ socket: mockSocket }),
  },
}))

describe('FileOperationsStore', () => {
  beforeEach(() => {
    clearAllCallbacks()
    wsSendCalls.length = 0
    mockSocket.readyState = 1
  })

  // --- Callback setters ---

  it('sets directory listing callback via imperative-callbacks', () => {
    const cb = jest.fn()
    useFileOperationsStore.getState().setDirectoryListingCallback(cb)
    expect(getCallback('directoryListing')).toBe(cb)
  })

  it('sets file browser callback', () => {
    const cb = jest.fn()
    useFileOperationsStore.getState().setFileBrowserCallback(cb)
    expect(getCallback('fileBrowser')).toBe(cb)
  })

  it('sets file content callback', () => {
    const cb = jest.fn()
    useFileOperationsStore.getState().setFileContentCallback(cb)
    expect(getCallback('fileContent')).toBe(cb)
  })

  it('sets file write callback', () => {
    const cb = jest.fn()
    useFileOperationsStore.getState().setFileWriteCallback(cb)
    expect(getCallback('fileWrite')).toBe(cb)
  })

  it('sets diff callback', () => {
    const cb = jest.fn()
    useFileOperationsStore.getState().setDiffCallback(cb)
    expect(getCallback('diff')).toBe(cb)
  })

  it('sets git status callback', () => {
    const cb = jest.fn()
    useFileOperationsStore.getState().setGitStatusCallback(cb)
    expect(getCallback('gitStatus')).toBe(cb)
  })

  it('sets git branches callback', () => {
    const cb = jest.fn()
    useFileOperationsStore.getState().setGitBranchesCallback(cb)
    expect(getCallback('gitBranches')).toBe(cb)
  })

  it('sets git stage callback', () => {
    const cb = jest.fn()
    useFileOperationsStore.getState().setGitStageCallback(cb)
    expect(getCallback('gitStage')).toBe(cb)
  })

  it('sets git commit callback', () => {
    const cb = jest.fn()
    useFileOperationsStore.getState().setGitCommitCallback(cb)
    expect(getCallback('gitCommit')).toBe(cb)
  })

  // --- Request methods ---

  it('sends list_directory message', () => {
    useFileOperationsStore.getState().requestDirectoryListing('/tmp')
    expect(wsSendCalls).toHaveLength(1)
    expect(wsSendCalls[0].payload).toEqual({ type: 'list_directory', path: '/tmp' })
    expect(wsSendCalls[0].socket).toBe(mockSocket)
  })

  it('sends list_directory without path', () => {
    useFileOperationsStore.getState().requestDirectoryListing()
    expect(wsSendCalls[0].payload).toEqual({ type: 'list_directory' })
  })

  it('sends browse_files message', () => {
    useFileOperationsStore.getState().requestFileListing('/home')
    expect(wsSendCalls[0].payload).toEqual({ type: 'browse_files', path: '/home' })
  })

  it('sends read_file message', () => {
    useFileOperationsStore.getState().requestFileContent('/etc/hosts')
    expect(wsSendCalls[0].payload).toEqual({ type: 'read_file', path: '/etc/hosts' })
  })

  it('sends write_file message', () => {
    useFileOperationsStore.getState().requestFileWrite('/tmp/test.txt', 'hello')
    expect(wsSendCalls[0].payload).toEqual({ type: 'write_file', path: '/tmp/test.txt', content: 'hello' })
  })

  it('sends get_diff message', () => {
    useFileOperationsStore.getState().requestDiff('HEAD~1')
    expect(wsSendCalls[0].payload).toEqual({ type: 'get_diff', base: 'HEAD~1' })
  })

  it('sends get_diff without base', () => {
    useFileOperationsStore.getState().requestDiff()
    expect(wsSendCalls[0].payload).toEqual({ type: 'get_diff' })
  })

  it('sends git_status message', () => {
    useFileOperationsStore.getState().requestGitStatus()
    expect(wsSendCalls[0].payload).toEqual({ type: 'git_status' })
  })

  it('sends git_branches message', () => {
    useFileOperationsStore.getState().requestGitBranches()
    expect(wsSendCalls[0].payload).toEqual({ type: 'git_branches' })
  })

  it('sends git_stage message', () => {
    useFileOperationsStore.getState().requestGitStage(['file1.ts', 'file2.ts'])
    expect(wsSendCalls[0].payload).toEqual({ type: 'git_stage', files: ['file1.ts', 'file2.ts'] })
  })

  it('sends git_unstage message', () => {
    useFileOperationsStore.getState().requestGitUnstage(['file1.ts'])
    expect(wsSendCalls[0].payload).toEqual({ type: 'git_unstage', files: ['file1.ts'] })
  })

  it('sends git_commit message', () => {
    useFileOperationsStore.getState().requestGitCommit('fix: typo')
    expect(wsSendCalls[0].payload).toEqual({ type: 'git_commit', message: 'fix: typo' })
  })

  // --- Edge cases ---

  it('does not send when socket is closed', () => {
    mockSocket.readyState = 3 // WebSocket.CLOSED
    useFileOperationsStore.getState().requestGitStatus()
    expect(wsSendCalls).toHaveLength(0)
  })
})
