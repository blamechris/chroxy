import type { SavedConnection } from '@chroxy/store-core';
import {
  deriveTunnelUrl,
  isLanWsUrl,
  recordVerifiedLanCandidate,
  selectConnectEndpoint,
} from '../../utils/endpoint-selector';
import * as lanScanner from '../../utils/lan-scanner';

jest.mock('../../utils/lan-scanner', () => ({
  probeHealth: jest.fn(),
}));

const probeHealth = lanScanner.probeHealth as jest.MockedFunction<typeof lanScanner.probeHealth>;

const ok = { status: 'ok', mode: 'cli', version: '0.9.45' };

describe('isLanWsUrl', () => {
  it('treats plaintext ws:// as a LAN (non-TLS) endpoint', () => {
    expect(isLanWsUrl('ws://192.168.1.5:8765')).toBe(true);
    expect(isLanWsUrl('ws://10.0.0.2:8765/ws')).toBe(true);
  });
  it('treats wss:// (tunnel/TLS) as not-LAN', () => {
    expect(isLanWsUrl('wss://abc.trycloudflare.com')).toBe(false);
  });
  it('is case-insensitive and tolerant of nullish input', () => {
    expect(isLanWsUrl('WS://192.168.1.5:8765')).toBe(true);
    expect(isLanWsUrl(undefined)).toBe(false);
    expect(isLanWsUrl(null)).toBe(false);
  });
});

describe('deriveTunnelUrl', () => {
  it('prefers an explicit tunnelUrl', () => {
    expect(deriveTunnelUrl({ url: 'ws://192.168.1.5:8765', token: 't', tunnelUrl: 'wss://x.com' }))
      .toBe('wss://x.com');
  });
  it('falls back to url when no tunnelUrl is stored', () => {
    expect(deriveTunnelUrl({ url: 'wss://x.com', token: 't' })).toBe('wss://x.com');
  });
  it('does NOT treat a bare ws:// url as a tunnel fallback', () => {
    // A LAN-only record has no usable tunnel; selection must not invent a wss URL.
    expect(deriveTunnelUrl({ url: 'ws://192.168.1.5:8765', token: 't' })).toBeNull();
  });
});

describe('recordVerifiedLanCandidate', () => {
  it('marks a ws:// url as the verified LAN candidate, preserving the tunnel url', () => {
    const saved: SavedConnection = { url: 'wss://x.com', token: 't', tunnelUrl: 'wss://x.com' };
    const next = recordVerifiedLanCandidate(saved, 'ws://192.168.1.5:8765', 't');
    expect(next.lanUrl).toBe('ws://192.168.1.5:8765');
    expect(next.lanVerified).toBe(true);
    expect(next.tunnelUrl).toBe('wss://x.com');
    expect(next.token).toBe('t');
  });

  it('does NOT mark a wss:// (tunnel) url as a LAN candidate', () => {
    const saved: SavedConnection = { url: 'wss://x.com', token: 't' };
    const next = recordVerifiedLanCandidate(saved, 'wss://x.com', 't');
    expect(next.lanUrl).toBeUndefined();
    expect(next.lanVerified).toBeFalsy();
  });

  it('clears a stale verified LAN candidate when the token changes', () => {
    const saved: SavedConnection = {
      url: 'wss://x.com', token: 'old', tunnelUrl: 'wss://x.com',
      lanUrl: 'ws://192.168.1.5:8765', lanVerified: true,
    };
    // Re-verify the tunnel with a NEW token — the old LAN verification no longer applies.
    const next = recordVerifiedLanCandidate(saved, 'wss://x.com', 'new');
    expect(next.lanVerified).toBeFalsy();
    expect(next.lanUrl).toBeUndefined();
  });
});

describe('selectConnectEndpoint', () => {
  beforeEach(() => probeHealth.mockReset());

  it('prefers a verified LAN candidate that answers /health', async () => {
    probeHealth.mockResolvedValue(ok);
    const saved: SavedConnection = {
      url: 'wss://x.com', token: 't', tunnelUrl: 'wss://x.com',
      lanUrl: 'ws://192.168.1.5:8765', lanVerified: true,
    };
    const res = await selectConnectEndpoint(saved);
    expect(res).toEqual({ url: 'ws://192.168.1.5:8765', path: 'lan' });
    expect(probeHealth).toHaveBeenCalledWith('ws://192.168.1.5:8765', expect.any(Number));
  });

  it('falls back to the tunnel when the verified LAN candidate does not answer', async () => {
    probeHealth.mockResolvedValue(null); // LAN probe fails
    const saved: SavedConnection = {
      url: 'wss://x.com', token: 't', tunnelUrl: 'wss://x.com',
      lanUrl: 'ws://192.168.1.5:8765', lanVerified: true,
    };
    const res = await selectConnectEndpoint(saved);
    expect(res).toEqual({ url: 'wss://x.com', path: 'tunnel' });
  });

  it('NEVER probes/prefers an UNVERIFIED LAN candidate (hostile-box guard)', async () => {
    probeHealth.mockResolvedValue(ok); // even if a box answers, we must not use it
    const saved: SavedConnection = {
      url: 'wss://x.com', token: 't', tunnelUrl: 'wss://x.com',
      lanUrl: 'ws://192.168.1.5:8765', lanVerified: false,
    };
    const res = await selectConnectEndpoint(saved);
    expect(res).toEqual({ url: 'wss://x.com', path: 'tunnel' });
    expect(probeHealth).not.toHaveBeenCalled();
  });

  it('uses the tunnel when there is no LAN candidate at all', async () => {
    const saved: SavedConnection = { url: 'wss://x.com', token: 't' };
    const res = await selectConnectEndpoint(saved);
    expect(res).toEqual({ url: 'wss://x.com', path: 'tunnel' });
    expect(probeHealth).not.toHaveBeenCalled();
  });

  it('still uses a verified LAN candidate when no tunnel url exists (LAN-only record)', async () => {
    probeHealth.mockResolvedValue(ok);
    const saved: SavedConnection = {
      url: 'ws://192.168.1.5:8765', token: 't',
      lanUrl: 'ws://192.168.1.5:8765', lanVerified: true,
    };
    const res = await selectConnectEndpoint(saved);
    expect(res).toEqual({ url: 'ws://192.168.1.5:8765', path: 'lan' });
  });

  it('falls back to url when LAN-only record loses its LAN endpoint', async () => {
    probeHealth.mockResolvedValue(null);
    const saved: SavedConnection = {
      url: 'ws://192.168.1.5:8765', token: 't',
      lanUrl: 'ws://192.168.1.5:8765', lanVerified: true,
    };
    // No tunnel to fall back to — return the record's url so the normal
    // connect() health-check + retry path can surface the failure.
    const res = await selectConnectEndpoint(saved);
    expect(res).toEqual({ url: 'ws://192.168.1.5:8765', path: 'tunnel' });
  });

  it('respects an explicit preferTunnel override (manual / off-network)', async () => {
    const saved: SavedConnection = {
      url: 'wss://x.com', token: 't', tunnelUrl: 'wss://x.com',
      lanUrl: 'ws://192.168.1.5:8765', lanVerified: true,
    };
    const res = await selectConnectEndpoint(saved, { preferTunnel: true });
    expect(res).toEqual({ url: 'wss://x.com', path: 'tunnel' });
    expect(probeHealth).not.toHaveBeenCalled();
  });
});
