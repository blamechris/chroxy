/**
 * Render tests for ActivityIndicator (#3783).
 *
 * The pure `statusColor` helper is covered by ActivityIndicatorStatusColor.test.ts
 * (#3782). This file covers the render-side branches: idle (null render),
 * null-`lastClientActivityAt` (static green pill), elapsed-time + color
 * propagation, the `approaching` sub-text with `Math.ceil` rounding, and
 * the once-per-second interval cleanup when the session flips back to idle.
 *
 * Pattern matches PermissionPill.test.tsx — react-test-renderer + act,
 * with Zustand stores driven via setState rather than mocked.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text, View } from 'react-native';
import { ActivityIndicator } from '../ActivityIndicator';
import { COLORS } from '../../constants/colors';
import { useConnectionStore } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { createEmptySessionState } from '../../store/utils';

const SESSION_ID = 's-test';
// Use a 20-min reference timeout for most cases (matches production default).
const TIMEOUT_20MIN = 20 * 60_000;

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

function setSessionState(opts: { isIdle: boolean; lastClientActivityAt: number | null }) {
  const base = createEmptySessionState();
  useConnectionStore.setState({
    activeSessionId: SESSION_ID,
    sessionStates: { [SESSION_ID]: { ...base, isIdle: opts.isIdle, lastClientActivityAt: opts.lastClientActivityAt } },
  });
}

function setReferenceTimeoutMs(ms: number | null) {
  useConnectionLifecycleStore.setState({ serverResultTimeoutMs: ms });
}

describe('ActivityIndicator render branches', () => {
  // Track each test's renderer so we can unmount in afterEach — otherwise
  // orphan subscribers from the previous test re-render when the next test's
  // beforeEach resets the store, triggering a benign-but-noisy act() warning.
  let activeTree: renderer.ReactTestRenderer | null = null;

  function render(): renderer.ReactTestRenderer {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<ActivityIndicator />); });
    activeTree = tree;
    return tree;
  }

  beforeEach(() => {
    useConnectionStore.setState({ activeSessionId: null, sessionStates: {} });
    setReferenceTimeoutMs(null);
  });

  afterEach(() => {
    if (activeTree) {
      act(() => { activeTree!.unmount(); });
      activeTree = null;
    }
    jest.useRealTimers();
  });

  it('renders null when the active session is idle', () => {
    setSessionState({ isIdle: true, lastClientActivityAt: null });
    const tree = render();
    expect(tree.toJSON()).toBeNull();
  });

  it('renders null when there is no active session', () => {
    // activeSessionId stays null after the beforeEach reset.
    const tree = render();
    expect(tree.toJSON()).toBeNull();
  });

  it('renders the static green Working… pill when busy with no lastClientActivityAt', () => {
    setSessionState({ isIdle: false, lastClientActivityAt: null });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Working…');
    // No elapsed-time suffix.
    expect(text).not.toContain('ago');
    expect(text).not.toContain('approaching');

    // Both the dot (View) and the label (Text) should use accentGreen.
    const labelNode = tree.root.findByType(Text);
    const labelStyle = Array.isArray(labelNode.props.style) ? Object.assign({}, ...labelNode.props.style) : labelNode.props.style;
    expect(labelStyle.color).toBe(COLORS.accentGreen);

    // The dot is the first View inside the container; its backgroundColor is the dot color.
    const dotView = tree.root.findAllByType(View).find((v) => {
      const style = Array.isArray(v.props.style) ? Object.assign({}, ...v.props.style) : v.props.style;
      return style && typeof style.backgroundColor === 'string';
    });
    expect(dotView).toBeDefined();
    const dotStyle = Array.isArray(dotView!.props.style) ? Object.assign({}, ...dotView!.props.style) : dotView!.props.style;
    expect(dotStyle.backgroundColor).toBe(COLORS.accentGreen);
  });

  it('renders the elapsed-time suffix when busy with a recent lastClientActivityAt', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setReferenceTimeoutMs(TIMEOUT_20MIN);
    setSessionState({ isIdle: false, lastClientActivityAt: now - 5_000 });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Working…');
    expect(text).toContain('5s ago');
    expect(text).not.toContain('approaching');

    // 5s elapsed against a 20-min timeout → green band.
    const labelNode = tree.root.findAllByType(Text)[0];
    const style = Array.isArray(labelNode.props.style) ? Object.assign({}, ...labelNode.props.style) : labelNode.props.style;
    expect(style.color).toBe(COLORS.accentGreen);
  });

  it('shows the approaching-timeout warning with Math.ceil rounding when remaining <= 60s', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setReferenceTimeoutMs(TIMEOUT_20MIN);
    // lastClientActivityAt set so remaining = TIMEOUT_20MIN - elapsed = 30_500 ms.
    // 30_500 / 1000 = 30.5 → Math.ceil → 31 → "31s left".
    const elapsed = TIMEOUT_20MIN - 30_500;
    setSessionState({ isIdle: false, lastClientActivityAt: now - elapsed });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).toContain('approaching timeout');
    expect(text).toContain('31s left');
  });

  it('hides the approaching warning when remaining > 60s', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setReferenceTimeoutMs(TIMEOUT_20MIN);
    // elapsed = 60_001 ms before timeout boundary → remaining = 60_001 → just outside the window.
    const elapsed = TIMEOUT_20MIN - 60_001;
    setSessionState({ isIdle: false, lastClientActivityAt: now - elapsed });
    const tree = render();
    const text = collectVisibleText(tree.root);
    expect(text).not.toContain('approaching');
  });

  it('clears the once-per-second interval when the session transitions to idle', () => {
    const now = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(now);
    setReferenceTimeoutMs(TIMEOUT_20MIN);
    setSessionState({ isIdle: false, lastClientActivityAt: now - 5_000 });

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    const tree = render();

    // While busy, advancing time should not throw and should keep the indicator visible.
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(tree.toJSON()).not.toBeNull();

    // Flip to idle — effect cleanup runs and clearInterval should fire.
    act(() => {
      setSessionState({ isIdle: true, lastClientActivityAt: null });
    });
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(tree.toJSON()).toBeNull();

    clearIntervalSpy.mockRestore();
  });
});
