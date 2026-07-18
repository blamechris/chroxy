/**
 * #6793 — per-fenced-code-block copy button (mobile).
 *
 * Mirrors `MarkdownRenderer.openURL.test.ts`'s harness conventions for this
 * file (`react-test-renderer` + `act` — `@testing-library/react-native` is
 * NOT installed in this repo, see `src/test-utils/test-helpers.ts`). Covers:
 * one button per fenced code block, each scoped to its own block's raw text
 * (not the whole message / not a sibling block), wired to the SAME
 * `expo-clipboard` API the multi-select transcript copy already uses
 * (`SessionScreen.tsx`'s `handleCopy`), and the transient "Copied" state.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import * as Clipboard from 'expo-clipboard';
import { FormattedResponse } from '../MarkdownRenderer';
import { flushMicrotasks } from '../../test-utils/test-helpers';

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve(true)),
}));

const mockSetStringAsync = Clipboard.setStringAsync as jest.Mock;

// A successful copy schedules a REAL 1500ms setTimeout (CODE_COPY_RESET_MS)
// to revert the "Copied" state. Several tests below press a button without
// advancing/asserting on that reset — unmounting after each test runs
// CodeCopyButton's cleanup effect (clearTimeout), so the timer never fires
// against a Jest environment that's already torn down (which otherwise spams
// "update not wrapped in act" / "import after teardown" noise).
let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(() => {
  if (activeTree) {
    act(() => activeTree!.unmount());
    activeTree = null;
  }
});

function renderResponse(content: string): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<FormattedResponse content={content} messageTextStyle={undefined} />);
  });
  activeTree = tree;
  return tree;
}

/**
 * `TouchableOpacity` forwards `testID` through several internal composition
 * layers (its own forwardRef alias, an `Animated.View`, nested host `View`s)
 * — `findAllByProps({ testID: ... })` matches EVERY one of those layers, not
 * one-per-logical-button (verified empirically: a single `CodeCopyButton`
 * yields 5 matches). Keep only the outermost match per subtree — the one
 * whose nearest identically-tagged ancestor doesn't exist — so the count
 * reflects actual rendered buttons, one per fenced code block.
 */
function copyButtons(root: ReactTestInstance): ReactTestInstance[] {
  const all = root.findAll((node) => node.props.testID === 'code-copy-button');
  return all.filter((node) => {
    let parent = node.parent;
    while (parent) {
      if (parent.props?.testID === 'code-copy-button') return false;
      parent = parent.parent;
    }
    return true;
  });
}

describe('MarkdownRenderer per-code-block copy button (#6793)', () => {
  beforeEach(() => {
    mockSetStringAsync.mockClear();
    mockSetStringAsync.mockResolvedValue(true);
  });

  it('renders one copy button per fenced code block', () => {
    const content = 'intro\n\n```js\nconst a = 1\n```\n\nmiddle\n\n```py\ndef b(): pass\n```';
    const tree = renderResponse(content);
    expect(copyButtons(tree.root)).toHaveLength(2);
  });

  it('renders a copy button even for a language-less fenced block', () => {
    const tree = renderResponse('```\nplain block\n```');
    expect(copyButtons(tree.root)).toHaveLength(1);
  });

  it('renders NO copy button when there is no fenced code block', () => {
    const tree = renderResponse('just some prose, no code here');
    expect(copyButtons(tree.root)).toHaveLength(0);
  });

  it('tapping a block\'s copy button copies via expo-clipboard.setStringAsync with ONLY that block\'s text', async () => {
    const content = 'before\n\n```js\nconst first = 1\n```\n\nbetween\n\n```js\nconst second = 2\n```';
    const tree = renderResponse(content);
    const buttons = copyButtons(tree.root);
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[1]!.props.onPress();
      await flushMicrotasks();
    });

    expect(mockSetStringAsync).toHaveBeenCalledTimes(1);
    expect(mockSetStringAsync).toHaveBeenCalledWith('const second = 2');
    // Never the whole markdown source, and never the OTHER block's text.
    expect(mockSetStringAsync).not.toHaveBeenCalledWith(content);
    expect(mockSetStringAsync).not.toHaveBeenCalledWith('const first = 1');
  });

  it('tapping the first block\'s button does not copy the second block\'s text', async () => {
    const content = '```\nblock one\n```\n\n```\nblock two\n```';
    const tree = renderResponse(content);
    const buttons = copyButtons(tree.root);

    await act(async () => {
      buttons[0]!.props.onPress();
      await flushMicrotasks();
    });

    expect(mockSetStringAsync).toHaveBeenCalledWith('block one');
    expect(mockSetStringAsync).not.toHaveBeenCalledWith('block two');
  });

  it('shows a transient "Copied" accessibility state after a successful copy, then reverts', async () => {
    jest.useFakeTimers();
    try {
      const tree = renderResponse('```\nconst x = 1\n```');
      const button = copyButtons(tree.root)[0]!;
      expect(button.props.accessibilityLabel).toBe('Copy code');

      await act(async () => {
        button.props.onPress();
        await flushMicrotasks();
      });
      expect(copyButtons(tree.root)[0]!.props.accessibilityLabel).toBe('Copied');

      act(() => {
        jest.advanceTimersByTime(1500);
      });
      expect(copyButtons(tree.root)[0]!.props.accessibilityLabel).toBe('Copy code');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not show "Copied" when the clipboard write rejects', async () => {
    mockSetStringAsync.mockRejectedValueOnce(new Error('clipboard unavailable'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const tree = renderResponse('```\nconst x = 1\n```');
    const button = copyButtons(tree.root)[0]!;

    await act(async () => {
      button.props.onPress();
      await flushMicrotasks();
    });

    expect(copyButtons(tree.root)[0]!.props.accessibilityLabel).toBe('Copy code');
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
