import * as fs from 'fs';
import * as path from 'path';

describe('SessionPicker touch targets', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionPicker.tsx'),
    'utf-8',
  );

  it('addButton TouchableOpacity has hitSlop for 44pt touch target', () => {
    // Match addButton style ref up to hitSlop, but stop before followButton to avoid false match
    const addButtonSection = source.split('followButton')[0];
    expect(addButtonSection).toMatch(/addButton[\s\S]*?hitSlop/);
  });

  it('followButton TouchableOpacity has hitSlop for 44pt touch target', () => {
    // Match followButton style ref through to hitSlop
    const followButtonSection = source.slice(source.indexOf('followButton'));
    expect(followButtonSection).toMatch(/followButton[\s\S]*?hitSlop/);
  });
});
