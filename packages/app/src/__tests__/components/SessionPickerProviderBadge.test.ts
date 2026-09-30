import * as fs from 'fs';
import * as path from 'path';

describe('SessionPicker pill chip — provider hint badge (#3940)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionPicker.tsx'),
    'utf-8',
  );

  // Slice the SessionPill render block (function declaration through its
  // returned TouchableOpacity close) so the assertions below verify the
  // badge is wired into the pill chip itself, not just present somewhere
  // in the file.
  const pillStartIdx = source.indexOf('function SessionPill');
  const pillEndIdx = source.indexOf('interface SessionPickerProps', pillStartIdx);
  if (pillStartIdx < 0 || pillEndIdx < 0 || pillEndIdx <= pillStartIdx) {
    throw new Error(
      'Unable to locate the SessionPill render block in SessionPicker.tsx',
    );
  }
  const pillSection = source.slice(pillStartIdx, pillEndIdx);

  it('computes a providerInfo from getProviderInfo for the pill chip render', () => {
    expect(pillSection).toMatch(/getProviderInfo\(session\.provider\)/);
  });

  // #8130 — the badge used to suppress for the DEFAULT provider
  // (`session.provider !== DEFAULT_PROVIDER`), so a claude-tui session sat
  // with nothing beside it while a claude-cli session next to it showed
  // `CLI` — ambiguous in a mixed-provider setup. The gate is now removed so
  // EVERY session with a known provider shows a badge (matching the dashboard
  // Sidebar, fixed in #8129).
  it('renders the provider hint for every session with a known provider, including the default', () => {
    // The badge should render when session.provider is truthy (any known
    // provider). The DEFAULT_PROVIDER no longer suppresses it.
    expect(pillSection).toMatch(/session\.provider\s*\?/);
    // But should NOT match the old suppression pattern:
    expect(pillSection).not.toMatch(
      /session\.provider\s*&&\s*session\.provider\s*!==\s*DEFAULT_PROVIDER/,
    );
  });

  it('renders providerInfo.short inside a provider badge view in the pill chip', () => {
    // Behavioural lock: the providerInfo.short string must appear inside
    // the pill render output (not just be assigned to a variable and
    // dropped). Match the JSX text expression so a future refactor that
    // computes the badge text but never renders it gets caught.
    expect(pillSection).toMatch(/\{providerInfo\.short\}/);
    expect(pillSection).toMatch(/styles\.providerBadge/);
    expect(pillSection).toMatch(/styles\.providerBadgeText/);
  });

  it('keeps the pre-fix bare-name pill render gone (regression lock)', () => {
    // Before #3940 the pill text node was the only child between the
    // optional indicators and the optional worktreeBadge — i.e. the
    // session.name `<Text>` was directly followed by the worktree-badge
    // conditional with no provider conditional in between. Lock that
    // exact pre-fix pattern out so a future regression that drops the
    // provider hint cannot pass silently. The pre-fix JSX is
    //   {session.name}</Text>
    //   {session.worktree && (...)}
    // with no `}` between `</Text>` and `{session.worktree`, so the
    // regex must match those two tokens directly (only whitespace
    // between).
    expect(pillSection).not.toMatch(
      /\{session\.name\}\s*<\/Text>\s*\{session\.worktree\s*&&/,
    );
  });

  it('does not regress the numberOfLines={1} truncation on the session name Text', () => {
    // The session-name Text must keep numberOfLines={1} so long names
    // still truncate; the new provider badge is a sibling, not a wrapper.
    expect(pillSection).toMatch(
      /<Text\s+style=\{\[styles\.pillText[^>]*numberOfLines=\{1\}[^>]*>\s*\{session\.name\}/,
    );
  });

  it('reuses the getProviderInfo helper already imported from constants/providers', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*getProviderInfo[^}]*\}\s*from\s*['"]\.\.\/constants\/providers['"]/,
    );
  });

  // #8130 — the long-press alert title suffix also needs to show the
  // default provider badge, not suppress it. Same as the badge gate, the
  // alert suffix should appear for every session with a known provider.
  describe('long-press alert title suffix', () => {
    it('also includes the provider label for every session with a known provider (including default)', () => {
      // The alert suffix should render when session.provider is truthy, but
      // NOT suppress for DEFAULT_PROVIDER anymore.
      expect(source).toMatch(
        /const\s+providerLabel\s*=\s*session\.provider\s*\?/,
      );
      expect(source).not.toMatch(
        /session\.provider\s*&&\s*session\.provider\s*!==\s*DEFAULT_PROVIDER/,
      );
    });

    it('uses getProviderInfo(...).short for the alert suffix, same as the badge', () => {
      // The suffix should route through getProviderInfo for consistency with
      // the badge (and the dashboard).
      expect(source).toMatch(/getProviderInfo\(session\.provider\)\.short/);
    });
  });
});
