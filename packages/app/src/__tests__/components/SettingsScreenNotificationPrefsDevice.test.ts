/**
 * SettingsScreen — per-device notification opt-in/out UI tests (#4543)
 *
 * Mirrors the per-category test file (#4542): static source analysis is the
 * dominant mobile-app test style for screens that compose Zustand selectors
 * + RN primitives. This file covers ONLY the per-device additions; the
 * per-category surface stays under SettingsScreenNotificationPrefs.test.ts.
 *
 * The per-device key on mobile is the registered Expo push token (stored in
 * `pushToken` on the connection store once `register_push_token` succeeds).
 * On the dashboard the equivalent is a localStorage `device-id`; both flow
 * through the same `notification_prefs.devices` map keyed by an opaque
 * string of the client's choosing.
 */
import * as fs from 'fs';
import * as path from 'path';

const settingsSource = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SettingsScreen.tsx'),
  'utf-8',
);

const typesSource = fs.readFileSync(
  path.resolve(__dirname, '../../store/types.ts'),
  'utf-8',
);

const connectionSource = fs.readFileSync(
  path.resolve(__dirname, '../../store/connection.ts'),
  'utf-8',
);

const messageHandlerSource = fs.readFileSync(
  path.resolve(__dirname, '../../store/message-handler.ts'),
  'utf-8',
);

describe('SettingsScreen — per-device opt-in/out section (#4543)', () => {
  it('selects pushToken from the connection store as the per-device key source', () => {
    // The Expo push token is the addressing key for THIS device's entry
    // in `notification_prefs.devices`. Without selecting it, the UI can't
    // patch a device-specific override.
    expect(settingsSource).toMatch(/pushToken\s*=\s*useConnectionStore/);
  });

  it('selects setNotificationPrefsDevice from the store', () => {
    expect(settingsSource).toMatch(/setNotificationPrefsDevice\s*=\s*useConnectionStore/);
  });

  it('renders a "Mute on this device" label for each category', () => {
    expect(settingsSource).toMatch(/Mute on this device/);
  });

  it('emits a testID per per-device toggle for E2E discovery', () => {
    expect(settingsSource).toMatch(/testID=\{`notification-prefs-device-toggle-\$\{cat\}`\}/);
  });

  it('passes (pushToken, cat, !value) so a checked "mute" maps to enabled=false on the wire', () => {
    // The per-device Switch onValueChange MUST invert the boolean because
    // the user-facing affordance is "mute" (true = muted) while the wire
    // patch carries `enabled` (true = on). Without the negation a tap-to-mute
    // would actually un-mute the category.
    expect(settingsSource).toMatch(
      /onValueChange=\{\(value\) => setNotificationPrefsDevice\(pushToken, cat, !value\)\}/,
    );
  });

  it('suppresses the per-device toggle when no pushToken is available yet', () => {
    // If push registration hasn't completed (permission denied, simulator,
    // etc.), pushToken is null. Rendering a per-device toggle in that state
    // would silently ship a `devices[null]` patch — guard at render time.
    expect(settingsSource).toMatch(/pushToken\s*&&/);
  });
});

describe('ConnectionState — per-device push token surface (#4543)', () => {
  it('declares pushToken on the connection state', () => {
    // The token is sourced once at register_push_token time and persists
    // across the connection's lifetime so per-device toggles always
    // address the same `devices` entry.
    expect(typesSource).toMatch(/pushToken:\s*string\s*\|\s*null/);
  });

  it('declares setNotificationPrefsDevice with (deviceKey, category, enabled) signature', () => {
    expect(typesSource).toMatch(
      /setNotificationPrefsDevice:\s*\(deviceKey:\s*string,\s*category:\s*string,\s*enabled:\s*boolean\)\s*=>\s*void/,
    );
  });
});

describe('connection.ts — per-device action wiring (#4543)', () => {
  it('initializes pushToken to null', () => {
    expect(connectionSource).toMatch(/pushToken:\s*null/);
  });

  it('clears pushToken on disconnect so a reconnect cycle re-registers', () => {
    // Two assignments: initial + the disconnect/reset block. If the reset
    // ever drops, a stale token would survive across reconnects to a
    // different host — addressing the wrong device's override map.
    const matches = connectionSource.match(/pushToken:\s*null/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('setNotificationPrefsDevice sends a single-device notification_prefs_set patch', () => {
    expect(connectionSource).toMatch(
      /setNotificationPrefsDevice[\s\S]{0,400}notification_prefs_set[\s\S]{0,300}devices:\s*\{[\s\S]{0,200}\[deviceKey\]:[\s\S]{0,200}categories:[\s\S]{0,80}\[category\]:\s*enabled/,
    );
  });

  it('short-circuits the per-device action when deviceKey is empty', () => {
    // Defensive: even if the UI rail ever drops, the action MUST refuse to
    // ship a `devices[""]` patch which would pollute the map indefinitely.
    expect(connectionSource).toMatch(/setNotificationPrefsDevice[\s\S]{0,300}if\s*\(!deviceKey\)\s*return/);
  });
});

describe('message-handler.ts — push token round-trip (#4543)', () => {
  it('mirrors the registered push token into the connection store', () => {
    // The token returned from registerForPushNotifications() MUST be
    // assigned to the store so the SettingsScreen can address THIS device's
    // override entry; without the mirror the screen never knows which key
    // it's patching. We anchor on the resolved `token` variable being
    // forwarded into setState so a refactor that decouples the await from
    // the setState (separate fn, hook etc.) still trips this guard.
    expect(messageHandlerSource).toMatch(
      /await\s+registerForPushNotifications\(\)[\s\S]{0,800}setState\(\s*\{\s*pushToken:\s*token\s*\}\s*\)/,
    );
  });
});
