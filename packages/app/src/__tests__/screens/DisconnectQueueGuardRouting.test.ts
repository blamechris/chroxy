/**
 * #6081 — All manual-disconnect entry points route through disconnectWithQueueGuard.
 *
 * Three UI affordances let the user give up the connection:
 *   1. App.tsx header "Disconnect" button (primary gap closed by #6081)
 *   2. ConnectScreen.tsx auto-connect "Cancel" button (#6081)
 *   3. SessionScreen.tsx reconnect-banner "Disconnect" button (handled by #6080/
 *      refactored in #6081 to delegate to the shared helper)
 *
 * This file verifies (via source-text parsing, following the pattern established
 * in SessionScreenQueuedCountBanner.test.ts) that none of these sites call
 * disconnect() directly — they all go through disconnectWithQueueGuard so the
 * unsent-queue discard warning is consistently shown.
 *
 * SettingsScreen.tsx is intentionally excluded — its disconnect is a settings-
 * reset action, not a "give up the connection" path, and is out of scope.
 */
import * as fs from 'fs';
import * as path from 'path';

const AppSrc = fs.readFileSync(
  path.resolve(__dirname, '../../App.tsx'),
  'utf-8',
);

const ConnectScreenSrc = fs.readFileSync(
  path.resolve(__dirname, '../../screens/ConnectScreen.tsx'),
  'utf-8',
);

const SessionScreenSrc = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SessionScreen.tsx'),
  'utf-8',
);

describe('App.tsx header Disconnect button (#6081)', () => {
  it('imports disconnectWithQueueGuard', () => {
    expect(AppSrc).toMatch(/import \{ disconnectWithQueueGuard \} from ['"]\.\/store\/disconnectWithQueueGuard['"]/);
  });

  it('uses disconnectWithQueueGuard as the onPress handler (not a raw disconnect() call)', () => {
    expect(AppSrc).toMatch(/onPress=\{disconnectWithQueueGuard\}/);
  });

  it('does NOT call useConnectionStore.getState().disconnect() for the header button', () => {
    // The old pattern was: onPress={() => useConnectionStore.getState().disconnect()}
    // After the fix, the ONLY getState() calls should be the ones inside the store helper,
    // not at the call sites. Verify this file no longer has the direct getState disconnect.
    expect(AppSrc).not.toMatch(/onPress=\{\(\) => useConnectionStore\.getState\(\)\.disconnect\(\)\}/);
  });
});

describe('ConnectScreen.tsx auto-connect Cancel button (#6081)', () => {
  it('imports disconnectWithQueueGuard', () => {
    expect(ConnectScreenSrc).toMatch(/import \{ disconnectWithQueueGuard \} from ['"]\.\.\/store\/disconnectWithQueueGuard['"]/);
  });

  it('calls disconnectWithQueueGuard() in the Cancel onPress handler', () => {
    expect(ConnectScreenSrc).toMatch(/disconnectWithQueueGuard\(\)/);
  });

  it('does NOT call useConnectionStore.getState().disconnect() in the Cancel handler', () => {
    // The old auto-connect cancel called useConnectionStore.getState().disconnect() inline.
    // After the fix, it should go through the guard instead.
    expect(ConnectScreenSrc).not.toMatch(/useConnectionStore\.getState\(\)\.disconnect\(\)/);
  });
});

describe('SessionScreen.tsx reconnect banner Disconnect (#6081 — DRY refactor of #6080)', () => {
  it('imports disconnectWithQueueGuard', () => {
    expect(SessionScreenSrc).toMatch(/import \{ disconnectWithQueueGuard \} from ['"]\.\.\/store\/disconnectWithQueueGuard['"]/);
  });

  it('handleStopReconnecting is assigned to disconnectWithQueueGuard (no inline copy)', () => {
    expect(SessionScreenSrc).toMatch(/const handleStopReconnecting = disconnectWithQueueGuard/);
  });

  it('reconnect banner still wires Disconnect affordance to handleStopReconnecting', () => {
    // The JSX reference stays the same — only the implementation moved.
    expect(SessionScreenSrc).toMatch(/onPress=\{handleStopReconnecting\}/);
  });

  it('does NOT contain a second inline Alert.alert("Discard unsent messages?" …) copy', () => {
    // There must be exactly zero inline Discard-unsent-messages Alert calls in
    // SessionScreen now that the logic lives in the shared helper.
    const matches = SessionScreenSrc.match(/Alert\.alert\(\s*'Discard unsent messages\?'/g);
    expect(matches).toBeNull();
  });
});
