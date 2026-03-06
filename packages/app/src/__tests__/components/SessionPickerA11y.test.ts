import * as fs from 'fs';
import * as path from 'path';

describe('SessionPicker follow button accessibility', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionPicker.tsx'),
    'utf-8',
  );

  // Extract the followButton TouchableOpacity section
  const followButtonIdx = source.indexOf('styles.followButton');
  const followButtonSection = source.slice(followButtonIdx, source.indexOf('</TouchableOpacity>', followButtonIdx));

  it('has accessibilityLabel on follow button', () => {
    expect(followButtonSection).toMatch(/accessibilityLabel/);
  });

  it('has accessibilityRole on follow button', () => {
    expect(followButtonSection).toMatch(/accessibilityRole/);
  });

  it('has accessibilityState for checked/unchecked', () => {
    expect(followButtonSection).toMatch(/accessibilityState/);
  });
});
