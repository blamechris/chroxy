/**
 * #8700 — SessionScreen feeds SettingsBar's read-only "Effort" readout.
 *
 * Like its sibling SessionScreen suites, this checks the wiring by source text
 * (SessionScreen cannot be rendered here); the readout's behaviour is pinned
 * against the real component in
 * `components/__tests__/SettingsBar.effectiveEffort.test.tsx`. Each assertion
 * collapses to a boolean first so a failure prints one line, not the whole file.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../../screens/SessionScreen.tsx'), 'utf-8');
const has = (re: RegExp) => re.test(src);

describe('SessionScreen effort readout wiring (#8700)', () => {
  it('reads the requested and the reported level off the active session state', () => {
    expect(has(/sessionStates\[id\]\.thinkingLevel\b/)).toBe(true);
    expect(has(/sessionStates\[id\]\.effectiveThinkingLevel\b/)).toBe(true);
  });

  it('derives the gate from the active provider capabilities through providerReportsEffort', () => {
    expect(has(/thinkingLevelEffectiveSupported:\s*providerReportsEffort\(caps\)/)).toBe(true);
    expect(has(/import \{[^}]*\bproviderReportsEffort\b[^}]*\} from '\.\.\/components\/SettingsBar'/)).toBe(true);
  });

  it('passes the capability and both levels to SettingsBar', () => {
    expect(has(/thinkingLevelEffectiveSupported=\{providerCaps\.thinkingLevelEffectiveSupported\}/)).toBe(true);
    expect(has(/thinkingLevel=\{activeThinkingLevel\}/)).toBe(true);
    expect(has(/effectiveThinkingLevel=\{activeEffectiveThinkingLevel\}/)).toBe(true);
  });
});
