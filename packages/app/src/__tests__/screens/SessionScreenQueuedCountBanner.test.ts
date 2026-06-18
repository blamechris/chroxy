/**
 * #5699 (part 2) / #6081 — SessionScreen reconnect-banner queued-count + discard warning.
 *
 * While disconnected, typed input is buffered (message-handler queue) and mirrored
 * into the store as `queuedMessageCount`. The reconnect banner must surface that
 * count ("N unsent message(s) queued") so held input isn't invisible, and the
 * banner's Disconnect affordance must warn before giving up — disconnect() clears
 * the queue, so silently discarding typed input on a tap is the exact silent-loss
 * bug #5699 fixes.
 *
 * #6081 refactored the inline Alert logic into the shared `disconnectWithQueueGuard`
 * helper so all give-up paths (header button, ConnectScreen cancel, this banner)
 * behave identically. SessionScreen now delegates to that helper rather than
 * re-implementing the same Alert.
 *
 * No `@testing-library/react-native` in this repo (see SessionScreenStoppedBanner
 * .test.ts), so this verifies the wire-up via source-text parsing; the queue/count
 * runtime behaviour is exercised against the real store in
 * __tests__/store/message-queue.test.ts and connection.test.ts. The shared guard's
 * logic (Alert shown / Disconnect calls disconnect / Keep waiting noop) is exercised
 * in __tests__/store/disconnectWithQueueGuard.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const SessionScreenSrc = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SessionScreen.tsx'),
  'utf-8',
);

describe('SessionScreen reconnect queued-count banner (#5699 / #6081)', () => {
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

  it('handleStopReconnecting delegates to disconnectWithQueueGuard (DRY — no inline Alert copy)', () => {
    // #6081: the inline useCallback + Alert logic moved to the shared helper.
    expect(SessionScreenSrc).toMatch(/import \{ disconnectWithQueueGuard \} from ['"]\.\.\/store\/disconnectWithQueueGuard['"]/);
    expect(SessionScreenSrc).toMatch(/const handleStopReconnecting = disconnectWithQueueGuard/);
  });

  it('does NOT contain an inline "Discard unsent messages?" Alert in SessionScreen itself', () => {
    // The shared helper owns this; verifying the copy was removed from the screen.
    const inlineAlerts = SessionScreenSrc.match(/Alert\.alert\(\s*'Discard unsent messages\?'/g);
    expect(inlineAlerts).toBeNull();
  });
});
