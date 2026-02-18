import { Alert } from 'react-native';
import React from 'react';

// Get the mocked module (mocked globally in jest.setup.js)
const SpeechMod = require('expo-speech-recognition');
const MockModule = SpeechMod.ExpoSpeechRecognitionModule;
const mockUseSpeechEvent = SpeechMod.useSpeechRecognitionEvent as jest.Mock;

// Capture event handlers registered via useSpeechRecognitionEvent
type EventHandler = (event: any) => void;
let eventHandlers: Record<string, EventHandler> = {};

// We need to test the hook via a test component since we don't have @testing-library/react-native
// Instead, we test the module's behavior at the unit level

beforeEach(() => {
  jest.clearAllMocks();
  eventHandlers = {};

  mockUseSpeechEvent.mockImplementation((event: string, handler: EventHandler) => {
    eventHandlers[event] = handler;
  });

  MockModule.isRecognitionAvailable.mockReturnValue(true);
  MockModule.requestPermissionsAsync.mockResolvedValue({ granted: true });
});

// Import after mock setup
import { useSpeechRecognition, UseSpeechRecognitionReturn } from '../../hooks/useSpeechRecognition';

// Minimal hook runner using React.createElement — no @testing-library needed
function renderHookSimple<T>(hookFn: () => T): { result: { current: T }; unmount: () => void } {
  const resultRef = { current: null as any as T };
  let unmountFn: (() => void) | null = null;

  function TestComponent() {
    resultRef.current = hookFn();
    return null;
  }

  // Use React's test renderer to mount the component
  const TestRenderer = require('react-test-renderer');
  let renderer: any;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(TestComponent));
  });

  return {
    result: resultRef,
    unmount: () => {
      TestRenderer.act(() => {
        renderer.unmount();
      });
    },
  };
}

async function actAsync(fn: () => Promise<void>) {
  const TestRenderer = require('react-test-renderer');
  await TestRenderer.act(fn);
}

function actSync(fn: () => void) {
  const TestRenderer = require('react-test-renderer');
  TestRenderer.act(fn);
}

describe('useSpeechRecognition', () => {
  it('initializes with correct defaults', () => {
    const { result } = renderHookSimple(() => useSpeechRecognition());
    expect(result.current.isAvailable).toBe(true);
    expect(result.current.isRecognizing).toBe(false);
    expect(result.current.transcript).toBe('');
    expect(result.current.error).toBeNull();
  });

  it('sets isAvailable false when module reports unavailable', () => {
    MockModule.isRecognitionAvailable.mockReturnValue(false);
    const { result } = renderHookSimple(() => useSpeechRecognition());
    expect(result.current.isAvailable).toBe(false);
  });

  it('sets isAvailable false when isRecognitionAvailable throws', () => {
    MockModule.isRecognitionAvailable.mockImplementation(() => {
      throw new Error('not supported');
    });
    const { result } = renderHookSimple(() => useSpeechRecognition());
    expect(result.current.isAvailable).toBe(false);
  });

  it('starts listening after permission granted', async () => {
    const { result } = renderHookSimple(() => useSpeechRecognition());

    await actAsync(async () => {
      await result.current.startListening();
    });

    expect(MockModule.requestPermissionsAsync).toHaveBeenCalled();
    expect(MockModule.start).toHaveBeenCalledWith({
      lang: 'en-US',
      interimResults: true,
      contextualStrings: ['Claude', 'Chroxy'],
    });
    expect(result.current.isRecognizing).toBe(true);
  });

  it('shows alert and does not start when permission denied', async () => {
    MockModule.requestPermissionsAsync.mockResolvedValue({ granted: false });
    const alertSpy = jest.spyOn(Alert, 'alert');

    const { result } = renderHookSimple(() => useSpeechRecognition());

    await actAsync(async () => {
      await result.current.startListening();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Permissions Required',
      expect.stringContaining('Microphone'),
    );
    expect(MockModule.start).not.toHaveBeenCalled();
    expect(result.current.isRecognizing).toBe(false);
  });

  it('updates transcript on result event', async () => {
    const { result } = renderHookSimple(() => useSpeechRecognition());

    await actAsync(async () => {
      await result.current.startListening();
    });

    actSync(() => {
      eventHandlers['result']?.({ results: [{ transcript: 'hello world' }] });
    });

    expect(result.current.transcript).toBe('hello world');
  });

  it('sets isRecognizing false on end event', async () => {
    const { result } = renderHookSimple(() => useSpeechRecognition());

    await actAsync(async () => {
      await result.current.startListening();
    });
    expect(result.current.isRecognizing).toBe(true);

    actSync(() => {
      eventHandlers['end']?.({});
    });

    expect(result.current.isRecognizing).toBe(false);
  });

  it('sets error on non-abort error event', async () => {
    const { result } = renderHookSimple(() => useSpeechRecognition());

    await actAsync(async () => {
      await result.current.startListening();
    });

    actSync(() => {
      eventHandlers['error']?.({ error: 'network', message: 'Network error' });
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.isRecognizing).toBe(false);
  });

  it('ignores abort errors (no user-visible error)', async () => {
    const { result } = renderHookSimple(() => useSpeechRecognition());

    await actAsync(async () => {
      await result.current.startListening();
    });

    actSync(() => {
      eventHandlers['error']?.({ error: 'aborted', message: 'Aborted' });
    });

    expect(result.current.error).toBeNull();
    expect(result.current.isRecognizing).toBe(false);
  });

  it('calls module.stop on stopListening', async () => {
    const { result } = renderHookSimple(() => useSpeechRecognition());

    await actAsync(async () => {
      await result.current.startListening();
    });

    actSync(() => {
      result.current.stopListening();
    });

    expect(MockModule.stop).toHaveBeenCalled();
  });

  it('aborts on unmount', () => {
    const { unmount } = renderHookSimple(() => useSpeechRecognition());
    unmount();
    expect(MockModule.abort).toHaveBeenCalled();
  });

  it('does not start if stopListening called during permission await', async () => {
    let resolvePermission: (v: any) => void;
    MockModule.requestPermissionsAsync.mockReturnValue(
      new Promise((resolve) => { resolvePermission = resolve; })
    );

    const { result } = renderHookSimple(() => useSpeechRecognition());

    let startPromise: Promise<void>;
    actSync(() => {
      startPromise = result.current.startListening();
    });

    actSync(() => {
      result.current.stopListening();
    });

    await actAsync(async () => {
      resolvePermission!({ granted: true });
      await startPromise!;
    });

    expect(MockModule.start).not.toHaveBeenCalled();
  });
});
