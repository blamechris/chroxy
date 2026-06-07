import { parseChroxyUrl } from '../screens/ConnectScreen';

describe('parseChroxyUrl (#1852)', () => {
  it('parses valid chroxy:// URL with token (legacy)', () => {
    const result = parseChroxyUrl('chroxy://example.com?token=abc123');
    expect(result).toEqual({ ok: true, wsUrl: 'wss://example.com', token: 'abc123' });
  });

  it('parses chroxy:// URL with pairing ID', () => {
    const result = parseChroxyUrl('chroxy://example.com?pair=abcdef123456');
    expect(result).toEqual({ ok: true, wsUrl: 'wss://example.com', pairingId: 'abcdef123456' });
  });

  it('pairing URL does not expose token', () => {
    const result = parseChroxyUrl('chroxy://example.com?pair=xyz');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result).not.toHaveProperty('token');
      expect((result as { pairingId: string }).pairingId).toBe('xyz');
    }
  });

  it('parses wss:// URL without token', () => {
    const result = parseChroxyUrl('wss://example.com');
    expect(result).toEqual({ ok: true, wsUrl: 'wss://example.com', token: '' });
  });

  it('returns not_chroxy for random text', () => {
    const result = parseChroxyUrl('https://google.com');
    expect(result).toEqual({ ok: false, reason: 'not_chroxy' });
  });

  it('returns not_chroxy for empty string', () => {
    const result = parseChroxyUrl('');
    expect(result).toEqual({ ok: false, reason: 'not_chroxy' });
  });

  it('returns missing_token for chroxy URL without token or pair', () => {
    const result = parseChroxyUrl('chroxy://example.com');
    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('trims whitespace', () => {
    const result = parseChroxyUrl('  chroxy://example.com?token=xyz  ');
    expect(result).toEqual({ ok: true, wsUrl: 'wss://example.com', token: 'xyz' });
  });

  it('trims whitespace on pairing URL', () => {
    const result = parseChroxyUrl('  chroxy://example.com?pair=abc  ');
    expect(result).toEqual({ ok: true, wsUrl: 'wss://example.com', pairingId: 'abc' });
  });

  // #5298 — chroxy:// scheme inference: a LAN daemon's URL has an explicit
  // port and serves plain ws://; a tunnel URL has no port and is wss:// on 443.
  describe('LAN vs tunnel scheme inference (#5298)', () => {
    it('LAN pairing URL (explicit port) connects over ws://', () => {
      const result = parseChroxyUrl('chroxy://192.168.1.5:8765?pair=abc123');
      expect(result).toEqual({ ok: true, wsUrl: 'ws://192.168.1.5:8765', pairingId: 'abc123' });
    });

    it('LAN token URL (explicit port) connects over ws://', () => {
      const result = parseChroxyUrl('chroxy://192.168.1.5:8765?token=tok');
      expect(result).toEqual({ ok: true, wsUrl: 'ws://192.168.1.5:8765', token: 'tok' });
    });

    it('tunnel pairing URL (no port) stays wss://', () => {
      const result = parseChroxyUrl('chroxy://abc.trycloudflare.com?pair=xyz');
      expect(result).toEqual({ ok: true, wsUrl: 'wss://abc.trycloudflare.com', pairingId: 'xyz' });
    });

    it('IPv6 LAN URL (explicit port) keeps brackets and uses ws://', () => {
      const result = parseChroxyUrl('chroxy://[fd00::1]:8765?pair=abc');
      expect(result).toEqual({ ok: true, wsUrl: 'ws://[fd00::1]:8765', pairingId: 'abc' });
    });

    it('directly-entered ws:// keeps its scheme', () => {
      const result = parseChroxyUrl('ws://192.168.1.5:8765');
      expect(result).toEqual({ ok: true, wsUrl: 'ws://192.168.1.5:8765', token: '' });
    });

    it('explicit :443 is the https default port and stays wss:// (no port in host)', () => {
      // `new URL` strips the default https port, so `parsed.port` is empty —
      // a tunnel on 443 still infers wss, even written with an explicit :443.
      const result = parseChroxyUrl('chroxy://abc.trycloudflare.com:443?pair=xyz');
      expect(result).toEqual({ ok: true, wsUrl: 'wss://abc.trycloudflare.com', pairingId: 'xyz' });
    });
  });
});
