/**
 * #6113 — mobile send-while-busy detection must match the dashboard's #5952
 * condition: a send queues when a turn is in flight, where "in flight" is
 * `streamingMessageId !== null` OR `isIdle === false`. The `isIdle` half covers
 * the window after `agent_busy` but before `stream_start` (or a tool-only turn
 * that never streams text) — without it a send in that window force-sends on
 * mobile while the dashboard queues.
 *
 * Following this repo's SessionScreen-testing convention (no
 * @testing-library/react-native — see SessionScreenQueuedCountBanner.test.ts),
 * the wire-up is verified by source-text parsing; the queued-path RUNTIME effect
 * (addUserMessage({ queued }) → optimistic queue entry, no live-turn re-arm) is
 * exercised against the real store in
 * __tests__/store/connection-queued-messages.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const SessionScreenSrc = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SessionScreen.tsx'),
  'utf-8',
);

describe('SessionScreen send-while-busy parity (#6113 / #5952)', () => {
  it('subscribes to isIdle from the store', () => {
    expect(SessionScreenSrc).toMatch(/const isIdle = useConnectionStore\(selectIsIdle\)/);
  });

  it('computes busy as streamingMessageId OR not-idle (dashboard #5952 parity)', () => {
    // Must include the !isIdle half — `const busy = !!streamingMessageId;` alone
    // would regress to the narrower pre-#6113 condition.
    expect(SessionScreenSrc).toMatch(/const busy = !!streamingMessageId \|\| !isIdle;/);
  });

  it('routes the send through addUserMessage with the queued flag', () => {
    expect(SessionScreenSrc).toMatch(/addUserMessage\(/);
    expect(SessionScreenSrc).toMatch(/\{ clientMessageId, queued: busy \}/);
  });
});
