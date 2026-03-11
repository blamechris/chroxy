import React from 'react';
import { act } from 'react';
import renderer from 'react-test-renderer';
import { SessionTimeoutBanner } from '../SessionTimeoutBanner';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('SessionTimeoutBanner', () => {
  it('renders with countdown and buttons', () => {
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SessionTimeoutBanner
          remainingMs={120000}
          sessionName="Test Session"
          onKeepAlive={jest.fn()}
          onDismiss={jest.fn()}
        />
      );
    });

    expect(tree!.toJSON()).toBeTruthy();
  });

  it('displays session name', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <SessionTimeoutBanner
          remainingMs={90000}
          sessionName="My Session"
          onKeepAlive={jest.fn()}
          onDismiss={jest.fn()}
        />
      );
    });

    const json = JSON.stringify(component!.toJSON());
    expect(json).toContain('My Session');
  });

  it('has Keep Alive button', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <SessionTimeoutBanner
          remainingMs={60000}
          sessionName="Session"
          onKeepAlive={jest.fn()}
          onDismiss={jest.fn()}
        />
      );
    });

    const keepAliveButton = component!.root.findByProps({ accessibilityLabel: 'Keep session alive' });
    expect(keepAliveButton).toBeTruthy();
  });

  it('has dismiss button', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <SessionTimeoutBanner
          remainingMs={60000}
          sessionName="Session"
          onKeepAlive={jest.fn()}
          onDismiss={jest.fn()}
        />
      );
    });

    const dismissButton = component!.root.findByProps({ accessibilityLabel: 'Dismiss timeout warning' });
    expect(dismissButton).toBeTruthy();
  });
});
