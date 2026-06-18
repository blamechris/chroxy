import * as fs from 'fs';
import * as path from 'path';

describe('SessionPicker long-press alert title — provider suffix (#3937)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionPicker.tsx'),
    'utf-8',
  );

  // Slice the providerLabel computation through the Alert.alert title arg so
  // the assertions below verify the suffix is wired into the user-visible
  // alert title, not just present somewhere in the file.
  const labelIdx = source.indexOf('const providerLabel');
  const alertTitleEndIdx = source.indexOf('+ providerLabel,', labelIdx);
  if (labelIdx < 0 || alertTitleEndIdx < 0 || alertTitleEndIdx <= labelIdx) {
    throw new Error(
      'Unable to locate the providerLabel + Alert.alert title section in SessionPicker.tsx',
    );
  }
  const alertTitleSection = source.slice(labelIdx, alertTitleEndIdx + '+ providerLabel,'.length);

  it('uses getProviderInfo for the alert-title suffix, not a hardcoded provider check', () => {
    expect(alertTitleSection).toMatch(/getProviderInfo\(session\.provider\)\.short/);
    // The pre-fix `session.provider === 'claude-cli' ? ' (CLI)' : ''` pattern
    // would only suffix one provider id; lock it out so a future regression
    // can't quietly drop claude-tui (or the next new provider) from the title.
    expect(alertTitleSection).not.toMatch(/session\.provider\s*===\s*['"]claude-cli['"]/);
  });

  it("only suffixes when the session's provider is not the default", () => {
    // Keyed on the shared DEFAULT_PROVIDER constant (#5823), not a hardcoded
    // 'claude-sdk', so a default flip can't reintroduce the stale-literal drift.
    expect(alertTitleSection).toMatch(/session\.provider\s*&&\s*session\.provider\s*!==\s*DEFAULT_PROVIDER/);
  });

  it('feeds the computed providerLabel into the Alert.alert title argument', () => {
    // Behavioural lock: the providerLabel must be concatenated into the
    // first Alert.alert argument (the title), otherwise a future refactor
    // could compute the suffix and never use it in the title.
    expect(alertTitleSection).toMatch(/Alert\.alert\(\s*session\.name\s*\+\s*providerLabel,/);
  });

  it('imports getProviderInfo from the shared providers helper', () => {
    expect(source).toMatch(/import\s*\{[^}]*getProviderInfo[^}]*\}\s*from\s*['"]\.\.\/constants\/providers['"]/);
  });
});
