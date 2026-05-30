/**
 * Mobile-app notification-prefs optimistic update tests (#4558)
 *
 * Mirrors the dashboard suite at
 * packages/dashboard/src/store/notification-prefs-optimistic.test.ts —
 * the contract is the same on both clients:
 *
 *   1. Clicking the per-category Switch calls
 *      `setNotificationPrefsCategory(cat, next)`, which immediately patches
 *      `notificationPrefs.categories[cat]` in the store so the next render
 *      reflects the new value before the WS round-trip completes.
 *   2. The action still ships a `notification_prefs_set` message.
 *   3. When the server's `notification_prefs` broadcast arrives, the
 *      message-handler overwrites the optimistic value with the server
 *      snapshot — server wins, rejected toggles visibly revert.
 *
 * Same contract for per-device, quiet-hours, and bypass-list actions.
 */
import { useConnectionStore } from '../../store/connection';

function makeMockSocket(): { socket: WebSocket; sent: unknown[] } {
  const sent: unknown[] = [];
  const socket = {
    readyState: 1,
    send: (data: string) => {
      try { sent.push(JSON.parse(data)); } catch { /* noop */ }
    },
    close: () => {},
    onclose: null,
  } as unknown as WebSocket;
  return { socket, sent };
}

const baseCats = {
  permission: true,
  result: true,
  activity_update: true,
  activity_waiting: true,
  activity_error: true,
  inactivity_warning: true,
  live_activity: true,
};

describe('#4558 — notification-prefs optimistic update (mobile)', () => {
  afterEach(() => {
    useConnectionStore.setState({ socket: null, notificationPrefs: null });
  });

  it('setNotificationPrefsCategory updates local snapshot immediately', () => {
    const { socket } = makeMockSocket();
    useConnectionStore.setState({
      socket,
      notificationPrefs: { categories: { ...baseCats }, devices: {}, quietHours: null },
    });

    useConnectionStore.getState().setNotificationPrefsCategory('result', false);

    const after = useConnectionStore.getState().notificationPrefs!;
    expect(after.categories.result).toBe(false);
    // Other categories survive the shallow-merge patch.
    expect(after.categories.permission).toBe(true);
    expect(after.categories.activity_update).toBe(true);
  });

  it('setNotificationPrefsCategory still sends the notification_prefs_set WS message', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({
      socket,
      notificationPrefs: { categories: { ...baseCats }, devices: {}, quietHours: null },
    });

    useConnectionStore.getState().setNotificationPrefsCategory('result', false);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'notification_prefs_set',
      prefs: { categories: { result: false } },
    });
  });

  it('does not mint a synthetic snapshot when notificationPrefs is null', () => {
    // The Switch only renders after the first snapshot lands, but the
    // action must be safe to call even if a race triggers it earlier —
    // we ship the WS message (so the server's reply seeds the snapshot)
    // but DO NOT fabricate a local snapshot with one made-up category.
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({ socket, notificationPrefs: null });

    useConnectionStore.getState().setNotificationPrefsCategory('result', false);

    expect(useConnectionStore.getState().notificationPrefs).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('setNotificationPrefsDevice patches the per-device override locally', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { ...baseCats },
        devices: { 'tok-a': { categories: { permission: false } } },
        quietHours: null,
      },
    });

    useConnectionStore.getState().setNotificationPrefsDevice('tok-a', 'result', false);

    const after = useConnectionStore.getState().notificationPrefs!;
    expect(after.devices['tok-a']?.categories?.result).toBe(false);
    // Existing per-device category override survives the shallow-merge.
    expect(after.devices['tok-a']?.categories?.permission).toBe(false);
    // Wire ships the minimal patch.
    expect(sent[0]).toEqual({
      type: 'notification_prefs_set',
      prefs: { devices: { 'tok-a': { categories: { result: false } } } },
    });
  });

  it('setNotificationPrefsQuietHours sets the window locally and on the wire', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({
      socket,
      notificationPrefs: { categories: { ...baseCats }, devices: {}, quietHours: null },
    });
    const win = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' };

    useConnectionStore.getState().setNotificationPrefsQuietHours(win);

    expect(useConnectionStore.getState().notificationPrefs!.quietHours).toEqual(win);
    expect(sent[0]).toEqual({ type: 'notification_prefs_set', prefs: { quietHours: win } });
  });

  it('setNotificationPrefsBypassCategories replaces the list locally and on the wire', () => {
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { ...baseCats },
        devices: {},
        quietHours: null,
        bypassCategories: ['permission', 'activity_error'],
      },
    });

    useConnectionStore.getState().setNotificationPrefsBypassCategories(['permission']);

    expect(useConnectionStore.getState().notificationPrefs!.bypassCategories).toEqual(['permission']);
    expect(sent[0]).toEqual({
      type: 'notification_prefs_set',
      prefs: { bypassCategories: ['permission'] },
    });
  });

  it('no-op when socket is closed (no local patch, no wire message)', () => {
    // Without a server to confirm, a local-only flip would never reconcile.
    // The contract matches the old (pre-#4558) server-of-truth behaviour:
    // if there's no socket, do nothing.
    useConnectionStore.setState({
      socket: null,
      notificationPrefs: { categories: { ...baseCats }, devices: {}, quietHours: null },
    });

    useConnectionStore.getState().setNotificationPrefsCategory('result', false);

    // Local state unchanged.
    expect(useConnectionStore.getState().notificationPrefs!.categories.result).toBe(true);
  });

  it('refuses to ship a devices[""] patch when deviceKey is empty', () => {
    // Mirrors the existing defensive guard — empty deviceKey is a no-op
    // and must not mutate local state either.
    const { socket, sent } = makeMockSocket();
    useConnectionStore.setState({
      socket,
      notificationPrefs: { categories: { ...baseCats }, devices: {}, quietHours: null },
    });

    useConnectionStore.getState().setNotificationPrefsDevice('', 'result', false);

    expect(sent).toHaveLength(0);
    expect(useConnectionStore.getState().notificationPrefs!.devices).toEqual({});
  });
});
