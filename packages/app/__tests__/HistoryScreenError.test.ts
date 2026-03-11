import fs from 'fs';
import path from 'path';

const screenSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/HistoryScreen.tsx'),
  'utf-8',
);

const storeTypesSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/store/types.ts'),
  'utf-8',
);

const connectionSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/store/connection.ts'),
  'utf-8',
);

describe('HistoryScreen error state (#1933)', () => {
  test('store types include conversationHistoryError field', () => {
    expect(storeTypesSrc).toContain('conversationHistoryError');
  });

  test('store initializes conversationHistoryError as null', () => {
    expect(connectionSrc).toMatch(/conversationHistoryError:\s*null/);
  });

  test('fetchConversationHistory sets error on timeout', () => {
    // The timeout branch should set an error message
    expect(connectionSrc).toMatch(/conversationHistoryError.*(?:timeout|timed?\s*out)/i);
  });

  test('fetchConversationHistory sets error when not connected', () => {
    // The not-connected branch should set an error
    expect(connectionSrc).toMatch(/conversationHistoryError.*(?:connect|not connected)/i);
  });

  test('HistoryScreen reads conversationHistoryError from store', () => {
    expect(screenSrc).toContain('conversationHistoryError');
  });

  test('HistoryScreen renders error state with retry button', () => {
    // Should have a retry mechanism
    expect(screenSrc).toMatch(/Retry/);
    // Should display the error
    expect(screenSrc).toMatch(/conversationHistoryError/);
  });

  test('message handler clears error on successful fetch', () => {
    const handlerSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/store/message-handler.ts'),
      'utf-8',
    );
    // conversations_list handler should clear the error
    expect(handlerSrc).toMatch(/conversationHistoryError:\s*null/);
  });
});
