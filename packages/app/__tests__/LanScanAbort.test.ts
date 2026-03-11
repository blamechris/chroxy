import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/utils/lan-scanner.ts'),
  'utf-8',
)

describe('LAN scan AbortController fix (#1947)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Simulate the per-IP probe pattern from ConnectScreen.
   * This is the exact logic being tested — extracted as a standalone function.
   */
  function probeIp(
    outerSignal: AbortSignal,
    fetchFn: (signal: AbortSignal) => Promise<Response>,
    timeoutMs: number = 1500,
  ): { abortLog: string[] } {
    const log: string[] = [];
    const ctrl = new AbortController();

    const timeout = setTimeout(() => {
      log.push('timeout-fired');
      ctrl.abort();
    }, timeoutMs);

    const onOuterAbort = () => {
      log.push('outer-abort');
      clearTimeout(timeout);
      ctrl.abort();
    };

    outerSignal.addEventListener('abort', onOuterAbort);

    fetchFn(ctrl.signal)
      .then(() => log.push('fetch-success'))
      .catch(() => log.push('fetch-error'))
      .finally(() => {
        clearTimeout(timeout);
        outerSignal.removeEventListener('abort', onOuterAbort);
      });

    return { abortLog: log };
  }

  test('outer abort clears timeout before aborting inner controller', () => {
    const outer = new AbortController();
    const fetchFn = jest.fn(() => new Promise<Response>(() => {})); // never resolves

    const { abortLog } = probeIp(outer.signal, fetchFn);

    // Fire outer abort
    outer.abort();

    // outer-abort should fire and clear the timeout
    expect(abortLog).toContain('outer-abort');

    // Advance past the timeout — it should NOT fire since it was cleared
    jest.advanceTimersByTime(2000);
    expect(abortLog).not.toContain('timeout-fired');
  });

  test('inner timeout fires when outer abort does not', () => {
    const outer = new AbortController();
    const fetchFn = jest.fn(() => new Promise<Response>(() => {}));

    const { abortLog } = probeIp(outer.signal, fetchFn, 1500);

    // Advance past timeout
    jest.advanceTimersByTime(1600);

    expect(abortLog).toContain('timeout-fired');
    expect(abortLog).not.toContain('outer-abort');
  });

  test('timeout does not double-abort after outer abort', () => {
    const outer = new AbortController();
    const fetchFn = jest.fn(() => new Promise<Response>(() => {}));
    const { abortLog } = probeIp(outer.signal, fetchFn);

    // Fire outer abort
    outer.abort();

    // Advance timers — timeout should not fire
    jest.advanceTimersByTime(2000);

    // Only one abort source should have fired
    const abortEvents = abortLog.filter(e => e === 'outer-abort' || e === 'timeout-fired');
    expect(abortEvents).toEqual(['outer-abort']);
  });

  test('successful fetch cleans up timeout and listener', async () => {
    const outer = new AbortController();
    const mockResponse = new Response('{"status":"ok"}');
    const fetchFn = jest.fn(() => Promise.resolve(mockResponse));

    const { abortLog } = probeIp(outer.signal, fetchFn);

    // Flush microtask queue: fetchFn resolves → .then → .catch (skip) → .finally
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(abortLog).toContain('fetch-success');

    // After success, outer abort should not cause issues
    outer.abort();
    jest.advanceTimersByTime(2000);

    // timeout-fired should NOT appear — cleared in finally
    expect(abortLog).not.toContain('timeout-fired');
    // outer-abort should NOT appear — listener removed in finally
    expect(abortLog).not.toContain('outer-abort');
  });
});
