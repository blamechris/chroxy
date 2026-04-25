import React from 'react';
import { act } from 'react';
import renderer from 'react-test-renderer';
import { CreateSessionModal } from '../CreateSessionModal';
import { useConnectionStore } from '../../store/connection';

jest.mock('../../store/connection', () => ({
  useConnectionStore: jest.fn(),
}));

jest.mock('../FolderBrowser', () => ({
  FolderBrowser: () => null,
}));

const mockUseConnectionStore = useConnectionStore as unknown as jest.Mock;

const mockFetchProviders = jest.fn();
const mockCreateSession = jest.fn();

function setupStore(availableProviders: any[] = []) {
  mockUseConnectionStore.mockImplementation((selector: any) => {
    const state = {
      availableProviders,
      fetchProviders: mockFetchProviders,
      createSession: mockCreateSession,
      sessions: [],
    };
    return selector(state);
  });
}

/** Returns a setter that re-wires the mock to a new providers list. */
function setupDynamicStore(initialProviders: any[] = []) {
  let providers = initialProviders;
  const set = (next: any[]) => {
    providers = next;
  };
  mockUseConnectionStore.mockImplementation((selector: any) => {
    const state = {
      get availableProviders() { return providers; },
      fetchProviders: mockFetchProviders,
      createSession: mockCreateSession,
      sessions: [],
    };
    return selector(state);
  });
  return set;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('CreateSessionModal provider loading state', () => {
  it('shows "Loading providers…" immediately after modal opens', () => {
    setupStore([]);

    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <CreateSessionModal visible onClose={jest.fn()} />
      );
    });

    const json = JSON.stringify(component!.toJSON());
    expect(json).toContain('Loading providers');
  });

  it('hides loading hint after 5s timeout when server never responds', () => {
    setupStore([]);

    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <CreateSessionModal visible onClose={jest.fn()} />
      );
    });

    // Before timeout: still loading
    const jsonBefore = JSON.stringify(component!.toJSON());
    expect(jsonBefore).toContain('Loading providers');

    // Advance past the 5-second timeout
    act(() => {
      jest.advanceTimersByTime(5001);
    });

    const jsonAfter = JSON.stringify(component!.toJSON());
    expect(jsonAfter).not.toContain('Loading providers');
    // Should show the empty-state message instead
    expect(jsonAfter).toContain('No additional providers available');
  });

  it('shows providers immediately when server responds before timeout', () => {
    setupStore([{ name: 'bedrock' }]);

    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <CreateSessionModal visible onClose={jest.fn()} />
      );
    });

    const json = JSON.stringify(component!.toJSON());
    expect(json).not.toContain('Loading providers');
    // 'bedrock' is not a labelled provider, falls back to raw name
    expect(json).toContain('bedrock');
  });

  it('clears loading hint when providers arrive before the 5s timeout', () => {
    const setProviders = setupDynamicStore([]);

    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <CreateSessionModal visible onClose={jest.fn()} />
      );
    });

    // Modal opens → loading hint shown, timeout pending
    let json = JSON.stringify(component!.toJSON());
    expect(json).toContain('Loading providers');

    // Server responds before timeout — update store and re-render
    act(() => {
      setProviders([{ name: 'bedrock' }]);
      component.update(<CreateSessionModal visible onClose={jest.fn()} />);
    });

    json = JSON.stringify(component!.toJSON());
    expect(json).not.toContain('Loading providers');
    expect(json).toContain('bedrock');

    // Advancing past the timeout must NOT flip the UI back to the error state
    act(() => {
      jest.advanceTimersByTime(5001);
    });

    json = JSON.stringify(component!.toJSON());
    expect(json).not.toContain('No additional providers available');
    expect(json).toContain('bedrock');
  });

  it('resets loading state when modal is reopened', () => {
    setupStore([]);

    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <CreateSessionModal visible onClose={jest.fn()} />
      );
    });

    // Advance past timeout
    act(() => {
      jest.advanceTimersByTime(5001);
    });

    let json = JSON.stringify(component!.toJSON());
    expect(json).not.toContain('Loading providers');

    // Close and re-open modal — loading state should reset
    act(() => {
      component.update(<CreateSessionModal visible={false} onClose={jest.fn()} />);
    });
    act(() => {
      component.update(<CreateSessionModal visible onClose={jest.fn()} />);
    });

    json = JSON.stringify(component!.toJSON());
    expect(json).toContain('Loading providers');
  });

  it('shows "No additional providers available" after timeout with retry button', () => {
    setupStore([]);

    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <CreateSessionModal visible onClose={jest.fn()} />
      );
    });

    act(() => {
      jest.advanceTimersByTime(5001);
    });

    const retryButton = component!.root.findByProps({ accessibilityLabel: 'Retry loading providers' });
    expect(retryButton).toBeTruthy();
  });

  it('retry button calls fetchProviders and resets loading state', () => {
    setupStore([]);

    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <CreateSessionModal visible onClose={jest.fn()} />
      );
    });

    act(() => {
      jest.advanceTimersByTime(5001);
    });

    const retryButton = component!.root.findByProps({ accessibilityLabel: 'Retry loading providers' });

    act(() => {
      retryButton.props.onPress();
    });

    expect(mockFetchProviders).toHaveBeenCalledTimes(2); // once on open, once on retry
    // After retry, loading hint should be shown again
    const json = JSON.stringify(component!.toJSON());
    expect(json).toContain('Loading providers');
  });

  it('resets providersTimedOut when providers arrive after the timeout fires', () => {
    const setProviders = setupDynamicStore([]);

    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <CreateSessionModal visible onClose={jest.fn()} />
      );
    });

    // Let the 5-second timeout fire → timed-out state shown
    act(() => {
      jest.advanceTimersByTime(5001);
    });

    let json = JSON.stringify(component!.toJSON());
    expect(json).toContain('No additional providers available');
    expect(json).not.toContain('Loading providers');

    // Providers arrive late — update the store and re-render
    act(() => {
      setProviders([{ name: 'bedrock' }]);
      component.update(<CreateSessionModal visible onClose={jest.fn()} />);
    });

    json = JSON.stringify(component!.toJSON());
    // Timed-out state must be gone; provider chip must be visible
    expect(json).not.toContain('No additional providers available');
    expect(json).not.toContain('Loading providers');
    expect(json).toContain('bedrock');
  });

  it('Default chip always renders regardless of provider load state', () => {
    setupStore([]);

    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <CreateSessionModal visible onClose={jest.fn()} />
      );
    });

    // Default chip visible immediately
    let defaultChip = component!.root.findByProps({ accessibilityLabel: 'Provider: Default' });
    expect(defaultChip).toBeTruthy();

    // Default chip still visible after timeout
    act(() => {
      jest.advanceTimersByTime(5001);
    });

    defaultChip = component!.root.findByProps({ accessibilityLabel: 'Provider: Default' });
    expect(defaultChip).toBeTruthy();
  });
});
