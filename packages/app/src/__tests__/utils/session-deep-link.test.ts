import { extractSessionIdFromDeepLink } from '../../utils/session-deep-link';

// #6792 — the iOS Live Activity's deepLinkUrl (and any future chroxy://
// deep-link source) carries the originating session id so a tap can route
// back to it via App.tsx's Linking listener.
describe('extractSessionIdFromDeepLink', () => {
  it('extracts the session id from a chroxy://open?session=<id> URL', () => {
    expect(extractSessionIdFromDeepLink('chroxy://open?session=sess-123')).toBe('sess-123');
  });

  it('returns null for a bare chroxy:// URL with no session param', () => {
    expect(extractSessionIdFromDeepLink('chroxy://open')).toBeNull();
    expect(extractSessionIdFromDeepLink('chroxy://')).toBeNull();
  });

  it('returns null for an empty or whitespace-only session param (contract: null on no id)', () => {
    expect(extractSessionIdFromDeepLink('chroxy://open?session=')).toBeNull();
    expect(extractSessionIdFromDeepLink('chroxy://open?session=%20%20')).toBeNull();
  });

  it('returns null for null/undefined/empty input', () => {
    expect(extractSessionIdFromDeepLink(null)).toBeNull();
    expect(extractSessionIdFromDeepLink(undefined)).toBeNull();
    expect(extractSessionIdFromDeepLink('')).toBeNull();
  });

  it('returns null for a non-chroxy URL', () => {
    expect(extractSessionIdFromDeepLink('https://example.com?session=sess-1')).toBeNull();
  });

  it('ignores the pairing flow\'s chroxy://host?pair=... / ?token=... URLs (no session param)', () => {
    expect(extractSessionIdFromDeepLink('chroxy://example.com?pair=abc123')).toBeNull();
    expect(extractSessionIdFromDeepLink('chroxy://example.com?token=xyz')).toBeNull();
  });

  it('decodes a URL-encoded session id', () => {
    expect(extractSessionIdFromDeepLink('chroxy://open?session=sess%20with%20space')).toBe('sess with space');
  });

  it('returns null for a malformed chroxy:// URL', () => {
    expect(extractSessionIdFromDeepLink('chroxy://[invalid')).toBeNull();
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(extractSessionIdFromDeepLink('  chroxy://open?session=sess-trim  ')).toBe('sess-trim');
  });
});
