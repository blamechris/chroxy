/**
 * Module-level imperative callbacks (#2088)
 *
 * These callbacks are invoked by the message handler but must NOT live
 * in the Zustand store — setting them would trigger re-renders on every
 * subscriber even though no visible state changed.
 *
 * Consumers call setCallback() once (typically in a useEffect) and the
 * message handler calls getCallback() to invoke them.
 */

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

const CALLBACK_NAMES = [
  'terminalWrite',
  'directoryListing',
  'fileBrowser',
  'fileContent',
  'fileWrite',
  'diff',
  'gitStatus',
  'gitBranches',
  'gitStage',
  'gitCommit',
] as const;

export type CallbackName = (typeof CALLBACK_NAMES)[number];

export interface CallbackSignatures {
  terminalWrite: (data: string) => void;
  directoryListing: (listing: DirectoryListing) => void;
  fileBrowser: (listing: FileListing) => void;
  fileContent: (content: FileContent) => void;
  fileWrite: (result: FileWriteResult) => void;
  diff: (result: DiffResult) => void;
  gitStatus: (result: GitStatusResult) => void;
  gitBranches: (result: GitBranchesResult) => void;
  gitStage: (result: GitStageResult) => void;
  gitCommit: (result: GitCommitResult) => void;
}

type CallbackStore = { [K in CallbackName]: CallbackSignatures[K] | null };

const callbacks: CallbackStore = {
  terminalWrite: null,
  directoryListing: null,
  fileBrowser: null,
  fileContent: null,
  fileWrite: null,
  diff: null,
  gitStatus: null,
  gitBranches: null,
  gitStage: null,
  gitCommit: null,
};

export function getCallback<K extends CallbackName>(name: K): CallbackSignatures[K] | null {
  return callbacks[name];
}

export function setCallback<K extends CallbackName>(name: K, fn: CallbackSignatures[K] | null): void {
  callbacks[name] = fn;
}

export function clearAllCallbacks(): void {
  for (const name of CALLBACK_NAMES) {
    callbacks[name] = null;
  }
}
