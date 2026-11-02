/**
 * #8236 — the chrome above the chat (tools row, search, settings bar, banners)
 * must live in a shrinkable ScrollView so a tall chrome can never push the
 * composer behind the keyboard. No RNTL for SessionScreen in this repo, so this
 * pins the structure via source text; assertions collapse to booleans so a
 * failure cannot dump the whole file (#7340).
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../../screens/SessionScreen.tsx'), 'utf-8');

const open = src.indexOf('testID="session-chrome-scroll"');
const regionStart = open === -1 ? -1 : src.lastIndexOf('<ScrollView', open);
const regionEnd = regionStart === -1 ? -1 : src.indexOf('</ScrollView>', open);
const region = regionStart === -1 || regionEnd === -1 ? '' : src.slice(regionStart, regionEnd);

describe('SessionScreen chrome scroll region (#8236)', () => {
  it('exists, wrapped in a single ScrollView', () => {
    expect(open !== -1 && regionStart !== -1 && regionEnd !== -1).toBe(true);
    // The region is sliced at the first `</ScrollView>`; a second ScrollView in
    // the file would truncate that slice and make the NOT-contains checks vacuous.
    expect((src.match(/<ScrollView\b/g) || []).length).toBe(1);
  });

  it('is shrinkable and does not grow (flexGrow 0, flexShrink 1)', () => {
    const style = /chromeScroll:\s*\{([^}]*)\}/.exec(src);
    expect(style !== null).toBe(true);
    const body = style ? style[1] : '';
    expect(/flexGrow:\s*0\b/.test(body)).toBe(true);
    expect(/flexShrink:\s*1\b/.test(body)).toBe(true);
    expect(/style=\{\[styles\.chromeScroll/.test(region)).toBe(true);
  });

  it('keeps banner buttons tappable with the keyboard up and nests scrolling', () => {
    expect(/keyboardShouldPersistTaps="handled"/.test(region)).toBe(true);
    expect(/\bnestedScrollEnabled\b/.test(region)).toBe(true);
  });

  it('contains the chrome (tools row, settings bar, web tasks)', () => {
    expect(region.includes('styles.secondaryToolsRow')).toBe(true);
    expect(region.includes('<SettingsBar')).toBe(true);
    expect(region.includes('<WebTasksPanel')).toBe(true);
  });

  it('does NOT contain the composer or the content area', () => {
    expect(region.includes('<InputBar')).toBe(false);
    expect(region.includes('<ChatView')).toBe(false);
    expect(region.includes('styles.splitContainer')).toBe(false);
  });

  it('does NOT contain the pinned primary navigation (picker, overview, mode toggle)', () => {
    expect(region.includes('styles.sessionPickerRow')).toBe(false);
    expect(region.includes('<SessionOverview')).toBe(false);
    expect(region.includes('terminal-mode-button')).toBe(false);
    expect(region.includes('accessibilityLabel="Files"')).toBe(false);
  });

  it('caps the region only through the pure helper, as maxHeight', () => {
    expect(/chromeMaxHeight\(\{/.test(src)).toBe(true);
    expect(/\{\s*maxHeight:\s*chromeCap\s*\}/.test(region)).toBe(true);
    expect(/minHeight/.test(region)).toBe(false);
  });

  it('feeds the helper the measured root container height', () => {
    // Without the measurement the helper sees 0 and never caps the region.
    expect(/<View\s+style=\{styles\.container\}\s+onLayout=\{\(e\) => setContainerHeight\(e\.nativeEvent\.layout\.height\)\}/.test(src)).toBe(true);
    expect(/chromeMaxHeight\(\{\s*containerHeight,\s*keyboardHeight,\s*bottomPadding\s*\}\)/.test(src)).toBe(true);
  });
});
