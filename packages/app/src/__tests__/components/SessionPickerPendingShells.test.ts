import * as fs from 'fs';
import * as path from 'path';

/**
 * SessionPicker pill chip — pending-background-shell badge (#4422).
 *
 * Companion to the dashboard's ActivityIndicator pending-shells surface
 * (#4419 / #4418). The mobile parity surface lives in two places:
 *
 *  1. The ActivityIndicator (active-session chat header) — covered by
 *     packages/app/src/components/__tests__/ActivityIndicator.pendingShells.test.tsx.
 *  2. The SessionPicker pill (sessions-list row) — covered here.
 *
 * The pill renders a small "z" badge when a session is otherwise idle but
 * has pendingBackgroundShells, so users on the phone can spot "idle and
 * done" vs "idle but parked on a backgrounded shell" without opening the
 * session. Source-text assertions follow the existing
 * SessionPickerProviderBadge.test.ts pattern.
 */
describe('SessionPicker pill chip — pending-background-shell badge (#4422)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionPicker.tsx'),
    'utf-8',
  );

  const pillStartIdx = source.indexOf('function SessionPill');
  const pillEndIdx = source.indexOf('interface SessionPickerProps', pillStartIdx);
  if (pillStartIdx < 0 || pillEndIdx < 0 || pillEndIdx <= pillStartIdx) {
    throw new Error(
      'Unable to locate the SessionPill render block in SessionPicker.tsx',
    );
  }
  const pillSection = source.slice(pillStartIdx, pillEndIdx);

  it('takes a pendingShellCount prop on the pill so the badge gates on it', () => {
    // The picker passes pendingBackgroundShells.length down from
    // sessionStates — the pill component needs the value plumbed in.
    expect(pillSection).toMatch(/pendingShellCount/);
  });

  it('only renders the pending-shells indicator when idle (showBusy=false) and the count > 0', () => {
    // Pending shells are SECONDARY: when the session is actively busy,
    // the existing PulsingDot wins. Pre-merge regression lock — match
    // the gate so a future refactor that flips it gets caught.
    expect(pillSection).toMatch(/!showBusy[\s\S]*pendingShellCount\s*>\s*0/);
  });

  it('renders a pendingShellsDot inside the indicators view with its dedicated style', () => {
    expect(pillSection).toMatch(/styles\.pendingShellsDot/);
  });

  it('SessionPicker passes pendingBackgroundShells.length to the pill', () => {
    // The picker reads sessionStates[sessionId]?.pendingBackgroundShells
    // and projects the length down to the pill. Source-text check that
    // the wiring is in place.
    expect(source).toMatch(/pendingBackgroundShells\?\.length/);
  });

  it('styles.pendingShellsDot is defined in the StyleSheet', () => {
    expect(source).toMatch(/pendingShellsDot:\s*\{/);
  });
});
