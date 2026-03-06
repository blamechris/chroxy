import * as fs from 'fs';
import * as path from 'path';

describe('SessionPicker follow button accessibility', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionPicker.tsx'),
    'utf-8',
  );

  // Extract the followButton TouchableOpacity section with validation
  const followButtonIdx = source.indexOf('styles.followButton');
  const followButtonEndIdx = source.indexOf('</TouchableOpacity>', followButtonIdx);
  if (followButtonIdx < 0 || followButtonEndIdx < 0 || followButtonEndIdx <= followButtonIdx) {
    throw new Error(
      'Unable to locate a valid follow button <TouchableOpacity> section in SessionPicker.tsx',
    );
  }
  const followButtonSection = source.slice(followButtonIdx, followButtonEndIdx);

  it('has accessibilityLabel "Toggle follow mode" on follow button', () => {
    expect(followButtonSection).toMatch(/accessibilityLabel[^\n]*Toggle follow mode/);
  });

  it('has accessibilityRole "switch" on follow button', () => {
    expect(followButtonSection).toMatch(/accessibilityRole[^\n]*['"]switch['"]/);
  });

  it('has accessibilityState using checked: followMode', () => {
    expect(followButtonSection).toMatch(/accessibilityState[^\n]*checked\s*:\s*followMode/);
  });
});
