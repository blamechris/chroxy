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
    // Key state values that were in the omnibus destructure should each have their own selector
    const requiredSelectors = [
      'viewMode',
      'messages',
      'claudeReady',
      'serverMode',
      'sessionCwd',
      'streamingMessageId',
      'connectionPhase',
      'activeModel',
      'availableModels',
      'permissionMode',
      'availablePermissionModes',
      'inputSettings',
    ];

    for (const field of requiredSelectors) {
      // Match pattern: useConnectionStore((s) => s.field) or useConnectionStore(s => s.field)
      const pattern = new RegExp(`useConnectionStore\\(\\(?s\\)?\\s*=>\\s*s\\.${field}\\b`);
      expect(src).toMatch(pattern);
    }
  });
});
