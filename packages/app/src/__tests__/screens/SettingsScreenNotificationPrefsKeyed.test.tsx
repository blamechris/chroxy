/**
 * #8496 (#8485 parity) — SettingsScreen's notification-prefs refresh is keyed on
 * the CONNECTION, not just on the capability flag.
 *
 * The server never pushes a prefs snapshot on connect, so a fresh handshake has
 * to ask. The effect used to depend only on `notificationPrefsSupported` +
 * `refreshNotificationPrefs`: a switch between two daemons that both advertise
 * the capability left the new one unasked, and the request could be written over
 * a socket that was not connected. These tests mount the real screen and drive
 * the lifecycle store's `connectionPhase`; the static-source assertions in
 * components/SettingsScreenNotificationPrefs.test.ts cannot tell a guard that
 * runs from one that is merely spelled.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
}));

import { SettingsScreen } from '../../screens/SettingsScreen';
import { useConnectionStore } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';

type ConnStore = ReturnType<typeof useConnectionStore.getState>;
type LifecycleStore = ReturnType<typeof useConnectionLifecycleStore.getState>;

let refresh: jest.Mock;
let origRefresh: ConnStore['refreshNotificationPrefs'];
let origPhase: LifecycleStore['connectionPhase'];
let origCaps: LifecycleStore['serverCapabilities'];

beforeEach(() => {
  origRefresh = useConnectionStore.getState().refreshNotificationPrefs;
  origPhase = useConnectionLifecycleStore.getState().connectionPhase;
  origCaps = useConnectionLifecycleStore.getState().serverCapabilities;
  refresh = jest.fn().mockReturnValue(true);
  useConnectionStore.setState({ refreshNotificationPrefs: refresh } as never);
  useConnectionLifecycleStore.setState({
    connectionPhase: 'connected',
    serverCapabilities: { notificationPrefs: true },
  } as never);
});

afterEach(() => {
  useConnectionStore.setState({ refreshNotificationPrefs: origRefresh } as never);
  useConnectionLifecycleStore.setState({
    connectionPhase: origPhase,
    serverCapabilities: origCaps,
  } as never);
  jest.clearAllMocks();
});

async function mount(): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SettingsScreen />);
    await Promise.resolve();
  });
  return tree;
}

async function setPhase(phase: LifecycleStore['connectionPhase']): Promise<void> {
  await act(async () => {
    useConnectionLifecycleStore.setState({ connectionPhase: phase } as never);
    await Promise.resolve();
  });
}

describe('SettingsScreen notification-prefs refresh (#8496)', () => {
  it('asks once on mount over a live connection', async () => {
    const tree = await mount();
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('does not ask while the connection is down', async () => {
    await act(async () => {
      useConnectionLifecycleStore.setState({ connectionPhase: 'reconnecting' } as never);
    });
    const tree = await mount();
    expect(refresh).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('asks once per completed handshake: nothing while reconnecting, again when connected', async () => {
    const tree = await mount();
    expect(refresh).toHaveBeenCalledTimes(1);

    await setPhase('reconnecting');
    expect(refresh).toHaveBeenCalledTimes(1);

    await setPhase('connected');
    expect(refresh).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('still asks nothing when the server does not advertise the capability', async () => {
    useConnectionLifecycleStore.setState({ serverCapabilities: {} } as never);
    const tree = await mount();
    expect(refresh).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
