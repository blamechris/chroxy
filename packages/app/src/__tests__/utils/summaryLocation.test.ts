import { deriveSummaryLocation } from '../../utils/sessionTitle';

describe('deriveSummaryLocation (#8238)', () => {
  it('uses the repo name for a worktree session, not the opaque checkout', () => {
    expect(
      deriveSummaryLocation({
        cwd: '/Users/me/.chroxy/worktrees/34914672f8578ecdf71accf8f8aec47e',
        repoCwd: '/Users/me/Projects/chroxy',
      }, '/srv/default'),
    ).toBe('chroxy');
  });
  it('shortens a plain session cwd at a path boundary', () => {
    expect(deriveSummaryLocation({ cwd: '/Users/me/Projects/chroxy', repoCwd: null }, '/srv/default'))
      .toBe('Projects/chroxy');
  });
  it('never cuts mid-segment', () => {
    const out = deriveSummaryLocation({ cwd: '/Users/me/a/4e3ea80d0123456789abcdef/scratchpad/smoke-repo' });
    expect(out).toBe('scratchpad/smoke-repo');
  });
  it('ignores the server default cwd when a session is active', () => {
    expect(deriveSummaryLocation({ cwd: '/Users/me/x/proj' }, '/srv/default')).toBe('x/proj');
  });
  it('falls back to the default cwd with no session, and null with nothing', () => {
    expect(deriveSummaryLocation(null, '/srv/default/app')).toBe('default/app');
    expect(deriveSummaryLocation(null, null)).toBeNull();
  });
});
