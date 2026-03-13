import {
  getCallback,
  setCallback,
  clearAllCallbacks,
  type CallbackName,
  type CallbackSignatures,
} from '../store/imperative-callbacks';

describe('imperative callbacks module (#2088)', () => {
  afterEach(() => {
    clearAllCallbacks();
  });

  const callbackNames: CallbackName[] = [
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
  ];

  it('all callbacks are null initially', () => {
    for (const name of callbackNames) {
      expect(getCallback(name)).toBeNull();
    }
  });

  it('set and get a callback', () => {
    const fn = jest.fn();
    setCallback('terminalWrite', fn);
    expect(getCallback('terminalWrite')).toBe(fn);
  });

  it('set replaces previous callback', () => {
    const fn1 = jest.fn();
    const fn2 = jest.fn();
    setCallback('directoryListing', fn1);
    setCallback('directoryListing', fn2);
    expect(getCallback('directoryListing')).toBe(fn2);
  });

  it('clearAllCallbacks resets all to null', () => {
    for (const name of callbackNames) {
      setCallback(name, jest.fn());
    }
    clearAllCallbacks();
    for (const name of callbackNames) {
      expect(getCallback(name)).toBeNull();
    }
  });

  it('setting null removes callback', () => {
    const fn = jest.fn();
    setCallback('fileContent', fn);
    setCallback('fileContent', null);
    expect(getCallback('fileContent')).toBeNull();
  });

  it('exports CallbackSignatures interface with all callback types', () => {
    // Verify the type exists and maps each CallbackName to a function signature
    // This is a compile-time check — if CallbackSignatures is missing or wrong,
    // TypeScript will error on these assignments
    const _terminalWrite: CallbackSignatures['terminalWrite'] = (_data: string) => {};
    const _directoryListing: CallbackSignatures['directoryListing'] = (_listing) => {};
    const _gitStatus: CallbackSignatures['gitStatus'] = (_result) => {};
    const _gitCommit: CallbackSignatures['gitCommit'] = (_result) => {};
    const _diff: CallbackSignatures['diff'] = (_result) => {};

    // Suppress unused variable warnings
    void _terminalWrite;
    void _directoryListing;
    void _gitStatus;
    void _gitCommit;
    void _diff;
  });

  it('getCallback returns typed callback for each name', () => {
    // Set a typed callback and verify it's returned with correct type
    const writeFn = (data: string) => { void data; };
    setCallback('terminalWrite', writeFn);
    const retrieved = getCallback('terminalWrite');
    expect(retrieved).toBe(writeFn);

    // The returned type should be callable with a string argument
    if (retrieved) {
      retrieved('test data');
    }
  });

  it('setCallback enforces type safety per callback name', () => {
    // These should compile without errors when types are correct
    setCallback('terminalWrite', (data: string) => { void data; });
    setCallback('directoryListing', (listing) => { void listing; });
    setCallback('gitStatus', (result) => { void result; });
    setCallback('gitBranches', (result) => { void result; });
    setCallback('gitStage', (result) => { void result; });
    setCallback('gitCommit', (result) => { void result; });
    setCallback('fileBrowser', (listing) => { void listing; });
    setCallback('fileContent', (content) => { void content; });
    setCallback('fileWrite', (result) => { void result; });
    setCallback('diff', (result) => { void result; });

    // All 10 should be set
    for (const name of callbackNames) {
      expect(getCallback(name)).not.toBeNull();
    }
  });

  it('module does not depend on Zustand', () => {
    // Verify the imperative-callbacks module has no Zustand dependency —
    // this ensures setting callbacks can never trigger store re-renders.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../store/imperative-callbacks.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"]zustand['"]/);
    expect(source).not.toMatch(/require\(['"]zustand['"]\)/);
  });
});
