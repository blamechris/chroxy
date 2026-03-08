/**
 * ChatView auto-scroll behaviour tests (#1711)
 *
 * Uses static source analysis (consistent with existing app test patterns)
 * since the RN rendering environment is not available in unit tests.
 */
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../components/ChatView.tsx'),
  'utf-8',
);

describe('ChatView auto-scroll on permission prompt (#1711)', () => {
  it('tracks previous hasUnansweredPrompt with a useRef to detect new arrivals', () => {
    // Should have a ref tracking the previous value of hasUnansweredPrompt
    expect(source).toMatch(/useRef.*hasUnansweredPrompt|prevHasUnansweredPrompt.*useRef/);
  });

  it('has a useEffect that responds to hasUnansweredPrompt changes', () => {
    // Should have an effect with hasUnansweredPrompt in its dependency array
    expect(source).toMatch(/useEffect[\s\S]{0,300}hasUnansweredPrompt/);
  });

  it('calls scrollToEnd when a prompt newly appears', () => {
    // The effect must invoke scrollToEnd
    expect(source).toMatch(/scrollToEnd[\s\S]{0,50}animated.*true/);
  });
});
