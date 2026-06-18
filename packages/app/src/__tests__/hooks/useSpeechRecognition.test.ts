import { Alert } from 'react-native';
import React from 'react';

// Get the mocked module (mocked globally in jest.setup.js)
const SpeechMod = require('expo-speech-recognition');
const MockModule = SpeechMod.ExpoSpeechRecognitionModule;
const mockUseSpeechEvent = SpeechMod.useSpeechRecognitionEvent as jest.Mock;

// Controllable SecureStore mock — allows tests to defer getItemAsync
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

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
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import { renderHookSimple, actAsync } from '../../test-utils/test-helpers';

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

  it('does not start if component unmounts during permission await', async () => {
    let resolvePermission: (v: any) => void;
    MockModule.requestPermissionsAsync.mockReturnValue(
      new Promise((resolve) => { resolvePermission = resolve; })
    );

    const { result, unmount } = renderHookSimple(() => useSpeechRecognition());

    let startPromise: Promise<void>;
    actSync(() => {
      startPromise = result.current.startListening();
    });

    // Unmount while permission request is in flight
    unmount();

    await actAsync(async () => {
      resolvePermission!({ granted: true });
      await startPromise!;
    });

    expect(MockModule.start).not.toHaveBeenCalled();
  });

  it('does not start if component unmounts during getSpeechLang await', async () => {
    // Permission resolves immediately; use a deferred SecureStore to create the async gap,
    // then unmount the component before resolving, simulating unmount mid-getSpeechLang
    MockModule.requestPermissionsAsync.mockResolvedValue({ granted: true });

    const SecureStore = jest.requireMock('expo-secure-store');

    let resolveStore!: (v: string | null) => void;
    const storePromise = new Promise<string | null>((resolve) => { resolveStore = resolve; });
    SecureStore.getItemAsync.mockImplementationOnce(() => storePromise);

    const { result, unmount } = renderHookSimple(() => useSpeechRecognition());

    // startListening will block at getItemAsync (after permissions resolve)
    let startPromise: Promise<void>;
    actSync(() => { startPromise = result.current.startListening(); });

    // Flush microtasks so startListening advances past permissions to getItemAsync
    await Promise.resolve();
    await Promise.resolve();

    // Now the code is suspended inside getSpeechLang awaiting the deferred promise.
    // Unmount the component to set mountedRef.current = false.
    unmount();

    // Resolve the deferred promise and let startListening finish
    await actAsync(async () => {
      resolveStore(null);
      await startPromise!;
    });

    expect(MockModule.start).not.toHaveBeenCalled();
  });

  it('does not start if stopListening called during getSpeechLang await', async () => {
    MockModule.requestPermissionsAsync.mockResolvedValue({ granted: true });

    const SecureStore = jest.requireMock('expo-secure-store');
    const { result } = renderHookSimple(() => useSpeechRecognition());

    // Install a deferred getItemAsync that also triggers stopListening when called,
    // simulating stopListening being called while getSpeechLang is in flight
    SecureStore.getItemAsync.mockImplementationOnce(
      () => {
        // stopListening fires synchronously when getSpeechLang reaches getItemAsync
        result.current.stopListening();
        return Promise.resolve(null);
      }
    );

    await actAsync(async () => {
      await result.current.startListening();
    });

    expect(MockModule.start).not.toHaveBeenCalled();
  });

  // ---- #4807: voiceInputMode wiring ----

  describe('voiceInputMode: continuous', () => {
    it('restarts recognition on end event when mode=continuous', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });

      expect(MockModule.start).toHaveBeenCalledTimes(1);

      // Silence-triggered end should re-arm recognition
      actSync(() => {
        eventHandlers['end']?.({});
      });

      expect(MockModule.start).toHaveBeenCalledTimes(2);
      // Mic stays lit during the restart blip
      expect(result.current.isRecognizing).toBe(true);
    });

    // #4827: fresh-start and silence-restart must hand SpeechModule.start the
    // identical options shape. They previously constructed the literal twice
    // and drifted; both call sites now route through a single helper.
    it('fresh start and continuous restart pass identical start() options', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });

      // First call: fresh user-initiated start.
      expect(MockModule.start).toHaveBeenCalledTimes(1);
      const freshOpts = MockModule.start.mock.calls[0][0];

      // Trigger silence-restart branch.
      actSync(() => {
        eventHandlers['end']?.({});
      });

      expect(MockModule.start).toHaveBeenCalledTimes(2);
      const restartOpts = MockModule.start.mock.calls[1][0];

      // Byte-identical option shape — guards against future drift like the
      // pre-#4827 duplicated object literals.
      expect(restartOpts).toEqual(freshOpts);
      // And the expected shape itself, so a regression that strips a field
      // from both sites is still caught.
      expect(freshOpts).toEqual({
        lang: 'en-US',
        interimResults: true,
        contextualStrings: ['Claude', 'Chroxy'],
      });
    });

    it('caps restart attempts at MAX_CONTINUOUS_RESTARTS (5)', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });

      // Initial start = 1 call. Fire `end` repeatedly; each one within the cap
      // should add a start() call.
      for (let i = 0; i < 10; i++) {
        actSync(() => {
          eventHandlers['end']?.({});
        });
      }

      // 1 initial + 5 restart attempts before the cap kicks in = 6 total
      expect(MockModule.start).toHaveBeenCalledTimes(6);
      // After the cap, end clears the mic
      expect(result.current.isRecognizing).toBe(false);
    });

    it('does NOT restart on end when user explicitly stopped', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);

      actSync(() => {
        result.current.stopListening();
      });

      // Engine fires onend after stop() — should NOT re-arm
      actSync(() => {
        eventHandlers['end']?.({});
      });

      expect(MockModule.start).toHaveBeenCalledTimes(1);
      expect(result.current.isRecognizing).toBe(false);
    });

    it('resets restart counter on a non-empty transcript', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });

      // Exhaust 3 of 5 restarts
      for (let i = 0; i < 3; i++) {
        actSync(() => { eventHandlers['end']?.({}); });
      }
      expect(MockModule.start).toHaveBeenCalledTimes(4);

      // Real transcript should reset the counter
      actSync(() => {
        eventHandlers['result']?.({ results: [{ transcript: 'hi there' }] });
      });

      // Now 5 more `end`s should each restart
      for (let i = 0; i < 5; i++) {
        actSync(() => { eventHandlers['end']?.({}); });
      }
      // 4 (prior) + 5 (post-reset) = 9 total starts
      expect(MockModule.start).toHaveBeenCalledTimes(9);
    });
  });

  describe('voiceInputMode: auto-pause', () => {
    it('does NOT restart on end when mode=auto-pause', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'auto-pause' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);

      actSync(() => {
        eventHandlers['end']?.({});
      });

      // No restart, mic clears — pre-#4785 behaviour
      expect(MockModule.start).toHaveBeenCalledTimes(1);
      expect(result.current.isRecognizing).toBe(false);
    });

    it('defaults to auto-pause when no mode option supplied', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition());

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);

      actSync(() => {
        eventHandlers['end']?.({});
      });

      // Backward-compatible default = single-shot behaviour
      expect(MockModule.start).toHaveBeenCalledTimes(1);
      expect(result.current.isRecognizing).toBe(false);
    });
  });

  it('continuous restart does not fire after unmount (#4789 mirror)', async () => {
    const { result, unmount } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

    await actAsync(async () => {
      await result.current.startListening();
    });
    expect(MockModule.start).toHaveBeenCalledTimes(1);

    unmount();
    expect(MockModule.abort).toHaveBeenCalled();

    // Capture call count after unmount; any subsequent `end` from the engine
    // (e.g. fired by abort()) must NOT trigger restart.
    const startsAfterUnmount = MockModule.start.mock.calls.length;
    actSync(() => {
      eventHandlers['end']?.({});
    });
    expect(MockModule.start).toHaveBeenCalledTimes(startsAfterUnmount);
  });

  // ---- #4813 Copilot finding: error→end must not re-arm in continuous mode ----

  // ---- #4826: startListening must tear down prior in-flight session ----
  // Mirrors the #4789 dashboard fix's start-path prior-cleanup. Today the
  // expo-speech-recognition module-level singleton likely masks this, but the
  // contract is: a fresh `startListening` cannot land on top of a session that
  // the engine still considers active. Without this guarantee, a double-tap
  // (or gesture + voice-command race) could let the prior session's queued
  // `onend` re-arm in continuous mode against the new session's bookkeeping
  // refs — the exact dual-mic window #4789 closed on the dashboard.

  describe('startListening prior-session teardown (#4826)', () => {
    it('aborts prior session when startListening called while already recognizing', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition());

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);
      expect(MockModule.abort).not.toHaveBeenCalled();
      expect(result.current.isRecognizing).toBe(true);

      // Second start while the first is still in-flight.
      await actAsync(async () => {
        await result.current.startListening();
      });

      // Must abort the prior session and start a new one.
      expect(MockModule.abort).toHaveBeenCalledTimes(1);
      expect(MockModule.start).toHaveBeenCalledTimes(2);
    });

    it('aborts prior session BEFORE starting the new one', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition());

      await actAsync(async () => {
        await result.current.startListening();
      });

      // Track call order across abort/start to assert teardown precedes restart.
      const callOrder: string[] = [];
      MockModule.abort.mockImplementation(() => callOrder.push('abort'));
      const priorStart = MockModule.start.getMockImplementation();
      MockModule.start.mockImplementation((opts: unknown) => {
        callOrder.push('start');
        return priorStart?.(opts);
      });

      await actAsync(async () => {
        await result.current.startListening();
      });

      const abortIdx = callOrder.indexOf('abort');
      const startIdx = callOrder.indexOf('start');
      expect(abortIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(abortIdx).toBeLessThan(startIdx);
    });

    it('prior-teardown suppresses continuous-mode end re-arm against new bookkeeping', async () => {
      // Reproduces the #4789 dual-mic window in the start-path:
      // - first startListening → in-flight continuous session
      // - second startListening → fresh user-initiated session, must NOT
      //   leave a queued onend able to re-arm using the new session's
      //   userStoppedRef (which has just been reset to false)
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);

      // Second startListening before the first session has ended. The
      // start-path teardown must flip userStoppedRef=true BEFORE abort,
      // then the post-permission fresh-session bookkeeping flips it back
      // to false — but by then any queued onend from the prior abort has
      // already been observed and discarded.
      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.abort).toHaveBeenCalledTimes(1);
      expect(MockModule.start).toHaveBeenCalledTimes(2);

      // Now the new session is mounted. A fresh silence-triggered end
      // belongs to the NEW session and should re-arm normally.
      actSync(() => {
        eventHandlers['end']?.({});
      });
      expect(MockModule.start).toHaveBeenCalledTimes(3);
    });

    // ---- #4851: end-handler defence-in-depth for the abort-end race ----
    // Reproduces the residual race the start-path teardown (#4826) cannot
    // close on the mobile platform: `SpeechModule.abort()` queues `onend`
    // asynchronously, but the sync block resets `userStoppedRef = false`
    // BEFORE the queued `onend` fires. Without the `inFlightRef.current`
    // gate in the end handler, the stale queued end satisfies every re-arm
    // condition and starts a stale recogniser on top of the new session.
    it('end-handler ignores stale onend fired between abort and new start (#4851)', async () => {
      // Simulate the native engine queuing onend asynchronously from abort().
      // Wire abort() to schedule an `end` on the microtask queue — this is
      // the race window: the next sync block clears inFlightRef before the
      // queued end fires.
      MockModule.abort.mockImplementation(() => {
        Promise.resolve().then(() => {
          eventHandlers['end']?.({});
        });
      });

      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);

      // Second startListening triggers the prior-teardown branch:
      //   1) userStoppedRef = true (sync)
      //   2) SpeechModule.abort() — queues onend on microtask queue
      //   3) inFlightRef = false (sync)
      //   4) userStoppedRef = false (sync, fresh-session bookkeeping)
      //   5) await permission / lang
      //   6) SpeechModule.start() — fresh session
      // Between (4) and (6), the queued onend from step 2 fires. Without
      // the inFlightRef gate, every other re-arm condition is satisfied
      // (continuous + !userStoppedRef + mounted + counter<cap) and the
      // end handler calls SpeechModule.start() against the prior session
      // BEFORE the fresh session's start() lands — exactly the dual-mic
      // window the dashboard #4789 closed via handler nulling.
      await actAsync(async () => {
        await result.current.startListening();
      });

      // Two start() calls total: the original and the fresh session.
      // If the stale queued end re-armed, this would be 3.
      expect(MockModule.start).toHaveBeenCalledTimes(2);
      expect(MockModule.abort).toHaveBeenCalledTimes(1);
    });

    it('does NOT abort when no prior session is in-flight', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition());

      await actAsync(async () => {
        await result.current.startListening();
      });

      expect(MockModule.abort).not.toHaveBeenCalled();
      expect(MockModule.start).toHaveBeenCalledTimes(1);
    });

    it('does NOT abort when prior session has already ended', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition());

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);

      // Prior session ends naturally (auto-pause mode).
      actSync(() => {
        eventHandlers['end']?.({});
      });
      expect(result.current.isRecognizing).toBe(false);

      // Fresh start — nothing to tear down.
      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.abort).not.toHaveBeenCalled();
      expect(MockModule.start).toHaveBeenCalledTimes(2);
    });
  });

  describe('voiceInputMode: continuous error→end restart suppression', () => {
    it.each([
      'not-allowed',
      'service-not-allowed',
      'audio-capture',
      'aborted',
      'interrupted',
      'language-not-supported',
    ])('does NOT restart on end after hard error (%s)', async (errCode) => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);

      // Hard error fires — should mark stop as user/terminal so the
      // subsequent `end` event doesn't re-arm a recogniser the UI thinks
      // is stopped.
      actSync(() => {
        eventHandlers['error']?.({ error: errCode, message: errCode });
      });
      expect(result.current.isRecognizing).toBe(false);

      // Spec-mandated `end` after error must NOT restart, otherwise the
      // engine silently holds the mic while the UI shows stopped.
      actSync(() => {
        eventHandlers['end']?.({});
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);
      expect(result.current.isRecognizing).toBe(false);
    });

    it.each([
      'no-speech',
      'network',
      'speech-timeout',
    ])('DOES restart on end after soft error (%s) in continuous mode', async (errCode) => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(MockModule.start).toHaveBeenCalledTimes(1);

      // Soft error fires — `end` should still re-arm so continuous mode
      // can recover from transient silence/network blips.
      actSync(() => {
        eventHandlers['error']?.({ error: errCode, message: errCode });
      });
      actSync(() => {
        eventHandlers['end']?.({});
      });

      expect(MockModule.start).toHaveBeenCalledTimes(2);
    });
  });

  // ---- #4829: no isRecognizing flicker on soft-error→restart cycle ----

  describe('#4829: isRecognizing stability across soft-error restart', () => {
    it.each([
      'no-speech',
      'network',
      'speech-timeout',
    ])('keeps isRecognizing=true after soft error (%s) in continuous mode (no flicker)', async (errCode) => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(result.current.isRecognizing).toBe(true);

      // Soft error should NOT flip the mic off — from the user's perspective
      // the engine is still "listening" across the restart blip.
      actSync(() => {
        eventHandlers['error']?.({ error: errCode, message: errCode });
      });
      expect(result.current.isRecognizing).toBe(true);

      // Spec-mandated `end` after error re-arms recognition; mic stays lit.
      actSync(() => {
        eventHandlers['end']?.({});
      });
      expect(result.current.isRecognizing).toBe(true);
      expect(MockModule.start).toHaveBeenCalledTimes(2);
    });

    it.each([
      'not-allowed',
      'service-not-allowed',
      'audio-capture',
      'aborted',
      'interrupted',
      'language-not-supported',
    ])('flips isRecognizing=false on hard error (%s) in continuous mode', async (errCode) => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(result.current.isRecognizing).toBe(true);

      actSync(() => {
        eventHandlers['error']?.({ error: errCode, message: errCode });
      });

      // Hard errors are terminal — mic must clear immediately.
      expect(result.current.isRecognizing).toBe(false);
    });

    it('flips isRecognizing=false on user-initiated stop in continuous mode', async () => {
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'continuous' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(result.current.isRecognizing).toBe(true);

      actSync(() => {
        result.current.stopListening();
      });

      // Engine fires `end` after stop() — user-initiated stop clears the mic.
      actSync(() => {
        eventHandlers['end']?.({});
      });
      expect(result.current.isRecognizing).toBe(false);
    });

    it.each([
      'no-speech',
      'network',
      'speech-timeout',
    ])('flips isRecognizing=false on soft error (%s) in auto-pause mode', async (errCode) => {
      // Auto-pause is the single-shot mode — soft errors should still clear
      // the mic since there is no continuous-restart loop to ride through.
      const { result } = renderHookSimple(() => useSpeechRecognition({ mode: 'auto-pause' }));

      await actAsync(async () => {
        await result.current.startListening();
      });
      expect(result.current.isRecognizing).toBe(true);

      actSync(() => {
        eventHandlers['error']?.({ error: errCode, message: errCode });
      });

      expect(result.current.isRecognizing).toBe(false);
    });
  });
});
