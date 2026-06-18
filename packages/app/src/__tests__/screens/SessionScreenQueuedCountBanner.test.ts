/**
 * #5699 (part 2) — SessionScreen reconnect-banner queued-count + discard warning.
 *
 * While disconnected, typed input is buffered (message-handler queue) and mirrored
 * into the store as `queuedMessageCount`. The reconnect banner must surface that
 * count ("N unsent message(s) queued") so held input isn't invisible, and the
 * banner's Disconnect affordance must warn before giving up — disconnect() clears
 * the queue, so silently discarding typed input on a tap is the exact silent-loss
 * bug #5699 fixes.
 *
 * No `@testing-library/react-native` in this repo (see SessionScreenStoppedBanner
 * .test.ts), so this verifies the wire-up via source-text parsing; the queue/count
 * runtime behaviour is exercised against the real store in
 * __tests__/store/message-queue.test.ts and connection.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const SessionScreenSrc = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SessionScreen.tsx'),
  'utf-8',
);

describe('SessionScreen reconnect queued-count banner (#5699)', () => {
  it('selects queuedMessageCount from the store', () => {
    expect(SessionScreenSrc).toMatch(
      /const queuedMessageCount = useConnectionStore\(\(s\) => s\.queuedMessageCount\)/,
    );
  });

  it('renders the queued-count line in the reconnect banner when there are unsent messages', () => {
    expect(SessionScreenSrc).toMatch(/queuedMessageCount > 0 && \(/);
    expect(SessionScreenSrc).toMatch(/testID="reconnect-queued-count"/);
    expect(SessionScreenSrc).toMatch(/unsent message\{queuedMessageCount === 1 \? '' : 's'\} queued/);
  });

  it('wires the banner Disconnect affordance to handleStopReconnecting (not raw disconnect)', () => {
    expect(SessionScreenSrc).toMatch(/onPress=\{handleStopReconnecting\}/);
  });

  it('warns with a discard Alert before disconnecting when input is queued', () => {
    expect(SessionScreenSrc).toMatch(/const handleStopReconnecting = useCallback\(\(\) => \{/);
    expect(SessionScreenSrc).toMatch(/if \(queuedMessageCount > 0\)/);
    expect(SessionScreenSrc).toMatch(/Alert\.alert\(\s*'Discard unsent messages\?'/);
  });

  it('offers Keep waiting / Disconnect choices, with Disconnect calling disconnect', () => {
    expect(SessionScreenSrc).toMatch(/text: 'Keep waiting', style: 'cancel'/);
    expect(SessionScreenSrc).toMatch(/text: 'Disconnect', style: 'destructive', onPress: disconnect/);
  });

  it('falls through to a plain disconnect() when nothing is queued', () => {
    // After the queued-count guard returns, the no-queue path calls disconnect directly.
    expect(SessionScreenSrc).toMatch(/return;\s*\}\s*disconnect\(\);\s*\}, \[queuedMessageCount, disconnect\]\)/);
  });
});
