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

  it('rewrites the canonical platform values through formatPlatform()', () => {
    // `ios` -> `iOS`, `android` -> `Android`, etc. — without the rewrite
    // operators see lowercase tags that read as a debug string. Anchor on
    // the function definition + a representative case so a future addition
    // (web/desktop already present) doesn't accidentally drop the iOS case.
    expect(settingsSource).toMatch(/function formatPlatform\(p: string\)/);
    expect(settingsSource).toMatch(/case 'ios':\s*return 'iOS'/);
    expect(settingsSource).toMatch(/case 'android':\s*return 'Android'/);
  });

  it('declares formatRelativeTime with minute-granularity output and forward-skew fallback', () => {
    // Two anchors: (1) the function exists and rounds down to minutes,
    // (2) future timestamps (clock skew) render "just now" rather than a
    // negative duration. Both fail-safes were spelled out in #4587.
    expect(settingsSource).toMatch(/function formatRelativeTime\(epochMs: number\)/);
    expect(settingsSource).toMatch(/if \(diffMs < 0\) return 'just now'/);
    expect(settingsSource).toMatch(/Math\.floor\(diffMs \/ 60_000\)/);
  });

  it('uses a muted style for the meta text so it reads as secondary content', () => {
    // The deviceMetaText style maps to COLORS.textMuted (same hue as
    // section headers + hints elsewhere) — without it the meta would be
    // primary-coloured and visually compete with the token + Clear button.
    expect(settingsSource).toMatch(/deviceMetaText:\s*\{[\s\S]{0,200}color:\s*COLORS\.textMuted/);
  });
});
