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

  it("only renders the provider hint when the session's provider is not the claude-sdk default", () => {
    // Same gate as the long-press alert title from #3937 — gate on
    // "session.provider && session.provider !== 'claude-sdk'" so the
    // default SDK pill stays clean and only variant providers (claude-tui,
    // codex, gemini, docker-cli, ...) get a badge.
    expect(pillSection).toMatch(
      /session\.provider\s*&&\s*session\.provider\s*!==\s*['"]claude-sdk['"]/,
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
    // session.name Text was directly followed by the worktree-badge
    // conditional with no provider conditional in between. Lock that
    // exact pre-fix pattern out so a future regression can't quietly
    // drop the provider hint.
    expect(pillSection).not.toMatch(
      /\{session\.name\}\s*<\/Text>\s*\}\s*\{session\.worktree\s*&&/,
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
});
