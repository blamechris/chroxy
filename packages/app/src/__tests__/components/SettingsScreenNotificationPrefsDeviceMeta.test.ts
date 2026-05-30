/**
 * SettingsScreen — per-device lastSeenAt + platform metadata tests (#4587).
 *
 * Mirrors the dashboard surface in
 * `packages/dashboard/src/components/SettingsPanel.test.tsx` which renders
 * the same per-device list. Mobile sticks with static-source assertions
 * because RN primitives are impractical to render under Jest without a
 * heavy harness (same pattern as `SettingsScreenNotificationPrefsClearDevice`
 * and `SettingsScreenNotificationPrefsDevice`).
 *
 * The metadata is non-critical: operators with multiple orphan device
 * entries need a way to tell them apart before clicking Clear, but
 * pre-#4587 servers omit both fields and the row must degrade to the
 * legacy token-only render. The tests below pin both branches so a
 * regression that always renders the meta (or drops it entirely) trips
 * before any UI ships.
 */
import * as fs from 'fs';
import * as path from 'path';

const settingsSource = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SettingsScreen.tsx'),
  'utf-8',
);

describe('SettingsScreen — per-device meta surface (#4587)', () => {
  it('declares the optional lastSeenAt + platform fields on the KnownDevicesList devices prop', () => {
    // The prop type MUST carry the optional fields or the render branch
    // below trips a TS error. We anchor on the literal field names rather
    // than the full prop shape so the assertion stays small.
    expect(settingsSource).toMatch(/lastSeenAt\?:\s*number/);
    expect(settingsSource).toMatch(/platform\?:\s*string/);
  });

  it('renders a platform badge with the canonical testID when entry.platform is set', () => {
    // testID matches the dashboard naming
    // (`notification-prefs-device-platform-${key}`) so cross-surface tests
    // can share fixtures and Maestro can reach both screens uniformly.
    expect(settingsSource).toMatch(
      /testID=\{`notification-prefs-device-platform-\$\{key\}`\}/,
    );
  });

  it('renders a last-seen badge with the canonical testID when entry.lastSeenAt is set', () => {
    expect(settingsSource).toMatch(
      /testID=\{`notification-prefs-device-last-seen-\$\{key\}`\}/,
    );
  });

  it('guards both meta renders behind a truthiness check so pre-#4587 entries degrade cleanly', () => {
    // Without the guard, a pre-#4587 server snapshot (where neither field
    // is set) would render an empty `· ` separator inside the row.
    // Truthy-string + truthy-number check on each branch keeps the legacy
    // row identical to before. RN doesn't accept short-circuit `&& null`
    // gracefully inside parents that expect children, so the implementation
    // uses the ternary `entry.platform ? <Text/> : null` shape.
    expect(settingsSource).toMatch(/entry\.platform\s*\?\s*[\s\S]{0,400}notification-prefs-device-platform/);
    expect(settingsSource).toMatch(/entry\.lastSeenAt\s*\?\s*[\s\S]{0,400}notification-prefs-device-last-seen/);
  });

  it('imports formatPlatform + formatRelativeTime from the shared store-core package (#4591)', () => {
    // Pre-#4591 these were a verbatim local copy of the dashboard's helpers
    // (8 + 16 lines). Now both surfaces import from `@chroxy/store-core` so
    // the behaviour is exercised by one set of tests in `device-format.test.ts`
    // and a regression in either surface trips the shared suite.
    expect(settingsSource).toMatch(
      /import\s*\{[\s\S]{0,200}formatPlatform[\s\S]{0,200}formatRelativeTime[\s\S]{0,200}\}\s*from\s*'@chroxy\/store-core'/,
    );
  });

  it('does NOT carry a local copy of either helper (#4591 regression guard)', () => {
    // If a future refactor reintroduces the local copy, the two surfaces
    // drift again. Assert the function declarations are GONE from this file
    // so the shared import is the only call site.
    expect(settingsSource).not.toMatch(/function formatPlatform\(/);
    expect(settingsSource).not.toMatch(/function formatRelativeTime\(/);
  });

  it('uses a muted style for the meta text so it reads as secondary content', () => {
    // The deviceMetaText style maps to COLORS.textMuted (same hue as
    // section headers + hints elsewhere) — without it the meta would be
    // primary-coloured and visually compete with the token + Clear button.
    expect(settingsSource).toMatch(/deviceMetaText:\s*\{[\s\S]{0,200}color:\s*COLORS\.textMuted/);
  });
});
