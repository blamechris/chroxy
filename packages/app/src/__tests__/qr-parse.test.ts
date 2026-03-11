import { parseChroxyUrl } from '../screens/ConnectScreen';

describe('parseChroxyUrl (#1852)', () => {
  it('parses valid chroxy:// URL', () => {
    const result = parseChroxyUrl('chroxy://example.com?token=abc123');
    expect(result).toEqual({ ok: true, wsUrl: 'wss://example.com', token: 'abc123' });
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

  it('returns missing_token for chroxy URL without token', () => {
    const result = parseChroxyUrl('chroxy://example.com');
    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('trims whitespace', () => {
    const result = parseChroxyUrl('  chroxy://example.com?token=xyz  ');
    expect(result).toEqual({ ok: true, wsUrl: 'wss://example.com', token: 'xyz' });
  });
});
