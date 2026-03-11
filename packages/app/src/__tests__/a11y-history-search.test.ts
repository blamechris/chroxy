import { readFileSync } from 'fs';
import { join } from 'path';

describe('HistoryScreen search accessibility (#2013)', () => {
  const source = readFileSync(join(__dirname, '../screens/HistoryScreen.tsx'), 'utf-8');

  it('search input has accessibilityRole="search"', () => {
    expect(source).toContain('accessibilityRole="search"');
  });

  it('search input has accessibilityHint for filtering', () => {
    expect(source).toMatch(/accessibilityHint=".*filter.*conversation/i);
  });

  it('clear button has accessibilityHint', () => {
    expect(source).toMatch(/accessibilityHint=".*[Cc]lear.*search/);
  });
});
