import { deriveSessionTitle, abbreviateSessionCwd } from '../../utils/sessionTitle';

// #8181 — the nav header (App.tsx's `sessionTitle` selector) took the last
// two path segments of `session.cwd` and ignored `repoCwd`, so a
// worktree-isolated session's header read `worktrees/<hex>` instead of the
// repo name. The server already sends `repoCwd` on every `session_list`
// entry (`SessionInfo.repoCwd` in `@chroxy/store-core`); `deriveSessionTitle`
// now prefers it, mirroring the dashboard's `repoDisplayName` fix (#7328 /
// #8123).
describe('deriveSessionTitle', () => {
  it('a worktree session shows the repo name, not the worktree hex segment', () => {
    const session = {
      cwd: '/Users/blamechris/.chroxy/worktrees/34914672f8578ecdf71accf8f8aec47e',
      repoCwd: '/Users/blamechris/Projects/chroxy',
    };
    expect(deriveSessionTitle(session)).toBe('chroxy');
    expect(deriveSessionTitle(session)).not.toBe('worktrees/34914672f8578ecdf71accf8f8aec47e');
  });

  // Positive control: a normal (non-worktree) session is unchanged.
  it('positive control: a normal session without repoCwd keeps the last-two-segments title', () => {
    const session = {
      cwd: '/Users/blamechris/Projects/chroxy',
      repoCwd: null,
    };
    expect(deriveSessionTitle(session)).toBe('~/Projects/chroxy'.split('/').slice(-2).join('/'));
    // Explicit expected value (same derivation, written out for clarity):
    expect(deriveSessionTitle(session)).toBe('Projects/chroxy');
  });

  // Positive control: a session without a repoCwd field at all (old server,
  // pre-#7328) falls back to the pre-#8181 behaviour too.
  it('positive control: a session without a repoCwd field falls back to the cwd-based title', () => {
    const session = { cwd: '/Users/blamechris/Projects/chroxy' };
    expect(deriveSessionTitle(session)).toBe('Projects/chroxy');
  });

  it('falls back to the cwd-based title when repoCwd is an empty string', () => {
    const session = { cwd: '/Users/blamechris/Projects/chroxy', repoCwd: '' };
    expect(deriveSessionTitle(session)).toBe('Projects/chroxy');
  });

  it('shortens /Users/<name> to ~ for a short (<=2 segment) non-worktree cwd', () => {
    const session = { cwd: '/Users/blamechris', repoCwd: null };
    expect(deriveSessionTitle(session)).toBe('~');
  });

  it('returns "Session" when there is no active session', () => {
    expect(deriveSessionTitle(null)).toBe('Session');
    expect(deriveSessionTitle(undefined)).toBe('Session');
  });

  it('returns "Session" when the session has no cwd yet', () => {
    expect(deriveSessionTitle({ cwd: undefined, repoCwd: '/Users/blamechris/Projects/chroxy' })).toBe('Session');
    expect(deriveSessionTitle({ cwd: '', repoCwd: '/Users/blamechris/Projects/chroxy' })).toBe('Session');
  });
});

describe('abbreviateSessionCwd', () => {
  it('shortens /Users/<name> and takes the last two path segments', () => {
    expect(abbreviateSessionCwd('/Users/blamechris/Projects/chroxy')).toBe('Projects/chroxy');
  });

  it('returns the shortened path as-is when it has 2 or fewer segments', () => {
    expect(abbreviateSessionCwd('/Users/blamechris')).toBe('~');
  });
});
