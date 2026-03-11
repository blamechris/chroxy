import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/App.tsx'),
  'utf-8',
);

describe('SessionScreenWithBoundary typed props (#1914)', () => {
  test('does not use untyped any for props', () => {
    expect(src).not.toMatch(/SessionScreenWithBoundary\(props:\s*any\)/);
  });

  test('uses NativeStackScreenProps type for props', () => {
    expect(src).toMatch(/NativeStackScreenProps/);
    expect(src).toMatch(/SessionScreenWithBoundary\(props:/);
  });
});
