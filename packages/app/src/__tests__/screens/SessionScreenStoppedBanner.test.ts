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
import { DISPATCH_TABLE_TYPES } from '@chroxy/store-core';

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

  it("renders 'Session stopped. (exit N)' suffix for non-zero codes (e.g. 143 = SIGTERM)", () => {
    // #4910: aligned with the dashboard's parenthesised form ("Session
    // stopped. (exit N)") so both surfaces speak with one voice. The
    // protocol doc-comment already uses bare "Session stopped." for the
    // common case, and parentheses are the conventional wrapper for a
    // diagnostic suffix.
    expect(SessionScreenSrc).toMatch(/Session stopped\. \(exit \$\{activeSessionStoppedCode\}\)/);
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

  it('shows no modal / notification / toast — migrated to the shared dispatch table (#5618 Batch 3)', () => {
    // session_stopped moved out of the app's local switch into the shared
    // store-core dispatch table; the app deliberately stays quiet (#4879 — the
    // inline strip carries the full signal). It reproduces that by OMITTING the
    // `addInfoNotification` adapter hook the dashboard supplies, so the
    // dispatcher's `adapter.addInfoNotification?.(...)` is a no-op on mobile.
    const msgHandlerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../store/message-handler.ts'),
      'utf-8',
    );
    // No local case branch remains.
    expect(msgHandlerSrc).not.toMatch(/case 'session_stopped':/);
    // The app adapter does NOT wire the info-toast hook (the dashboard does) —
    // i.e. no `addInfoNotification:` property in the adapter object (a comment
    // mentioning the hook by name is fine; the property definition is not).
    expect(msgHandlerSrc).not.toMatch(/addInfoNotification\s*:/);
    // And the type is owned by the shared table.
    expect(DISPATCH_TABLE_TYPES).toContain('session_stopped');
  });
});
