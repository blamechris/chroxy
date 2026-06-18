/**
 * SettingsScreen — per-device "Clear" UI tests (#4564)
 *
 * Mirrors the static-source style used by SettingsScreenNotificationPrefsDevice
 * (#4543). Verifies the new known-devices list surfaces a Clear button per
 * row, wires it through the connection store's `deleteNotificationPrefsDevice`
 * action, and threads the WS-closed banner the same way the rest of the
 * notification-prefs handlers do.
 *
 * The same orphan-clearing semantics apply on dashboard (`SettingsPanel.tsx`)
 * — that surface gets fuller render-time coverage in
 * `SettingsPanel.test.tsx`. Mobile sticks with static-source assertions
 * because the SettingsScreen pulls in React Native primitives that are
 * impractical to render under Jest without a heavy harness.
 */
import * as fs from 'fs';
import * as path from 'path';

// #5655: the notification-prefs UI was extracted from SettingsScreen.tsx
// into `src/components/settings/*`. Read the screen plus every extracted
// settings component so the static-source assertions keep matching.
const settingsDir = path.resolve(__dirname, '../../components/settings');
const settingsSource = [
  fs.readFileSync(path.resolve(__dirname, '../../screens/SettingsScreen.tsx'), 'utf-8'),
  ...fs
    .readdirSync(settingsDir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => fs.readFileSync(path.resolve(settingsDir, f), 'utf-8')),
].join('\n');

const typesSource = fs.readFileSync(
  path.resolve(__dirname, '../../store/types.ts'),
  'utf-8',
);

const connectionSource = fs.readFileSync(
  path.resolve(__dirname, '../../store/connection.ts'),
  'utf-8',
);

describe('SettingsScreen — per-device Clear surface (#4564)', () => {
  it('selects deleteNotificationPrefsDevice from the connection store', () => {
    // Without selecting the action, the row's onPress can't reach the
    // wire — guard so a refactor that drops the selector trips this test
    // before any UI ships.
    expect(settingsSource).toMatch(
      /deleteNotificationPrefsDevice\s*=\s*useConnectionStore/,
    );
  });

  it('renders a per-row Clear button under the known-devices list', () => {
    // testID anchors the per-row affordance for both Maestro E2E and the
    // dashboard's matching `notification-prefs-device-clear-${key}` pattern.
    expect(settingsSource).toMatch(
      /testID=\{`notification-prefs-device-clear-\$\{key\}`\}/,
    );
  });

  it('wires the Clear button onPress through a thin handler that hits the store action', () => {
    // The handler must call `deleteNotificationPrefsDevice(deviceKey)` AND
    // funnel through `handleClearDevice` so the WS-closed boolean return can
    // drive `setNotifWsClosedError`. A direct call would skip the banner —
    // identical pattern to handleSetDevice (#4559).
    expect(settingsSource).toMatch(
      /handleClearDevice\s*=\s*useCallback[\s\S]{0,400}deleteNotificationPrefsDevice\(deviceKey\)/,
    );
    expect(settingsSource).toMatch(
      /onPress=\{\(\) => onClear\(key\)\}/,
    );
  });

  it('threads the WS-closed banner from the Clear handler', () => {
    // Same banner contract as the other notification-prefs handlers
    // (#4559): on `false`, set the inline message so the user knows the
    // delete did not reach the server.
    expect(settingsSource).toMatch(
      /handleClearDevice[\s\S]{0,400}setNotifWsClosedError\(sent \? null : WS_CLOSED_MESSAGE\)/,
    );
  });

  it('renders an empty-state hint when no per-device entries exist', () => {
    // Always-rendered list (even when empty) so users find the surface
    // for later. The testID makes the empty branch addressable.
    expect(settingsSource).toMatch(/testID="notification-prefs-devices-empty"/);
  });

  it('tags the row matching the current device with a "(this device)" marker', () => {
    // A misclick on the wrong row would mute the device the operator is
    // currently using — the marker is the cheap defensive cue. The
    // implementation flips `isCurrent` against `currentDeviceKey` and
    // appends the tag inline.
    expect(settingsSource).toMatch(/\(this device\)/);
  });

  it('emits a testID per device row keyed by the raw device key', () => {
    // E2E discovery for a specific row. Matches the dashboard naming
    // (notification-prefs-device-entry-${key}) so cross-surface tests can
    // share fixtures.
    expect(settingsSource).toMatch(
      /testID=\{`notification-prefs-device-entry-\$\{key\}`\}/,
    );
  });
});

