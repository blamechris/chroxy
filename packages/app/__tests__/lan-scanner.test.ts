/**
 * Tests for LAN scanner utility.
 * Mocks fetch to simulate network probes.
 */
import { validatePort, scanSubnet } from '../src/utils/lan-scanner';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

beforeEach(() => {
  mockFetch.mockReset();
  // Default: all fetches fail (connection refused)
  mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'));
});

describe('validatePort', () => {
  it('returns number for valid port', () => {
    expect(validatePort('8765')).toBe(8765);
    expect(validatePort('1')).toBe(1);
    expect(validatePort('65535')).toBe(65535);
  });

  it('returns null for non-numeric', () => {
    expect(validatePort('abc')).toBeNull();
    expect(validatePort('')).toBeNull();
  });

  it('returns null for out-of-range', () => {
    expect(validatePort('0')).toBeNull();
    expect(validatePort('65536')).toBeNull();
    expect(validatePort('-1')).toBeNull();
  });

  it('returns null for float', () => {
    expect(validatePort('8.5')).toBeNull();
  });

  it('returns null for trailing non-digits', () => {
    expect(validatePort('123abc')).toBeNull();
  });
});

describe('scanSubnet', () => {
  it('finds a server at one IP', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('192.168.1.42')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'ok', hostname: 'mydev', mode: 'headless', version: '0.2.0' }),
        });
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const found: any[] = [];
    const progress: number[] = [];

    const result = await scanSubnet('192.168.1', 8765, new AbortController().signal, {
      onProgress: (p) => progress.push(p),
      onFound: (servers) => found.push(...servers),
    });

    expect(result.aborted).toBe(false);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toEqual({
      ip: '192.168.1.42',
      port: 8765,
      hostname: 'mydev',
      mode: 'headless',
      version: '0.2.0',
    });
    expect(found).toHaveLength(1);
    expect(progress.length).toBeGreaterThan(0);
    // Progress should reach 1.0
    expect(progress[progress.length - 1]).toBeCloseTo(1.0, 1);
  });

  it('returns empty when no servers found', async () => {
    const result = await scanSubnet('10.0.0', 8765, new AbortController().signal, {
      onProgress: () => {},
      onFound: () => {},
    });

    expect(result.servers).toHaveLength(0);
    expect(result.aborted).toBe(false);
  });

  it('respects abort signal', async () => {
    const abort = new AbortController();
    let fetchCount = 0;

    mockFetch.mockImplementation(() => {
      fetchCount++;
      // Abort after first batch
      if (fetchCount >= 30) abort.abort();
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const result = await scanSubnet('192.168.1', 8765, abort.signal, {
      onProgress: () => {},
      onFound: () => {},
    });

    expect(result.aborted).toBe(true);
    // Should not have scanned all 254 IPs
    expect(fetchCount).toBeLessThan(254);
  });

  it('handles server with missing fields gracefully', async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
      if (url === 'http://192.168.1.1:8765/health') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'ok' }),
        });
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const result = await scanSubnet('192.168.1', 8765, new AbortController().signal, {
      onProgress: () => {},
      onFound: () => {},
    });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].hostname).toBe('192.168.1.1'); // fallback to IP
    expect(result.servers[0].mode).toBe('unknown');
    expect(result.servers[0].version).toBe('');
  });

  it('ignores non-ok status responses', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('192.168.1.5')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'error', message: 'not chroxy' }),
        });
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const result = await scanSubnet('192.168.1', 8765, new AbortController().signal, {
      onProgress: () => {},
      onFound: () => {},
    });

    expect(result.servers).toHaveLength(0);
  });

  it('ignores non-2xx HTTP responses', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('192.168.1.10')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ status: 'ok' }),
        });
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const result = await scanSubnet('192.168.1', 8765, new AbortController().signal, {
      onProgress: () => {},
      onFound: () => {},
    });

    expect(result.servers).toHaveLength(0);
  });

  it('calls onProgress incrementally', async () => {
    const progress: number[] = [];

    await scanSubnet('192.168.1', 8765, new AbortController().signal, {
      onProgress: (p) => progress.push(p),
      onFound: () => {},
    });

    // Should have multiple progress calls (254 / 30 = ~9 batches)
    expect(progress.length).toBeGreaterThanOrEqual(8);
    // Progress should be monotonically increasing
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThan(progress[i - 1]);
    }
  });
});
