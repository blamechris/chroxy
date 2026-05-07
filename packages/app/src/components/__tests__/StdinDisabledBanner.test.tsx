/**
 * StdinDisabledBanner tests (#3595)
 *
 * Verifies the banner renders only when the active session has the latched
 * `stdinForwardingDisabled` flag and that the restart button forwards the
 * active sessionId to the parent's `onRestart` handler (which destroys the
 * broken session and re-creates it with the same cwd / name / provider).
 *
 * Mirrors `packages/dashboard/src/components/StdinDisabledBanner.test.tsx`.
 */
import React from 'react';
import { act } from 'react';
import renderer from 'react-test-renderer';
import { StdinDisabledBanner } from '../StdinDisabledBanner';

describe('StdinDisabledBanner', () => {
  it('renders when visible with a sessionId', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <StdinDisabledBanner visible sessionId="s1" onRestart={jest.fn()} />
      );
    });

    const banner = component!.root.findByProps({ testID: 'stdin-disabled-banner' });
    expect(banner).toBeTruthy();

    const json = JSON.stringify(component!.toJSON());
    expect(json).toContain('Stdin forwarding lost');
  });

  it('renders nothing when visible is false', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <StdinDisabledBanner visible={false} sessionId="s1" onRestart={jest.fn()} />
      );
    });

    expect(component!.toJSON()).toBeNull();
  });

  it('renders nothing when sessionId is null even if visible', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <StdinDisabledBanner visible sessionId={null} onRestart={jest.fn()} />
      );
    });

    expect(component!.toJSON()).toBeNull();
  });

  it('uses accessibilityRole="alert" + accessibilityLiveRegion="polite" so screen readers announce the disabled state', () => {
    // The disabled state is a recovery hint, not an emergency. Polite live
    // region softens the urgency on Android; accessibilityRole="alert" still
    // ensures the message is announced.
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <StdinDisabledBanner visible sessionId="s1" onRestart={jest.fn()} />
      );
    });

    const banner = component!.root.findByProps({ testID: 'stdin-disabled-banner' });
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(banner.props.accessibilityLiveRegion).toBe('polite');
  });

  it('forwards the active sessionId to onRestart when the button is pressed', () => {
    const onRestart = jest.fn();
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <StdinDisabledBanner visible sessionId="s1" onRestart={onRestart} />
      );
    });

    const button = component!.root.findByProps({ testID: 'stdin-disabled-restart-button' });
    act(() => {
      button.props.onPress();
    });

    expect(onRestart).toHaveBeenCalledWith('s1');
  });
});

