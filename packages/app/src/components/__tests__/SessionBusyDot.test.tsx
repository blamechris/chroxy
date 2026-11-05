/**
 * #8261 -- the tab dot and the overview card read the LIVE turn state
 * (sessionStates[id].isIdle), not the session_list snapshot (sessions[].isBusy).
 * Rendered through the real components (store mocked), so a surface that goes
 * back to the snapshot turns these red.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';

type StoreState = Record<string, unknown>;
let mockState: StoreState = {};
jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: StoreState) => unknown) => selector(mockState),
}));

import { SessionPicker } from '../SessionPicker';
import { SessionOverview } from '../SessionOverview';

const base = {
  activeSessionId: 'none',
  sessionNotifications: [],
  switchSession: () => {},
  destroySession: () => {},
  renameSession: () => {},
  setFollowMode: () => {},
  followMode: false,
  connectedClients: [],
  totalCost: null,
  costBudget: null,
};

const live = (isIdle: boolean) => ({
  messages: [], health: 'healthy', isIdle, activeAgents: [], isPlanPending: false,
});

const sess = (sessionId: string, name: string, isBusy: boolean, createdAt = 1) =>
  ({ sessionId, name, isBusy, createdAt, model: null });

function mount(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree;
}

describe('SessionPicker busy dot reads live state (#8261)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const dots = (sessions: unknown[], sessionStates: Record<string, unknown>) => {
    mockState = { ...base, sessions, sessionStates };
    const tree = mount(<SessionPicker onCreatePress={() => {}} />);
    const n = tree.root.findAll((x) => x.props.testID === 'session-busy-dot' && typeof x.type === 'string').length;
    act(() => tree.unmount());
    return n;
  };

  it('no dot when the snapshot says busy but the live turn has ended', () => {
    expect(dots([sess('s1', 'A', true)], { s1: live(true) })).toBe(0);
  });

  it('a dot while the live turn runs, whatever the snapshot said', () => {
    expect(dots([sess('s1', 'A', false)], { s1: live(false) })).toBe(1);
  });

  it('falls back to the snapshot when no live slot exists', () => {
    expect(dots([sess('s1', 'A', true)], {})).toBe(1);
  });
});

describe('SessionOverview busy status reads live state (#8261)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const cardLabels = (sessions: unknown[], sessionStates: Record<string, unknown>) => {
    mockState = { ...base, sessions, sessionStates };
    const tree = mount(<SessionOverview onClose={() => {}} />);
    const labels = tree.root
      .findAll((x) => typeof x.props.accessibilityLabel === 'string' && x.props.accessibilityLabel.startsWith('Session ') && typeof x.type === 'string')
      .map((x) => x.props.accessibilityLabel as string);
    act(() => tree.unmount());
    return labels;
  };

  it('the card reads Idle, not Busy, when the live turn has ended', () => {
    const labels = cardLabels([sess('s1', 'Work', true)], { s1: live(true) });
    expect(labels.some((l) => l.includes('Idle'))).toBe(true);
    expect(labels.some((l) => l.includes('Busy'))).toBe(false);
  });

  it('sorts by LIVE state, not the snapshot', () => {
    // A: snapshot busy, live idle. B: snapshot idle, live busy. Live order: B, A.
    const labels = cardLabels(
      [sess('a', 'Alpha', true, 2), sess('b', 'Beta', false, 1)],
      { a: live(true), b: live(false) },
    );
    expect(labels.map((l) => l.split(',')[0])).toEqual(['Session Beta', 'Session Alpha']);
  });
});
