/**
 * #5725 (#5698) — SessionScreen terminal `server_down` banner.
 *
 * When the reconnect ladder gives up, the app enters the terminal `server_down`
 * phase. The banner must render distinctly from the live `reconnecting` spinner:
 * "Server appears to be down", NO indefinite spinner, and a Reconnect button
 * (wired to `retryConnection`, which resets the ladder + re-dials) instead of the
 * Disconnect affordance.
 *
 * No `@testing-library/react-native` in this repo (see SessionScreenStoppedBanner
 * .test.ts), so this verifies the wire-up via source-text parsing; the runtime
 * behaviour (onGaveUp → server_down; retryConnection resets + re-dials) is
 * exercised against the real store in __tests__/store/connection-server-down.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const SessionScreenSrc = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SessionScreen.tsx'),
  'utf-8',
);

describe('SessionScreen server_down banner (#5725)', () => {
  it('selects retryConnection from the store', () => {
    expect(SessionScreenSrc).toMatch(/const retryConnection = useConnectionStore\(\(s\) => s\.retryConnection\)/);
  });

  it('renders the reconnect banner for server_down (alongside reconnecting / server_restarting)', () => {
    expect(SessionScreenSrc).toMatch(
      /connectionPhase === 'reconnecting' \|\| connectionPhase === 'server_restarting' \|\| connectionPhase === 'server_down'/,
    );
  });

  it('suppresses the indefinite spinner in the terminal server_down state', () => {
    // The spinner is gated behind a non-server_down guard so the terminal banner
    // does not show a forever-spinning ActivityIndicator.
    expect(SessionScreenSrc).toMatch(/connectionPhase !== 'server_down' && \(\s*<RNActivityIndicator/);
  });

  it("shows the 'Server appears to be down' copy for server_down", () => {
    expect(SessionScreenSrc).toMatch(/connectionPhase === 'server_down'\s*\?\s*'Server appears to be down'/);
  });

  it('offers a Reconnect button wired to retryConnection (not Disconnect) when server_down', () => {
    expect(SessionScreenSrc).toMatch(/testID="server-down-reconnect"/);
    expect(SessionScreenSrc).toMatch(/onPress=\{retryConnection\}/);
    expect(SessionScreenSrc).toMatch(/<Text style=\{styles\.reconnectDisconnectText\}>Reconnect<\/Text>/);
  });
});
