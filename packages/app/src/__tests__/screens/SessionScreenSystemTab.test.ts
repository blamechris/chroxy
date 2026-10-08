/**
 * #8461 -- SessionScreen derives the System tab (and its unread badge, which
 * counts the same list) through `selectSystemMessages`, so a turn-outcome chip
 * stays in the chat. SessionScreen is not rendered in this repo's tests (no
 * @testing-library/react-native; same source-text gate as
 * SessionScreenStoppedBanner.test.ts), so the wiring is pinned on the source and
 * the selector's behaviour by selectChatMessages.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../../screens/SessionScreen.tsx'), 'utf-8');

describe('SessionScreen System tab selection (#8461)', () => {
  it('builds systemMessages with selectSystemMessages', () => {
    expect(/const systemMessages = useMemo\(\s*\(\) => selectSystemMessages\(allMessages\)/.test(src)).toBe(true);
    expect(/import \{[^}]*\bselectSystemMessages\b[^}]*\} from '\.\/selectChatMessages'/.test(src)).toBe(true);
  });

  it('has no inline `type === \'system\'` filter left to bypass it', () => {
    expect(/\.filter\(\(?\s*m\s*\)?\s*=>\s*m\.type\s*===\s*['"]system['"]\s*\)/.test(src)).toBe(false);
  });

  it('feeds the same list to the view and to the unread count', () => {
    expect(/viewMode === 'system' \? systemMessages : chatMessages/.test(src)).toBe(true);
    expect(/systemMessages\.length - lastSeenForSession/.test(src)).toBe(true);
  });
});
