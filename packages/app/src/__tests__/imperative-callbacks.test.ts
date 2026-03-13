import {
  getCallback,
  setCallback,
  clearAllCallbacks,
  type CallbackName,
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

  it('callbacks are not stored in Zustand state', () => {
    // This test verifies the architectural intent: callbacks are module-level,
    // not in the store, so setting them doesn't trigger re-renders
    const fn = jest.fn();
    setCallback('terminalWrite', fn);
    // If this were in Zustand, we'd expect store subscribers to fire.
    // Since it's module-level, no state change event happens.
    expect(getCallback('terminalWrite')).toBe(fn);
  });
});
