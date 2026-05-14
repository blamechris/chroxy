/**
 * Render tests for the mobile CheckInChip (#3899).
 *
 * Mirrors ActivityIndicator.test.tsx — react-test-renderer + act,
 * Zustand stores driven via setState rather than mocked.
 *
 * Covers: hidden when no warning, hidden when no active session,
 * renders the elapsed-silence label and the prefab button, tap fires
 * sendInput with the prefab, disabled while disconnected.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { CheckInChip } from '../CheckInChip';
import { useConnectionStore } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { createEmptySessionState } from '../../store/utils';

const SESSION_ID = 's-test';

function collectVisibleText(root: ReactTestInstance): string {
  return root.findAllByType(Text).map((node) => {
    const c = node.props.children;
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (Array.isArray(c)) {
      return c.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('');
    }
    return '';
  }).join(' ');
}

function setSessionWithWarning(warning: {
  idleMs: number;
  prefab: string;
  receivedAt: number;
} | null) {
  const base = createEmptySessionState();
  useConnectionStore.setState({
    activeSessionId: SESSION_ID,
    sessionStates: {
      [SESSION_ID]: { ...base, inactivityWarning: warning },
    },
  });
}

describe('CheckInChip render branches', () => {
  let activeTree: renderer.ReactTestRenderer | null = null;
  const sendInputSpy = jest.fn();

  function render(): renderer.ReactTestRenderer {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<CheckInChip />); });
    activeTree = tree;
    return tree;
  }

  beforeEach(() => {
    sendInputSpy.mockReset();
    useConnectionStore.setState({
      activeSessionId: null,
      sessionStates: {},
      sendInput: sendInputSpy as any,
    });
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
  });

  afterEach(() => {
    if (activeTree) {
      act(() => { activeTree!.unmount(); });
      activeTree = null;
    }
    jest.useRealTimers();
  });

  it('renders null when no inactivity warning is set', () => {
    setSessionWithWarning(null);
    const tree = render();
    expect(tree.toJSON()).toBeNull();
  });

  it('renders null when there is no active session', () => {
    // activeSessionId stays null after the beforeEach reset.
    const tree = render();
    expect(tree.toJSON()).toBeNull();
  });

  it('renders the prefab text on the button when a warning is active', () => {
    setSessionWithWarning({
      idleMs: 1_800_000,
      prefab: 'Status update?',
      receivedAt: Date.now(),
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Status update?');
  });

  it('shows elapsed silence in the label', () => {
    jest.useFakeTimers().setSystemTime(1_700_000_000_000);
    setSessionWithWarning({
      idleMs: 1_800_000,
      prefab: 'Status update?',
      receivedAt: 1_700_000_000_000,
    });
    const tree = render();
    const text = collectVisibleText(tree.root);
    // 1_800_000 ms = 30m, heldFor = 0 → "Agent quiet for 30m"
    expect(text).toContain('Agent quiet for 30m');
  });

  it('calls sendInput with the prefab when the button is pressed', () => {
    setSessionWithWarning({
      idleMs: 1_800_000,
      prefab: 'Status update?',
      receivedAt: Date.now(),
    });
    const tree = render();
    const button = tree.root.findByProps({ accessibilityRole: 'button' });
    act(() => {
      button.props.onPress?.();
    });
    expect(sendInputSpy).toHaveBeenCalledTimes(1);
    expect(sendInputSpy).toHaveBeenCalledWith('Status update?');
  });

  it('disables the button and does not fire sendInput when not connected', () => {
    useConnectionLifecycleStore.setState({ connectionPhase: 'reconnecting' });
    setSessionWithWarning({
      idleMs: 1_800_000,
      prefab: 'Status update?',
      receivedAt: Date.now(),
    });
    const tree = render();
    const button = tree.root.findByProps({ accessibilityRole: 'button' });
    expect(button.props.disabled).toBe(true);
    // The onPress handler bails on the isConnected guard even if invoked.
    act(() => {
      button.props.onPress?.();
    });
    expect(sendInputSpy).not.toHaveBeenCalled();
  });

  it('exposes an accessible label that includes the prefab on the button', () => {
    setSessionWithWarning({
      idleMs: 30_000,
      prefab: 'Status update?',
      receivedAt: Date.now(),
    });
    const tree = render();
    const button = tree.root.findByProps({ accessibilityRole: 'button' });
    expect(button.props.accessibilityLabel).toBe('Send check-in: Status update?');
    expect(button.props.accessibilityRole).toBe('button');
  });

  it('clears the once-per-second interval when the warning is dismissed', () => {
    jest.useFakeTimers().setSystemTime(1_700_000_000_000);
    setSessionWithWarning({
      idleMs: 1_800_000,
      prefab: 'Status update?',
      receivedAt: 1_700_000_000_000,
    });
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const tree = render();

    // While outstanding, advancing time should not throw and chip stays visible.
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(tree.toJSON()).not.toBeNull();

    // Clear the warning — effect cleanup must call clearInterval.
    act(() => {
      setSessionWithWarning(null);
    });
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(tree.toJSON()).toBeNull();

    clearIntervalSpy.mockRestore();
  });
});
