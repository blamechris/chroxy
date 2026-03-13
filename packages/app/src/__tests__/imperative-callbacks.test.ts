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
