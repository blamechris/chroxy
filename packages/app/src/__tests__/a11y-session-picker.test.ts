import { readFileSync } from 'fs';
import { join } from 'path';

describe('SessionPicker accessibility (#2014)', () => {
  const source = readFileSync(join(__dirname, '../components/SessionPicker.tsx'), 'utf-8');

  it('session pill has accessibilityHint for crashed state', () => {
    expect(source).toMatch(/accessibilityHint=.*crashed/);
  });

  it('session pill has accessibilityHint for busy state', () => {
    expect(source).toMatch(/accessibilityHint=.*processing/);
  });

  it('indicators view is hidden from accessibility tree', () => {
    expect(source).toContain('importantForAccessibility="no"');
    expect(source).toContain('accessibilityElementsHidden');
  });
});
