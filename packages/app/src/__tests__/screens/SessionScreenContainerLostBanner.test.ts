/**
 * #7603 — SessionScreen container-stopped banner.
 *
 * The banner renders when the server reports the session's Docker container is
 * no longer running (`error{code:'CONTAINER_VANISHED'}`, #7599). It is
 * deliberately NOT the crash banner: the daemon re-enters the container on its
 * own once it is back (#7602), so the crash copy ("Session crashed. Delete this
 * session to free resources.") would push the user to destroy a session that is
 * about to recover.
 *
 * No `@testing-library/react-native` in this repo (same note as
 * `SessionScreenStoppedBanner.test.ts`), so the render wiring is verified by
 * source-text parsing. The RUNTIME half — that the handler sets and releases
 * the fields — is exercised against the real reducer in
 * `__tests__/store/container-lost.test.ts`, which is where the behavioural
 * claims live.
 *
 * Assertions collapse to a boolean before comparing rather than
 * `expect(src).toMatch(...)`: SessionScreen.tsx is ~90KB and a failing
 * `toMatch` carries the entire file as the diff payload (the #7340 / #7401
 * lesson). The label keeps the failure legible without it.
 */
import * as fs from 'fs';
import * as path from 'path';

const SessionScreenSrc = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SessionScreen.tsx'),
  'utf-8',
);

/**
 * Assert `re` matches, reporting only the label on failure. Jest would
 * otherwise print the whole ~90KB subject.
 */
function expectSrc(label: string, re: RegExp, src = SessionScreenSrc) {
  expect(`${label}: ${re.test(src) ? 'found' : 'MISSING'}`).toBe(`${label}: found`);
}

function expectNotSrc(label: string, re: RegExp, src = SessionScreenSrc) {
  expect(`${label}: ${re.test(src) ? 'PRESENT' : 'absent'}`).toBe(`${label}: absent`);
}

describe('SessionScreen container-stopped banner (#7603)', () => {
  it('subscribes to both container-health fields off the active session', () => {
    expectSrc('containerLostAt selector', /const activeContainerLostAt = useConnectionStore/);
    expectSrc('reattachError selector', /const activeContainerReattachError = useConnectionStore/);
    expectSrc('reads containerLostAt', /sessionStates\[id\]\.containerLostAt/);
    expectSrc('reads containerReattachError', /sessionStates\[id\]\.containerReattachError/);
  });

  it('renders the banner only when containerLostAt is non-null', () => {
    // `containerLostAt: null` is the healthy state — without the guard the
    // banner would render on every session.
    expectSrc('non-null guard', /activeContainerLostAt !== null/);
  });

  it('suppresses the banner under the crash banner (no double-banner)', () => {
    expectSrc(
      'crash outranks container-lost',
      /activeSessionHealth !== 'crashed' && activeContainerLostAt !== null/,
    );
  });

  it('suppresses the STOPPED strip while the container-lost banner is up', () => {
    // The third rung of the ladder (crashed > container-lost > stopped). Two
    // banners on one session read as two separate faults; before #7603 the
    // stopped strip's condition was `health !== 'crashed' && stoppedAt !== null`
    // with nothing between them.
    expectSrc(
      'stopped strip yields',
      /activeSessionHealth !== 'crashed' && activeContainerLostAt === null && activeSessionStoppedAt !== null/,
    );
  });

  it('uses reconnect-oriented copy, never the crash / delete wording', () => {
    // The regression this guards is the issue's stated failure mode: reusing
    // the crash render path would mislead the user about a recoverable state.
    expectSrc('waiting copy', /will re-enter it automatically/);
    expectSrc('refused copy', /could not re-enter it/);
    // Scope the negative to the banner's OWN JSX block, ending before the
    // stopped strip that follows it. `'crashed'` is a legitimate health value
    // this block reads in its own suppression guard, so the negative names the
    // crash-copy TOKENS rather than the substring "crash".
    const start = SessionScreenSrc.indexOf('testID="container-lost-banner"');
    const end = SessionScreenSrc.indexOf('#7603: the stopped strip', start);
    // Control: both anchors resolved and bracket a real slice, so the negative
    // assertions below cannot pass against an empty string.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SessionScreenSrc.slice(start, end);
    expect(block).toContain('container-lost-banner-dismiss');
    expectNotSrc('no "Session crashed" copy', /Session crashed/, block);
    expectNotSrc('no delete-the-session copy', /[Dd]elete this session|Delete Crashed/, block);
    expectNotSrc('no "free resources" copy', /free resources/, block);
    expectNotSrc('no destroySession call in banner', /destroySession/, block);
  });

  it('branches its copy on whether re-entry was already refused', () => {
    expectSrc('variant ternary', /activeContainerReattachError\s*\n?\s*\?/);
  });

  it('offers a dismiss affordance wired to the store action', () => {
    expectSrc('dismiss action subscribed', /const dismissContainerLost = useConnectionStore/);
    expectSrc('dismiss wired', /dismissContainerLost\(activeSessionId\)/);
  });

  it('gives the dismiss control a >= 48dp tap target (Material floor)', () => {
    // The repo's rule is 44pt minimum with 48dp preferred on mobile. The banner
    // row has the height, so the visible control IS the hit area rather than an
    // undersized box widened invisibly by hitSlop.
    expectSrc(
      'dismiss style >= 48',
      /containerLostDismiss: \{[^}]*minWidth: 48[^}]*minHeight: 48/,
    );
    expectSrc('dismiss uses that style', /style=\{styles\.containerLostDismiss\}/);
  });

  it('uses the warning surface, not the red crash surface', () => {
    // Amber, not red: recoverable, needs attention, not fatal.
    expectSrc('warning banner style', /testID="container-lost-banner"[\s\S]{0,200}styles\.warningBanner/);
  });

  it('exposes testID hooks for Maestro / runtime assertions', () => {
    expectSrc('banner testID', /testID="container-lost-banner"/);
    expectSrc('text testID', /testID="container-lost-banner-text"/);
    expectSrc('dismiss testID', /testID="container-lost-banner-dismiss"/);
  });

  it('labels the dismiss control for assistive tech', () => {
    expectSrc('a11y label', /accessibilityLabel="Dismiss container-stopped notice"/);
  });
});
