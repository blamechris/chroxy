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
    // #4559 widened the inner gap to 600 chars to accommodate the
    // ignore-the-boolean-return docblock that explains why the boolean
    // is unused on the initial mount refresh.
    expect(settingsSource).toMatch(/useEffect\([\s\S]{0,600}refreshNotificationPrefs\(\)/);
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
    // category name — as the second arg. #4559 routed the call through
    // a thin handler wrapper (`handleSetCategory`) so the WS-closed
    // boolean return can drive the inline error banner; the handler
    // forwards `(cat, value)` to `setNotificationPrefsCategory` so the
    // wire payload is unchanged.
    expect(settingsSource).toMatch(/onValueChange=\{\(value\) => handleSetCategory\(cat, value\)\}/);
    expect(settingsSource).toMatch(/handleSetCategory\s*=\s*useCallback[\s\S]{0,300}setNotificationPrefsCategory\(cat, value\)/);
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
    // #4559: returns boolean (true = sent, false = WS-closed no-op) so
    // SettingsScreen can surface an inline "server disconnected" warning
    // instead of silently dropping the user's tap.
    expect(typesSource).toMatch(/refreshNotificationPrefs:\s*\(\)\s*=>\s*boolean/);
  });

  it('declares setNotificationPrefsCategory with (category, enabled) signature', () => {
    // #4559: returns boolean — see refreshNotificationPrefs comment above.
    expect(typesSource).toMatch(/setNotificationPrefsCategory:\s*\(category:\s*string,\s*enabled:\s*boolean\)\s*=>\s*boolean/);
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
    // #4559: returns boolean — see refreshNotificationPrefs comment above.
    expect(typesSource).toMatch(
      /setNotificationPrefsQuietHours:\s*\(window:\s*\{\s*start:\s*string;\s*end:\s*string;\s*timezone:\s*string\s*\}\s*\|\s*null\)\s*=>\s*boolean/,
    );
  });

  it('declares setNotificationPrefsBypassCategories with the documented signature', () => {
    // #4559: returns boolean — see refreshNotificationPrefs comment above.
    expect(typesSource).toMatch(
      /setNotificationPrefsBypassCategories:\s*\(categories:\s*string\[\]\)\s*=>\s*boolean/,
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

// #4559: fail-loud inline error when a notification-prefs WS write fires
// while the socket is closed. Pre-#4559 the action silently no-op'd; the
// Switch revert was the only signal and looked like a misfire. Both the
// store action and the SettingsScreen banner are covered here.
describe('connection.ts — notification-prefs WS-closed return values (#4559)', () => {
  it('setNotificationPrefsCategory returns true after sending and false on the no-op path', () => {
    // The action body must return `true` once `wsSend(...)` has shipped
    // the patch and `false` from the fall-through (closed socket).
    expect(connectionSource).toMatch(
      /setNotificationPrefsCategory[\s\S]{0,1400}wsSend\(socket,[\s\S]{0,200}notification_prefs_set[\s\S]{0,300}return true[\s\S]{0,80}return false/,
    );
  });

  it('setNotificationPrefsDevice returns false for empty deviceKey AND closed socket', () => {
    // Defensive: the empty-deviceKey guard must short-circuit with
    // `return false` (so the UI can still surface "save failed" should
    // a stale render somehow fire), and the closed-socket fall-through
    // must also return `false`.
    expect(connectionSource).toMatch(
      /setNotificationPrefsDevice[\s\S]{0,300}if\s*\(!deviceKey\)\s*return false[\s\S]{0,1600}return false/,
    );
  });

  it('refreshNotificationPrefs returns true on send and false on closed socket', () => {
    expect(connectionSource).toMatch(
      /refreshNotificationPrefs[\s\S]{0,400}wsSend\(socket,[\s\S]{0,150}notification_prefs_get[\s\S]{0,80}return true[\s\S]{0,80}return false/,
    );
  });

  it('setNotificationPrefsQuietHours returns true on send and false on closed socket', () => {
    expect(connectionSource).toMatch(
      /setNotificationPrefsQuietHours[\s\S]{0,800}return true[\s\S]{0,80}return false/,
    );
  });

  it('setNotificationPrefsBypassCategories returns true on send and false on closed socket', () => {
    expect(connectionSource).toMatch(
      /setNotificationPrefsBypassCategories[\s\S]{0,800}return true[\s\S]{0,80}return false/,
    );
  });
});

describe('SettingsScreen — fail-loud inline error on WS-closed write (#4559)', () => {
  it('declares a notifWsClosedError useState slot for the inline banner', () => {
    // The error is component-local rather than store-state because each
    // SettingsScreen mount is the only consumer; surfacing it via the
    // store would risk a banner appearing on screens that don't expose
    // the failing toggle.
    expect(settingsSource).toMatch(
      /\[notifWsClosedError,\s*setNotifWsClosedError\]\s*=\s*useState<string\s*\|\s*null>\(null\)/,
    );
  });

  it('declares a shared WS_CLOSED_MESSAGE constant with the documented copy', () => {
    // The exact copy mirrors the dashboard banner so users see the same
    // instruction on both clients. Capture the substring so a rename
    // / soften / typo breaks here intentionally.
    expect(settingsSource).toMatch(/WS_CLOSED_MESSAGE\s*=/);
    expect(settingsSource).toMatch(/Settings save failed/);
    expect(settingsSource).toMatch(/server disconnected/);
    expect(settingsSource).toMatch(/Reconnect and try again/);
  });

  it('renders the banner with testID notification-prefs-ws-closed-error when the error is set', () => {
    expect(settingsSource).toMatch(/testID="notification-prefs-ws-closed-error"/);
    // The banner is a conditional render keyed on notifWsClosedError.
    expect(settingsSource).toMatch(/\{notifWsClosedError\s*&&/);
  });

  it('exposes the banner as an accessibility alert for screen readers', () => {
    // Without role="alert" VoiceOver / TalkBack just announces the
    // banner like any other Text — easy to miss for the same reason
    // the original toggle revert was invisible.
    expect(settingsSource).toMatch(/accessibilityRole="alert"/);
  });

  it('handleSetCategory delegates to setNotificationPrefsCategory and sets/clears the banner from the boolean', () => {
    expect(settingsSource).toMatch(
      /handleSetCategory\s*=\s*useCallback[\s\S]{0,300}setNotificationPrefsCategory\(cat, value\)[\s\S]{0,200}setNotifWsClosedError\(sent\s*\?\s*null\s*:\s*WS_CLOSED_MESSAGE\)/,
    );
  });

  it('handleSetDevice delegates to setNotificationPrefsDevice and sets/clears the banner from the boolean', () => {
    expect(settingsSource).toMatch(
      /handleSetDevice\s*=\s*useCallback[\s\S]{0,300}setNotificationPrefsDevice\(deviceKey, cat, value\)[\s\S]{0,200}setNotifWsClosedError\(sent\s*\?\s*null\s*:\s*WS_CLOSED_MESSAGE\)/,
    );
  });

  it('handleSetQuietHours delegates to setNotificationPrefsQuietHours and sets/clears the banner', () => {
    expect(settingsSource).toMatch(
      /handleSetQuietHours\s*=\s*useCallback[\s\S]{0,300}setNotificationPrefsQuietHours\(win\)[\s\S]{0,200}setNotifWsClosedError\(sent\s*\?\s*null\s*:\s*WS_CLOSED_MESSAGE\)/,
    );
  });

  it('handleSetBypassCategories delegates to setNotificationPrefsBypassCategories and sets/clears the banner', () => {
    expect(settingsSource).toMatch(
      /handleSetBypassCategories\s*=\s*useCallback[\s\S]{0,300}setNotificationPrefsBypassCategories\(cats\)[\s\S]{0,200}setNotifWsClosedError\(sent\s*\?\s*null\s*:\s*WS_CLOSED_MESSAGE\)/,
    );
  });

  it('QuietHoursEditor receives the handler wrappers — not the raw store actions', () => {
    // Without this routing the editor would silently no-op on a closed
    // socket and the user would never see the banner.
    expect(settingsSource).toMatch(/onWindowChange=\{handleSetQuietHours\}/);
    expect(settingsSource).toMatch(/onBypassChange=\{handleSetBypassCategories\}/);
  });
});
