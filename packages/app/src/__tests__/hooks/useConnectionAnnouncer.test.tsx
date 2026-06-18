/**
 * #5581 — `useConnectionAnnouncer` debounced screen-reader announcements.
 *
 * Mirrors the dashboard's ConnectionAnnouncer semantics on mobile:
 *   - rapid phase flaps within the debounce window coalesce into ONE
 *     announcement of the settled phase,
 *   - no announcement fires for the phase observed at mount (a cold open in
 *     `disconnected` stays silent until a real connect/drop),
 *   - each settled phase maps to the expected spoken label.
 *
 * No `@testing-library/react-native` in this repo — we drive the hook through
 * a react-test-renderer harness (same pattern as
 * `useDictationComposer.test.tsx`) and flush the debounce with fake timers.
 * `AccessibilityInfo.announceForAccessibility` is mocked so we can assert on
 * what (if anything) was spoken.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo } from 'react-native';

import {
  useConnectionAnnouncer,
  settledLabelFor,
  type UseConnectionAnnouncerOptions,
} from '../../hooks/useConnectionAnnouncer';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import type { ConnectionPhase } from '../../store/types';

jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
const announceMock = AccessibilityInfo.announceForAccessibility as jest.Mock;

const DEBOUNCE = 50;

/** Render the hook. Returns the test renderer + an unmount helper. */
function renderAnnouncer(opts: UseConnectionAnnouncerOptions = { debounceMs: DEBOUNCE }) {
  function Harness() {
    useConnectionAnnouncer(opts);
    return null;
  }
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Harness />);
  });
  return tree;
}

/** Drive the store's phase the way connect()/the FSM would. */
function setPhase(phase: ConnectionPhase) {
  act(() => {
    useConnectionLifecycleStore.setState({ connectionPhase: phase });
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  announceMock.mockClear();
  // Reset to the cold-open default before every test.
  useConnectionLifecycleStore.setState({ connectionPhase: 'disconnected' });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('useConnectionAnnouncer — initial mount', () => {
  it('does not announce the phase present at mount (no cold-open disconnected blast)', () => {
    const tree = renderAnnouncer();
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE * 3);
    });
    expect(announceMock).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('stays silent at mount even when the initial phase is connected', () => {
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
    const tree = renderAnnouncer();
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE * 3);
    });
    expect(announceMock).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

describe('useConnectionAnnouncer — settled transitions', () => {
  it('announces a single settled transition after the debounce window', () => {
    const tree = renderAnnouncer();
    setPhase('connecting');
    setPhase('connected');
    // Before the window elapses, nothing has been spoken.
    expect(announceMock).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE);
    });
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith('Connected to Chroxy server');
    act(() => tree.unmount());
  });

  it('coalesces a rapid reconnect-storm flap into ONE announcement of the settled phase', () => {
    const tree = renderAnnouncer();
    // connected → reconnecting → connecting → reconnecting → connected, all
    // within one debounce window.
    setPhase('connected');
    setPhase('reconnecting');
    setPhase('connecting');
    setPhase('reconnecting');
    setPhase('connected');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE);
    });
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith('Connected to Chroxy server');
    act(() => tree.unmount());
  });

  it('says nothing when a flap returns to the previously-announced phase', () => {
    const tree = renderAnnouncer();
    // First settle on connected.
    setPhase('connected');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE);
    });
    expect(announceMock).toHaveBeenCalledTimes(1);
    announceMock.mockClear();
    // Flap away and back within a window → nothing new to say.
    setPhase('reconnecting');
    setPhase('connected');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE);
    });
    expect(announceMock).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('announces each distinct settled phase in sequence', () => {
    const tree = renderAnnouncer();
    setPhase('connected');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE);
    });
    setPhase('reconnecting');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE);
    });
    setPhase('disconnected');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE);
    });
    expect(announceMock.mock.calls.map((c) => c[0])).toEqual([
      'Connected to Chroxy server',
      'Reconnecting to Chroxy server',
      'Disconnected from Chroxy server',
    ]);
    act(() => tree.unmount());
  });

  it('does not fire after unmount (timer cleaned up)', () => {
    const tree = renderAnnouncer();
    setPhase('connected');
    act(() => tree.unmount());
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE * 3);
    });
    expect(announceMock).not.toHaveBeenCalled();
  });
});

describe('settledLabelFor — phase → message mapping', () => {
  it('maps every connection phase to its spoken label', () => {
    expect(settledLabelFor('connected')).toBe('Connected to Chroxy server');
    expect(settledLabelFor('connecting')).toBe('Connecting to Chroxy server');
    expect(settledLabelFor('reconnecting')).toBe('Reconnecting to Chroxy server');
    expect(settledLabelFor('server_restarting')).toBe('Chroxy server restarting');
    expect(settledLabelFor('disconnected')).toBe('Disconnected from Chroxy server');
  });

  it('falls back to a generic label for an unknown phase', () => {
    expect(settledLabelFor('weird' as ConnectionPhase)).toBe('Connection status: weird');
  });
});
