import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/SessionScreen.tsx'),
  'utf-8',
);

describe('SessionScreen selective store usage (#1923)', () => {
  test('does not use non-selective useConnectionStore() call', () => {
    // Should NOT have bare useConnectionStore() without a selector
    // Pattern: useConnectionStore() with optional whitespace but no argument
    const bareCallPattern = /useConnectionStore\(\s*\)/;
    expect(src).not.toMatch(bareCallPattern);
  });

  test('all store values use individual selectors', () => {
    // Fields that still use inline selectors
    const inlineSelectors = [
      'viewMode',
      'serverMode',
      'sessionCwd',
      'connectionPhase',
      'availableModels',
      'availablePermissionModes',
      'inputSettings',
    ];

    for (const field of inlineSelectors) {
      // Match pattern: useConnectionStore((s) => s.field) or useConnectionStore(s => s.field)
      const pattern = new RegExp(`useConnectionStore\\(\\(?s\\)?\\s*=>\\s*s\\.${field}\\b`);
      expect(src).toMatch(pattern);
    }

    // Fields that now use session-aware selector functions
    const selectorFunctions = [
      'selectMessages',
      'selectClaudeReady',
      'selectStreamingMessageId',
      'selectActiveModel',
      'selectPermissionMode',
      'selectIsIdle',
    ];

    for (const fn of selectorFunctions) {
      const pattern = new RegExp(`useConnectionStore\\(${fn}\\)`);
      expect(src).toMatch(pattern);
    }
  });
});
