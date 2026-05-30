/**
 * SettingsScreen — per-category notification preferences UI tests (#4542)
 *
 * Mirrors the existing SettingsScreenSessionRules pattern (#2434): static
 * source analysis is the dominant mobile-app test style for screens that
 * compose Zustand selectors + RN primitives.
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

describe('SettingsScreen — Notification categories section (#4542)', () => {
  it('renders a NOTIFICATION CATEGORIES section header', () => {
    expect(settingsSource).toMatch(/NOTIFICATION CATEGORIES/);
  });

  it('reads notificationPrefs from the connection store', () => {
    expect(settingsSource).toMatch(/notificationPrefs\s*=\s*useConnectionStore/);
  });

  it('selects refreshNotificationPrefs from the store', () => {
    expect(settingsSource).toMatch(/refreshNotificationPrefs\s*=\s*useConnectionStore/);
  });

  it('selects setNotificationPrefsCategory from the store', () => {
    expect(settingsSource).toMatch(/setNotificationPrefsCategory\s*=\s*useConnectionStore/);
  });

  it('calls refreshNotificationPrefs on mount via useEffect', () => {
    // The useEffect body must invoke refreshNotificationPrefs(); the
    // dependency array must include the action so React doesn't warn.
    expect(settingsSource).toMatch(/useEffect\([\s\S]{0,200}refreshNotificationPrefs\(\)/);
  });

  it('shows a loading hint until the first snapshot lands', () => {
    expect(settingsSource).toMatch(/notification-prefs-loading/);
    expect(settingsSource).toMatch(/Loading preferences/);
  });

  it('labels every category from the server-side RATE_LIMITS enum', () => {
    // These labels MUST exist so the mobile-side stays in sync with
    // packages/server/src/notification-prefs.js ALL_CATEGORIES.
    expect(settingsSource).toMatch(/permission:.*Permission requests/);
    expect(settingsSource).toMatch(/result:.*Task completion/);
    expect(settingsSource).toMatch(/activity_update:.*Activity updates/);
    expect(settingsSource).toMatch(/activity_waiting:.*Waiting for input/);
    expect(settingsSource).toMatch(/activity_error:.*Session errors/);
    expect(settingsSource).toMatch(/inactivity_warning:.*Inactivity warnings/);
    expect(settingsSource).toMatch(/live_activity:.*Live Activity/);
  });

  it('passes the toggled value through Switch.onValueChange to setNotificationPrefsCategory', () => {
    // The Switch component MUST forward the new boolean — not the
    // category name — as the second arg.
    expect(settingsSource).toMatch(/onValueChange=\{\(value\) => setNotificationPrefsCategory\(cat, value\)\}/);
  });

  it('emits a testID per category toggle for E2E + a11y discovery', () => {
    expect(settingsSource).toMatch(/testID=\{`notification-prefs-toggle-\$\{cat\}`\}/);
  });

  it('orders categories deterministically so the UI does not jitter on every snapshot', () => {
    expect(settingsSource).toMatch(/NOTIFICATION_CATEGORY_ORDER/);
  });
});

describe('ConnectionState — notification prefs surface (#4542)', () => {
  it('declares notificationPrefs in ServerNotificationData', () => {
    expect(typesSource).toMatch(/notificationPrefs:\s*\{[\s\S]{0,400}categories:\s*Record<string,\s*boolean>/);
  });

  it('declares refreshNotificationPrefs in ServerNotificationActions', () => {
    expect(typesSource).toMatch(/refreshNotificationPrefs:\s*\(\)\s*=>\s*void/);
  });

  it('declares setNotificationPrefsCategory with (category, enabled) signature', () => {
    expect(typesSource).toMatch(/setNotificationPrefsCategory:\s*\(category:\s*string,\s*enabled:\s*boolean\)\s*=>\s*void/);
  });
});

describe('connection.ts — notification prefs actions (#4542)', () => {
  it('initializes notificationPrefs to null', () => {
    expect(connectionSource).toMatch(/notificationPrefs:\s*null/);
  });

  it('clears notificationPrefs on disconnect so the next connect refetches', () => {
    // Two assignments: initial + the disconnect/reset block. If the reset
    // ever drops, a stale snapshot would survive across reconnects to a
    // different host.
    const matches = connectionSource.match(/notificationPrefs:\s*null/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('refreshNotificationPrefs sends notification_prefs_get over the socket', () => {
    expect(connectionSource).toMatch(/refreshNotificationPrefs[\s\S]{0,300}notification_prefs_get/);
  });

  it('setNotificationPrefsCategory sends a single-category notification_prefs_set patch', () => {
    // Window widened to 1200 chars in #4558 to accommodate the optimistic
    // local-state patch (~350 chars of `set({...})` + comment) that now
    // sits between the function declaration and the `wsSend` call.
    expect(connectionSource).toMatch(
      /setNotificationPrefsCategory[\s\S]{0,1200}notification_prefs_set[\s\S]{0,200}\[category\]:\s*enabled/,
    );
  });
});

describe('message-handler.ts — notification_prefs WS message (#4542)', () => {
  it('imports ServerNotificationPrefsSchema from @chroxy/protocol/schemas', () => {
    expect(messageHandlerSource).toMatch(/import\s*\{\s*ServerNotificationPrefsSchema\s*\}\s*from\s*'@chroxy\/protocol\/schemas'/);
  });

  it('handles the notification_prefs case and stores the parsed snapshot', () => {
    expect(messageHandlerSource).toMatch(/case 'notification_prefs'[\s\S]{0,1500}ServerNotificationPrefsSchema\.safeParse[\s\S]{0,800}notificationPrefs:/);
  });

  it('logs and skips when the payload fails schema validation', () => {
    expect(messageHandlerSource).toMatch(
      /case 'notification_prefs'[\s\S]{0,600}!parsed\.success[\s\S]{0,200}console\.warn\(\s*'notification_prefs:/,
    );
  });

  // #4544: the wire snapshot now carries an optional bypassCategories
  // array. The handler must forward it when present so the UI sees the
  // current gate state; absent means "use documented defaults".
  it('forwards bypassCategories from the parsed snapshot when present (#4544)', () => {
    expect(messageHandlerSource).toMatch(/bypassCategories\s*=\s*\(prefs\s*as[\s\S]{0,150}\.bypassCategories/);
    expect(messageHandlerSource).toMatch(/Array\.isArray\(bypassCategories\)/);
  });
});

describe('SettingsScreen — Quiet hours editor section (#4544)', () => {
  it('renders a QUIET HOURS section header', () => {
    expect(settingsSource).toMatch(/QUIET HOURS/);
  });

  it('imports the quiet-hours store actions from the connection store', () => {
    expect(settingsSource).toMatch(/setNotificationPrefsQuietHours\s*=\s*useConnectionStore/);
    expect(settingsSource).toMatch(/setNotificationPrefsBypassCategories\s*=\s*useConnectionStore/);
  });

  it('renders the QuietHoursEditor sub-component inside the QUIET HOURS section', () => {
    expect(settingsSource).toMatch(/<QuietHoursEditor[\s\S]{0,800}window=\{notificationPrefs\.quietHours\}/);
  });

  it('defines the QuietHoursEditor component with the documented props shape', () => {
    expect(settingsSource).toMatch(/function QuietHoursEditor\(props:\s*\{[\s\S]{0,400}window:\s*\{\s*start:\s*string;\s*end:\s*string;\s*timezone:\s*string\s*\}\s*\|\s*null/);
    expect(settingsSource).toMatch(/onWindowChange:\s*\(w:[\s\S]{0,150}timezone:\s*string\s*\}\s*\|\s*null\)\s*=>\s*void/);
    expect(settingsSource).toMatch(/onBypassChange:\s*\(categories:\s*string\[\]\)\s*=>\s*void/);
  });

  it('emits the documented quiet-hours testIDs', () => {
    expect(settingsSource).toMatch(/testID="quiet-hours-editor"/);
    expect(settingsSource).toMatch(/testID="quiet-hours-enabled-toggle"/);
    expect(settingsSource).toMatch(/testID="quiet-hours-start-input"/);
    expect(settingsSource).toMatch(/testID="quiet-hours-end-input"/);
    expect(settingsSource).toMatch(/testID="quiet-hours-timezone-picker"/);
    expect(settingsSource).toMatch(/testID="quiet-hours-save-button"/);
    expect(settingsSource).toMatch(/testID=\{`quiet-hours-bypass-toggle-\$\{cat\}`\}/);
  });

  it('validates HH:MM before round-tripping', () => {
    expect(settingsSource).toMatch(/function isValidHHMM/);
    expect(settingsSource).toMatch(/Invalid time[\s\S]{0,100}HH:MM/);
  });

  it('consumes the shared curated timezone list from @chroxy/store-core (#4569)', () => {
    // The list itself lives in store-core (see store-core/src/timezones.ts);
    // SettingsScreen must import the shared helper rather than redeclare a
    // duplicate array. Verify both the import and the call-site.
    expect(settingsSource).toMatch(/import\s+\{\s*buildQuietHoursTimezoneList\s*\}\s+from\s+['"]@chroxy\/store-core['"]/);
    expect(settingsSource).toMatch(/buildQuietHoursTimezoneList\(/);
    // The duplicate local constant from PR #4565 must be gone.
    expect(settingsSource).not.toMatch(/const\s+QUIET_HOURS_TIMEZONE_CHOICES\s*=/);
  });

  it('falls back to DEFAULT_BYPASS_CATEGORIES when the snapshot omits the list', () => {
    expect(settingsSource).toMatch(/bypassCategories=\{notificationPrefs\.bypassCategories\s*\?\?\s*DEFAULT_BYPASS_CATEGORIES\}/);
  });
});

describe('ConnectionState — quiet-hours actions (#4544)', () => {
  it('declares setNotificationPrefsQuietHours with the documented signature', () => {
    expect(typesSource).toMatch(
      /setNotificationPrefsQuietHours:\s*\(window:\s*\{\s*start:\s*string;\s*end:\s*string;\s*timezone:\s*string\s*\}\s*\|\s*null\)\s*=>\s*void/,
    );
  });

  it('declares setNotificationPrefsBypassCategories with the documented signature', () => {
    expect(typesSource).toMatch(
      /setNotificationPrefsBypassCategories:\s*\(categories:\s*string\[\]\)\s*=>\s*void/,
    );
  });

  it('extends notificationPrefs.quietHours with a timezone field', () => {
    expect(typesSource).toMatch(/quietHours:\s*\{\s*start:\s*string;\s*end:\s*string;\s*timezone:\s*string\s*\}\s*\|\s*null/);
  });

  it('declares optional bypassCategories on notificationPrefs', () => {
    expect(typesSource).toMatch(/bypassCategories\?:\s*string\[\]/);
  });
});

describe('connection.ts — quiet-hours actions (#4544)', () => {
  it('setNotificationPrefsQuietHours sends a notification_prefs_set patch with quietHours', () => {
    expect(connectionSource).toMatch(
      /setNotificationPrefsQuietHours[\s\S]{0,400}notification_prefs_set[\s\S]{0,200}quietHours:\s*window/,
    );
  });

  it('setNotificationPrefsBypassCategories sends a notification_prefs_set patch with bypassCategories', () => {
    expect(connectionSource).toMatch(
      /setNotificationPrefsBypassCategories[\s\S]{0,400}notification_prefs_set[\s\S]{0,200}bypassCategories:\s*categories/,
    );
  });
});

// #4570: snapshot broadcasts must not clobber the in-flight quiet-hours
// draft. The mobile-app test suite is static-source-analysis (mirrors the
// #4542/#4544 blocks above) — we verify the editor declares a dirty flag,
// reads it via a ref inside the snapshot effect, parks the divergent
// snapshot, and surfaces an accept/discard conflict banner. End-to-end
// behaviour for these guarantees is covered by the dashboard vitest suite.
describe('SettingsScreen — Quiet-hours editor: snapshot-vs-draft (#4570)', () => {
  it('declares a dirty flag in the QuietHoursEditor', () => {
    expect(settingsSource).toMatch(/const\s+\[dirty,\s*setDirty\]\s*=\s*useState\(false\)/);
  });

  it('mirrors dirty into a ref so the snapshot effect can read it without depending on it', () => {
    // Adding `dirty` to the snapshot useEffect's dependency array would
    // re-fire the effect when dirty changes and re-apply the snapshot we
    // were trying to skip. The ref pattern keeps the effect keyed on `win`
    // alone, the way #4570 intends.
    expect(settingsSource).toMatch(/dirtyRef\s*=\s*useRef\(dirty\)/);
    expect(settingsSource).toMatch(/dirtyRef\.current\s*=\s*dirty/);
  });

  it('parks the snapshot in pendingSnapshot state when dirty and divergent', () => {
    expect(settingsSource).toMatch(/pendingSnapshot,\s*setPendingSnapshot/);
    expect(settingsSource).toMatch(/setPendingSnapshot\(win\)/);
  });

  it('clears dirty + pendingSnapshot on save', () => {
    // handleSaveWindow runs setDirty(false) + setPendingSnapshot(undefined)
    // before forwarding to onWindowChange so the next snapshot echo is
    // accepted cleanly.
    expect(settingsSource).toMatch(
      /handleSaveWindow[\s\S]{0,400}setDirty\(false\)[\s\S]{0,200}setPendingSnapshot\(undefined\)[\s\S]{0,200}onWindowChange\(\{\s*start,\s*end,\s*timezone\s*\}\)/,
    );
  });

  it('clears dirty + pendingSnapshot on enable/disable toggle', () => {
    expect(settingsSource).toMatch(
      /handleToggleEnable[\s\S]{0,400}setDirty\(false\)[\s\S]{0,200}setPendingSnapshot\(undefined\)/,
    );
  });

  it('routes field edits through dirty-flagging setter wrappers', () => {
    expect(settingsSource).toMatch(/setStartDirty[\s\S]{0,200}setDirty\(true\)/);
    expect(settingsSource).toMatch(/setEndDirty[\s\S]{0,200}setDirty\(true\)/);
    expect(settingsSource).toMatch(/setTimezoneDirty[\s\S]{0,200}setDirty\(true\)/);
    // And the inputs use the dirty-flagging versions, NOT the raw setState.
    expect(settingsSource).toMatch(/onChangeText=\{setStartDirty\}/);
    expect(settingsSource).toMatch(/onChangeText=\{setEndDirty\}/);
  });

  it('renders the conflict banner with accept + discard buttons', () => {
    expect(settingsSource).toMatch(/testID="quiet-hours-conflict-banner"/);
    expect(settingsSource).toMatch(/testID="quiet-hours-conflict-accept"/);
    expect(settingsSource).toMatch(/testID="quiet-hours-conflict-discard"/);
  });

  it('handleAcceptDraft drops the parked snapshot but keeps the draft', () => {
    expect(settingsSource).toMatch(
      /handleAcceptDraft[\s\S]{0,200}setPendingSnapshot\(undefined\)/,
    );
  });

  it('handleDiscardDraft applies the parked snapshot and clears dirty', () => {
    expect(settingsSource).toMatch(
      /handleDiscardDraft[\s\S]{0,800}setStart\(snap\.start\)[\s\S]{0,200}setDirty\(false\)[\s\S]{0,200}setPendingSnapshot\(undefined\)/,
    );
  });
});
