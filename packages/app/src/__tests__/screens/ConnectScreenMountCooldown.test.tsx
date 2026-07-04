/**
 * Render-based regression test for ConnectScreen's #6583 mount-auto-connect
 * cooldown (#6585). The store-level #6583 latch is covered in
 * store/connection-server-down.test.ts; this exercises the OTHER half of the
 * fix — the end-to-end remount path — by actually mounting ConnectScreen:
 *
 *   - a first mount with a saved record fires connectAuto once,
 *   - a REMOUNT within MOUNT_AUTOCONNECT_COOLDOWN_MS (5s) does NOT re-fire
 *     (this is the loop-breaker: a give-up → 'disconnected' → remount cycle
 *     can't machine-gun connectAuto),
 *   - a remount after the window re-fires (the guard is purely time-based, not
 *     a permanent latch).
 *
 * Uses the repo's react-test-renderer harness (no @testing-library/react-native
 * here) + fake timers to drive Date.now() across the cooldown window. The mount
 * effect awaits loadSavedConnection().then(...), so each mount flushes microtasks
 * before asserting.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';

// ConnectScreen pulls in native modules jest.setup.js does not cover. The mount
// auto-connect effect touches none of them, but the imports must resolve.
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
}));
// expo-network is left to the jest-expo default mock (the connection store
// subscribes via Network.addNetworkStateListener at module load; the mount
// auto-connect effect touches no network API).
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { ConnectScreen, __resetMountAutoConnectForTests } from '../../screens/ConnectScreen';
import { useConnectionStore } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';

const SAVED = { url: 'wss://tunnel.example.com', token: 'tok' };

let connectAuto: jest.Mock;
let loadSavedConnection: jest.Mock;

// These Zustand stores are singletons shared across every test file in the same
// Jest worker. We override two store actions + two lifecycle fields below, so we
// capture their originals and RESTORE them in afterEach — otherwise the mocks
// leak into later suites and cause order-dependent flakiness (#6588 review).
type ConnStore = ReturnType<typeof useConnectionStore.getState>;
type LifecycleStore = ReturnType<typeof useConnectionLifecycleStore.getState>;
let origConnectAuto: ConnStore['connectAuto'];
let origLoadSavedConnection: ConnStore['loadSavedConnection'];
let origSavedConnection: LifecycleStore['savedConnection'];
let origUserDisconnected: LifecycleStore['userDisconnected'];

beforeEach(() => {
  jest.useFakeTimers();
  __resetMountAutoConnectForTests();
  const cs = useConnectionStore.getState();
  origConnectAuto = cs.connectAuto;
  origLoadSavedConnection = cs.loadSavedConnection;
  const ls = useConnectionLifecycleStore.getState();
  origSavedConnection = ls.savedConnection;
  origUserDisconnected = ls.userDisconnected;

  connectAuto = jest.fn().mockResolvedValue(undefined);
  loadSavedConnection = jest.fn().mockResolvedValue(undefined);
  // Override the two store actions the mount effect calls; seed a saved record.
  useConnectionStore.setState({ connectAuto, loadSavedConnection } as never);
  useConnectionLifecycleStore.setState({ savedConnection: SAVED, userDisconnected: false } as never);
});

afterEach(() => {
  // Restore the singleton store actions + lifecycle fields we overrode.
  useConnectionStore.setState({
    connectAuto: origConnectAuto,
    loadSavedConnection: origLoadSavedConnection,
  } as never);
  useConnectionLifecycleStore.setState({
    savedConnection: origSavedConnection,
    userDisconnected: origUserDisconnected,
  } as never);
  jest.useRealTimers();
  jest.clearAllMocks();
});

/** Mount ConnectScreen and flush the async loadSavedConnection().then() chain. */
async function mountFlush(): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ConnectScreen />);
    // loadSavedConnection() resolves on the microtask queue; flush it so the
    // .then() (which decides whether to call connectAuto) runs before we assert.
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree;
}

describe('ConnectScreen mount auto-connect cooldown (#6585 / #6583)', () => {
  it('a first mount with a saved record fires connectAuto once', async () => {
    const tree = await mountFlush();
    expect(connectAuto).toHaveBeenCalledTimes(1);
    expect(connectAuto).toHaveBeenCalledWith(SAVED, { silent: true });
    act(() => tree.unmount());
  });

  it('a remount WITHIN the cooldown window does not re-fire connectAuto (loop-breaker)', async () => {
    const t1 = await mountFlush();
    expect(connectAuto).toHaveBeenCalledTimes(1);
    act(() => t1.unmount());

    connectAuto.mockClear();
    jest.advanceTimersByTime(2000); // < 5000ms window
    const t2 = await mountFlush();

    // Pre-fix, every remount re-kicked auto-connect → the reconnect loop. The
    // cooldown must swallow this one.
    expect(connectAuto).not.toHaveBeenCalled();
    act(() => t2.unmount());
  });

  it('a remount AFTER the cooldown window re-fires connectAuto (purely time-based)', async () => {
    const t1 = await mountFlush();
    expect(connectAuto).toHaveBeenCalledTimes(1);
    act(() => t1.unmount());

    connectAuto.mockClear();
    jest.advanceTimersByTime(5001); // > 5000ms window
    const t2 = await mountFlush();

    expect(connectAuto).toHaveBeenCalledTimes(1);
    act(() => t2.unmount());
  });
});
