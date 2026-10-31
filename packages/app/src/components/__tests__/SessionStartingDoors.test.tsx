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
