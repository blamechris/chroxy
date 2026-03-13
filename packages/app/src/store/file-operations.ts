/**
 * FileOperationsStore — Zustand store for file browser, git, and diff operations.
 *
 * Consolidates the callback setters and request methods that were previously
 * scattered across ConnectionState. Request methods read the socket from
 * useConnectionStore; callbacks are managed via imperative-callbacks module.
 *
 * Part of the incremental store decomposition (#999).
 */
import { create } from 'zustand';
import { setCallback } from './imperative-callbacks';
import { wsSend } from './message-handler';
import type {
  DirectoryListing,
  FileListing,
  FileContent,
  FileWriteResult,
  DiffResult,
  GitStatusResult,
  GitBranchesResult,
  GitStageResult,
  GitCommitResult,
} from './types';

// Lazy import to avoid circular dependency — connection.ts imports from message-handler.ts
// which this module also imports from. We break the cycle by deferring the import.
let _getSocket: (() => WebSocket | null) | null = null;

function getSocket(): WebSocket | null {
  if (!_getSocket) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useConnectionStore } = require('./connection');
    _getSocket = () => useConnectionStore.getState().socket;
  }
  return _getSocket();
}

interface FileOperationsActions {
  // Callback setters
  setDirectoryListingCallback: (cb: ((listing: DirectoryListing) => void) | null) => void;
  setFileBrowserCallback: (cb: ((listing: FileListing) => void) | null) => void;
  setFileContentCallback: (cb: ((content: FileContent) => void) | null) => void;
  setFileWriteCallback: (cb: ((result: FileWriteResult) => void) | null) => void;
  setDiffCallback: (cb: ((result: DiffResult) => void) | null) => void;
  setGitStatusCallback: (cb: ((result: GitStatusResult) => void) | null) => void;
  setGitBranchesCallback: (cb: ((result: GitBranchesResult) => void) | null) => void;
  setGitStageCallback: (cb: ((result: GitStageResult) => void) | null) => void;
  setGitCommitCallback: (cb: ((result: GitCommitResult) => void) | null) => void;

  // Request methods
  requestDirectoryListing: (path?: string) => void;
  requestFileListing: (path?: string) => void;
  requestFileContent: (path: string) => void;
  requestFileWrite: (path: string, content: string) => void;
  requestDiff: (base?: string) => void;
  requestGitStatus: () => void;
  requestGitBranches: () => void;
  requestGitStage: (paths: string[]) => void;
  requestGitUnstage: (paths: string[]) => void;
  requestGitCommit: (message: string) => void;
}

function sendIfOpen(payload: Record<string, unknown>): void {
  const socket = getSocket();
  if (socket && socket.readyState === WebSocket.OPEN) {
    wsSend(socket, payload);
  }
}

export const useFileOperationsStore = create<FileOperationsActions>(() => ({
  // Callback setters — delegate to imperative-callbacks module
  setDirectoryListingCallback: (cb) => setCallback('directoryListing', cb),
  setFileBrowserCallback: (cb) => setCallback('fileBrowser', cb),
  setFileContentCallback: (cb) => setCallback('fileContent', cb),
  setFileWriteCallback: (cb) => setCallback('fileWrite', cb),
  setDiffCallback: (cb) => setCallback('diff', cb),
  setGitStatusCallback: (cb) => setCallback('gitStatus', cb),
  setGitBranchesCallback: (cb) => setCallback('gitBranches', cb),
  setGitStageCallback: (cb) => setCallback('gitStage', cb),
  setGitCommitCallback: (cb) => setCallback('gitCommit', cb),

  // Request methods — send WS messages via the connection store's socket
  requestDirectoryListing: (path?: string) => {
    const msg: Record<string, string> = { type: 'list_directory' };
    if (path) msg.path = path;
    sendIfOpen(msg);
  },

  requestFileListing: (path?: string) => {
    const msg: Record<string, string> = { type: 'browse_files' };
    if (path) msg.path = path;
    sendIfOpen(msg);
  },

  requestFileContent: (path: string) => {
    sendIfOpen({ type: 'read_file', path });
  },

  requestFileWrite: (path: string, content: string) => {
    sendIfOpen({ type: 'write_file', path, content });
  },

  requestDiff: (base?: string) => {
    const msg: Record<string, string> = { type: 'get_diff' };
    if (base) msg.base = base;
    sendIfOpen(msg);
  },

  requestGitStatus: () => {
    sendIfOpen({ type: 'git_status' });
  },

  requestGitBranches: () => {
    sendIfOpen({ type: 'git_branches' });
  },

  requestGitStage: (paths: string[]) => {
    sendIfOpen({ type: 'git_stage', files: paths });
  },

  requestGitUnstage: (paths: string[]) => {
    sendIfOpen({ type: 'git_unstage', files: paths });
  },

  requestGitCommit: (message: string) => {
    sendIfOpen({ type: 'git_commit', message });
  },
}));
