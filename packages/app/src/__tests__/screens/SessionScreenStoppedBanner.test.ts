/**
 * #4879 — SessionScreen quiet "Session stopped." status strip.
 *
 * The banner renders when the server confirms a user-initiated Stop via
 * the `session_stopped` wire message (wired in #4868). Intentionally
 * informational rather than error-styled: positive confirmation that
 * the Stop tap landed, distinct from the loud red `health: 'crashed'`
 * banner reserved for unexpected exits.
 *
 * No `@testing-library/react-native` in this repo (see
 * `useSpeechRecognition.test.ts:21` for the same pattern note), so this
 * suite verifies the wire-up via source-text parsing — same gating
 * style as `SessionOverview.test.ts`. The runtime behaviour (handler
 * sets `stoppedAt`/`stoppedCode`; `claude_ready` clears them) is
 * exercised in `__tests__/store/message-handler.test.ts` against the
 * real reducer.
 */
import * as fs from 'fs';
import * as path from 'path';

const SessionScreenSrc = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SessionScreen.tsx'),
  'utf-8',
);

describe('SessionScreen stopped status strip (#4879)', () => {
  it('subscribes to activeSessionStoppedAt and activeSessionStoppedCode selectors', () => {
    // Both fields must be selected from the store so the banner re-renders
    // when the case branch flips them.
    expect(SessionScreenSrc).toMatch(/const activeSessionStoppedAt = useConnectionStore/);
    expect(SessionScreenSrc).toMatch(/const activeSessionStoppedCode = useConnectionStore/);
  });

  it('selectors read stoppedAt / stoppedCode off the active session state', () => {
    expect(SessionScreenSrc).toMatch(/sessionStates\[id\]\.stoppedAt/);
    expect(SessionScreenSrc).toMatch(/sessionStates\[id\]\.stoppedCode/);
  });

  it('renders the banner only when activeSessionStoppedAt is non-null', () => {
    // The conditional must include the non-null guard — otherwise the
    // banner would render on every session (`stoppedAt: null` is the
    // not-stopped state).
    expect(SessionScreenSrc).toMatch(/activeSessionStoppedAt !== null/);
  });

  it("suppresses the stopped banner when health === 'crashed' (no double-banner)", () => {
    // Defensive: the server only emits stopped for clean exits, but if a
    // race ever surfaces both we want the louder crash banner to win.
    expect(SessionScreenSrc).toMatch(/activeSessionHealth !== 'crashed' && activeSessionStoppedAt !== null/);
  });

  it("renders bare 'Session stopped.' when code is 0 or null (clean exit, no decoration)", () => {
    // The ternary's else branch (code === 0 or code === null) emits the
    // bare string — keep that in sync with the dashboard's #4878 copy.
    expect(SessionScreenSrc).toMatch(/'Session stopped\.'/);
  });

  it("renders 'Session stopped. exit N' suffix for non-zero codes (e.g. 143 = SIGTERM)", () => {
    expect(SessionScreenSrc).toMatch(/Session stopped\. exit \$\{activeSessionStoppedCode\}/);
  });

  it('uses informational stoppedBanner style (NOT errorBanner / warningBanner)', () => {
    // The banner must be visually distinct from session_error's red
    // strip and from server-error warnings — that's the whole point of
    // a "quiet" confirmation.
    expect(SessionScreenSrc).toMatch(/styles\.stoppedBanner/);
    expect(SessionScreenSrc).toMatch(/styles\.stoppedBannerText/);
  });

  it('stoppedBanner style is defined with a muted background (greyed out, not accent-coloured)', () => {
    // backgroundCard is the muted surface used elsewhere for inactive
    // chrome; explicitly NOT accentRedSubtle / accentOrangeSubtle which
    // are reserved for crash / warning banners.
    expect(SessionScreenSrc).toMatch(/stoppedBanner: \{[^}]*backgroundColor: COLORS\.backgroundCard/);
    expect(SessionScreenSrc).toMatch(/stoppedBannerText: \{[^}]*color: COLORS\.textMuted/);
  });

  it('exposes testID hooks for Maestro / runtime assertions', () => {
    expect(SessionScreenSrc).toMatch(/testID="session-stopped-banner"/);
    expect(SessionScreenSrc).toMatch(/testID="session-stopped-banner-text"/);
  });

  it('does NOT push a session notification or fire an Alert from the case branch', () => {
    // The case branch in message-handler.ts must not show modal UI or
    // push a notification — the inline strip carries the full signal.
    const msgHandlerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../store/message-handler.ts'),
      'utf-8',
    );
    // Locate just the case body so we don't trip over unrelated Alert
    // calls elsewhere in the dispatcher.
    const caseBlock = msgHandlerSrc.match(/case 'session_stopped':\s*\{([\s\S]*?)\n {4}\}/);
    expect(caseBlock).not.toBeNull();
    const body = caseBlock![1];
    expect(body).not.toMatch(/Alert\.alert/);
    expect(body).not.toMatch(/pushSessionNotification/);
    expect(body).not.toMatch(/addServerError/);
  });
});
