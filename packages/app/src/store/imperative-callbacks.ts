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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CallbackFn = ((...args: any[]) => void) | null;

const callbacks: Record<CallbackName, CallbackFn> = {
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

export function getCallback(name: CallbackName): CallbackFn {
  return callbacks[name];
}

export function setCallback(name: CallbackName, fn: CallbackFn): void {
  callbacks[name] = fn;
}

export function clearAllCallbacks(): void {
  for (const name of CALLBACK_NAMES) {
    callbacks[name] = null;
  }
}