describe('ConnectionState — deleteNotificationPrefsDevice surface (#4564)', () => {
  it('declares deleteNotificationPrefsDevice with (deviceKey) => boolean signature', () => {
    // Same fail-loud `boolean` return as the other notification-prefs
    // setters (#4559) so UI can branch on socket-closed.
    expect(typesSource).toMatch(
      /deleteNotificationPrefsDevice:\s*\(deviceKey:\s*string\)\s*=>\s*boolean/,
    );
  });
});

describe('SettingsScreen — current-device clear confirmation (#4588)', () => {
  it('prompts via Alert.alert before clearing when deviceKey matches the current pushToken', () => {
    // The (this device) row silently wipes the operator's own mutes /
    // quiet-hours overrides if cleared by accident — the prompt is a
    // second cue after the (this device) tag.
    expect(settingsSource).toMatch(
      /handleClearDevice\s*=\s*useCallback[\s\S]{0,800}deviceKey === pushToken[\s\S]{0,400}Alert\.alert/,
    );
  });

  it('uses a destructive Clear button alongside Cancel in the alert (#4588)', () => {
    // Matches the existing pattern for handleClearSessionHistory /
    // handleClearSavedConnection — destructive styles the action red on
    // both platforms so the operator reads the affordance as risky.
    expect(settingsSource).toMatch(
      /handleClearDevice[\s\S]{0,800}style: 'cancel'[\s\S]{0,200}style: 'destructive'/,
    );
  });

  it('falls through to the dispatch when deviceKey !== pushToken (orphan rows stay one-tap)', () => {
    // Without the early-return inside the `if (deviceKey === pushToken)`
    // branch, orphan-row clears would also be gated behind Alert.alert —
    // exactly the behaviour the issue text rules out.
    expect(settingsSource).toMatch(
      /if\s*\(deviceKey === pushToken\)[\s\S]{0,600}return;[\s\S]{0,200}dispatch\(\);/,
    );
  });
});

describe('connection.ts — delete action wiring (#4564)', () => {
  it('sends a notification_prefs_set with `devices: { [deviceKey]: null }` as the patch', () => {
    // The null sentinel is the on-wire convention the server interprets
    // as delete. Without it the server's shallow-merge would just set the
    // entry to null and keep the key — exactly the bug #4564 is fixing.
    expect(connectionSource).toMatch(
      /deleteNotificationPrefsDevice[\s\S]{0,1500}notification_prefs_set[\s\S]{0,400}devices:\s*\{[\s\S]{0,200}\[deviceKey\]:\s*null/,
    );
  });

  it('short-circuits when deviceKey is empty', () => {
    // Defensive: never ship a `devices[""]` patch. Mirrors the
    // setNotificationPrefsDevice guard.
    expect(connectionSource).toMatch(
      /deleteNotificationPrefsDevice[\s\S]{0,400}if\s*\(!deviceKey\)\s*return/,
    );
  });

  it('drops the local snapshot entry optimistically before the broadcast lands', () => {
    // The Settings row should disappear the moment the user taps Clear —
    // waiting for the WS round-trip + broadcast over a cellular Cloudflare
    // tunnel leaves the user wondering if the tap registered. The store
    // mutates `notificationPrefs.devices` to drop the key before sending.
    expect(connectionSource).toMatch(
      /deleteNotificationPrefsDevice[\s\S]{0,1500}set\(\s*\{\s*notificationPrefs:[\s\S]{0,500}devices:\s*rest/,
    );
  });
});
