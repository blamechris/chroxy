import * as fs from 'fs';
import * as path from 'path';

describe('SessionPicker long-press alert title — provider suffix (#3937)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionPicker.tsx'),
    'utf-8',
  );

  it('uses getProviderInfo for the alert-title suffix, not a hardcoded provider check', () => {
    expect(source).toMatch(/getProviderInfo\(session\.provider\)\.short/);
    // The pre-fix `session.provider === 'claude-cli' ? ' (CLI)' : ''` pattern
    // would only suffix one provider id; lock it out so a future regression
    // can't quietly drop claude-tui (or the next new provider) from the title.
    expect(source).not.toMatch(/session\.provider\s*===\s*['"]claude-cli['"]/);
  });

  it("only suffixes when the session's provider is not the claude-sdk default", () => {
    expect(source).toMatch(/session\.provider\s*&&\s*session\.provider\s*!==\s*['"]claude-sdk['"]/);
  });

  it('imports getProviderInfo from the shared providers helper', () => {
    expect(source).toMatch(/import\s*\{[^}]*getProviderInfo[^}]*\}\s*from\s*['"]\.\.\/constants\/providers['"]/);
  });
});
