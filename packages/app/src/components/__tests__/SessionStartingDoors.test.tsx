/**
 * #8875 — a starting session's pill (SessionPicker) and card (SessionOverview)
 * drop the press (keeping long-press) and say so; an ordinary session's open.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { TouchableOpacity } from 'react-native';

type StoreState = Record<string, unknown>;
let mockState: StoreState = {};
jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: StoreState) => unknown) => selector(mockState),
}));

import { SessionOverview } from '../SessionOverview';
import { SessionPicker } from '../SessionPicker';

function seed(switchSession: jest.Mock) {
  mockState = {
    sessions: [
      { sessionId: 'a', name: 'Active', isBusy: false, createdAt: 1, model: null },
      { sessionId: 's', name: 'Booting', isBusy: false, createdAt: 2, model: null, starting: true },
      { sessionId: 'ok', name: 'Ordinary', isBusy: false, createdAt: 3, model: null },
    ],
    activeSessionId: 'a',
    sessionStates: {},
    sessionNotifications: [],
    switchSession,
    destroySession: () => {},
    renameSession: () => {},
    totalCost: null,
    costBudget: null,
    connectedClients: [],
    followMode: false,
    setFollowMode: () => {},
  };
}

function find(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAllByType(TouchableOpacity).find((t) =>
    String(t.props.accessibilityLabel ?? '').includes(label),
  )!;
}

describe.each([
  ['SessionOverview', () => <SessionOverview onClose={() => {}} />],
  ['SessionPicker', () => <SessionPicker onCreatePress={() => {}} />],
])('%s starting door (#8875)', (_name, make) => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a starting row drops the press but keeps long-press; an ordinary row opens', () => {
    const switchSession = jest.fn();
    seed(switchSession);
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(make()); });
    const starting = find(tree, 'Booting');
    expect(starting.props.onPress).toBeUndefined();
    expect(typeof starting.props.onLongPress).toBe('function');
    expect(starting.props.accessibilityState.disabled).toBe(true);
    expect(starting.props.accessibilityLabel).toContain('starting');
    const ordinary = find(tree, 'Ordinary');
    expect(ordinary.props.accessibilityState?.disabled).toBeFalsy();
    expect(ordinary.props.accessibilityLabel).not.toContain('starting');
    act(() => { ordinary.props.onPress(); });
    expect(switchSession).toHaveBeenCalledWith('ok');
    expect(switchSession).not.toHaveBeenCalledWith('s');
    act(() => tree.unmount());
  });
});

jest.mock('../../store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: (selector: (s: StoreState) => unknown) => selector({ connectionPhase: 'connected' }),
}));

import { SessionNotificationBanner } from '../SessionNotificationBanner';
import { BackgroundSessionProgress } from '../BackgroundSessionProgress';

describe('cross-session rows and a starting session (#8875)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('SessionNotificationBanner: a starting session row drops the jump; an ordinary row switches', () => {
    const switchSession = jest.fn();
    seed(switchSession);
    mockState.sessionNotifications = [
      { id: 'n1', sessionId: 's', sessionName: 'Booting', eventType: 'completed', message: 'm', timestamp: 1 },
      { id: 'n2', sessionId: 'ok', sessionName: 'Ordinary', eventType: 'completed', message: 'm', timestamp: 2 },
    ];
    mockState.dismissSessionNotification = () => {};
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<SessionNotificationBanner />); });
    const starting = find(tree, 'Booting');
    expect(starting.props.onPress).toBeUndefined();
    expect(starting.props.accessibilityState.disabled).toBe(true);
    expect(starting.props.accessibilityLabel).toContain('starting');
    const ordinary = find(tree, 'Switch to Ordinary');
    expect(ordinary.props.accessibilityState.disabled).toBe(false);
    act(() => { ordinary.props.onPress(); });
    expect(switchSession).toHaveBeenCalledWith('ok');
    expect(switchSession).not.toHaveBeenCalledWith('s');
    act(() => tree.unmount());
  });

  it('BackgroundSessionProgress: a starting session row drops the jump; an ordinary row switches', () => {
    const switchSession = jest.fn();
    seed(switchSession);
    const busy = { activityState: { state: 'busy', startedAt: 1 } };
    mockState.sessionStates = { s: busy, ok: busy };
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<BackgroundSessionProgress />); });
    const starting = find(tree, 'Booting');
    expect(starting.props.onPress).toBeUndefined();
    expect(starting.props.accessibilityState.disabled).toBe(true);
    const ordinary = find(tree, 'Ordinary');
    expect(ordinary.props.accessibilityState.disabled).toBe(false);
    act(() => { ordinary.props.onPress(); });
    expect(switchSession).toHaveBeenCalledWith('ok');
    expect(switchSession).not.toHaveBeenCalledWith('s');
    act(() => tree.unmount());
  });
});
