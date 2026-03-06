import * as fs from 'fs';
import * as path from 'path';

describe('SessionPicker touch targets', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionPicker.tsx'),
    'utf-8',
  );

  it('addButton TouchableOpacity has hitSlop for 44pt touch target', () => {
    // The addButton's TouchableOpacity should have hitSlop to expand its 32pt visual size to 44pt
    expect(source).toMatch(/addButton[\s\S]*?hitSlop/);
  });

  it('followButton TouchableOpacity has hitSlop for 44pt touch target', () => {
    // The followButton's TouchableOpacity should have hitSlop to expand its 32pt visual size to 44pt
    expect(source).toMatch(/followButton[\s\S]*?hitSlop/);
  });
});
