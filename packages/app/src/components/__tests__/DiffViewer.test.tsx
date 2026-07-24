/**
 * Render/interaction tests for the mobile DiffViewer inline comments +
 * review triggers (#6800).
 *
 * react-test-renderer + act, Zustand store driven via setState (mirrors
 * CheckInChip.test.tsx). Covers: line comment affordance, adding a comment,
 * submitting queued comments (composed prompt via sendInput + modal closes),
 * and the one-click "Review code" trigger.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { DiffViewer } from '../DiffViewer';
import { useConnectionStore } from '../../store/connection';
import type { DiffFile, DiffResult } from '../../store/connection';

const FILES: DiffFile[] = [
  {
    path: 'src/utils/helper.ts',
    status: 'modified',
    additions: 5,
    deletions: 2,
    hunks: [
      {
        header: '@@ -10,6 +10,9 @@',
        lines: [
          { type: 'context', content: 'const x = 1' },
          { type: 'deletion', content: 'const y = 2' },
          { type: 'addition', content: 'const y = 3' },
          { type: 'addition', content: 'const z = 4' },
          { type: 'context', content: 'export { x }' },
        ],
      },
    ],
  },
];

describe('DiffViewer inline comments (#6800)', () => {
  let activeTree: renderer.ReactTestRenderer | null = null;
  const sendInputSpy = jest.fn((_input: string) => 'sent' as 'sent' | 'queued' | false);
  const requestDiffSpy = jest.fn();
  const onClose = jest.fn();
  let capturedCallback: ((r: DiffResult) => void) | null = null;

  function render() {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<DiffViewer visible onClose={onClose} />);
    });
    activeTree = tree;
    return tree;
  }

  function seedFiles(tree: renderer.ReactTestRenderer, files: DiffFile[] = FILES) {
    act(() => {
      capturedCallback?.({ files, error: null });
    });
    // Drill into the first file so the hunk lines render.
    const entry = tree.root.findByProps({ testID: `diff-file-${files[0]!.path}` });
    act(() => {
      entry.props.onPress?.();
    });
  }

  beforeEach(() => {
    sendInputSpy.mockClear();
    sendInputSpy.mockReturnValue('sent');
    requestDiffSpy.mockClear();
    onClose.mockClear();
    capturedCallback = null;
    useConnectionStore.setState({
      sendInput: sendInputSpy as any,
      requestDiff: requestDiffSpy as any,
      setDiffCallback: ((cb: any) => {
        capturedCallback = cb;
      }) as any,
    });
  });

  afterEach(() => {
    if (activeTree) {
      act(() => {
        activeTree!.unmount();
      });
      activeTree = null;
    }
  });

  it('requests the diff on open', () => {
    render();
    expect(requestDiffSpy).toHaveBeenCalled();
  });

  it('renders a comment affordance per diff line', () => {
    const tree = render();
    seedFiles(tree);
    // 5 lines → 5 tappable line targets.
    expect(tree.root.findAllByProps({ testID: 'diff-line-0' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'diff-line-4' }).length).toBeGreaterThan(0);
  });

  it('adds a comment and exposes the submit action', () => {
    const tree = render();
    seedFiles(tree);

    // Open editor on the deletion line (index 1).
    act(() => {
      tree.root.findByProps({ testID: 'diff-line-1' }).props.onPress?.();
    });
    act(() => {
      tree.root.findByProps({ testID: 'diff-comment-input' }).props.onChangeText?.('why remove?');
    });
    act(() => {
      tree.root.findByProps({ testID: 'diff-comment-save' }).props.onPress?.();
    });

    // Submit control now present.
    expect(tree.root.findAllByProps({ testID: 'diff-submit-comments' }).length).toBeGreaterThan(0);
  });

  it('submits queued comments as a composed prompt via sendInput and closes', () => {
    const tree = render();
    seedFiles(tree);

    act(() => {
      tree.root.findByProps({ testID: 'diff-line-2' }).props.onPress?.(); // addition `const y = 3`
    });
    act(() => {
      tree.root.findByProps({ testID: 'diff-comment-input' }).props.onChangeText?.('use a const enum');
    });
    act(() => {
      tree.root.findByProps({ testID: 'diff-comment-save' }).props.onPress?.();
    });
    act(() => {
      tree.root.findByProps({ testID: 'diff-submit-comments' }).props.onPress?.();
    });

    expect(sendInputSpy).toHaveBeenCalledTimes(1);
    const prompt = sendInputSpy.mock.calls[0]![0] as unknown as string;
    expect(prompt).toContain('review comment');
    expect(prompt).toContain('src/utils/helper.ts:');
    expect(prompt).toContain('use a const enum');
    expect(prompt).toContain('Line 11'); // derived new-file line number
    expect(onClose).toHaveBeenCalled();
  });

  it('triggers a one-click review over the whole diff via sendInput', () => {
    const tree = render();
    seedFiles(tree);

    act(() => {
      tree.root.findByProps({ testID: 'diff-review-code' }).props.onPress?.();
    });

    expect(sendInputSpy).toHaveBeenCalledTimes(1);
    const prompt = sendInputSpy.mock.calls[0]![0] as unknown as string;
    expect(prompt).toContain('review the current uncommitted changes');
    expect(prompt).toContain('src/utils/helper.ts');
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps queued comments when the send fails (#6946)', () => {
    const tree = render();
    seedFiles(tree);

    act(() => {
      tree.root.findByProps({ testID: 'diff-line-0' }).props.onPress?.();
    });
    act(() => {
      tree.root.findByProps({ testID: 'diff-comment-input' }).props.onChangeText?.('note');
    });
    act(() => {
      tree.root.findByProps({ testID: 'diff-comment-save' }).props.onPress?.();
    });
    expect(tree.root.findAllByProps({ testID: 'diff-submit-comments' }).length).toBeGreaterThan(0);

    sendInputSpy.mockReturnValue(false as any);
    act(() => {
      tree.root.findByProps({ testID: 'diff-submit-comments' }).props.onPress?.();
    });

    // A dropped send (falsy `sendInput` result, mirroring the
    // wssend_false_sideeffect_callsites convention) must preserve the queue
    // and leave the modal open — not silently discard the pending comment.
    expect(sendInputSpy).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(tree.root.findAllByProps({ testID: 'diff-submit-comments' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'diff-comment-note-0' }).length).toBeGreaterThan(0);
  });

  it('removes a queued comment', () => {
    const tree = render();
    seedFiles(tree);

    act(() => {
      tree.root.findByProps({ testID: 'diff-line-0' }).props.onPress?.();
    });
    act(() => {
      tree.root.findByProps({ testID: 'diff-comment-input' }).props.onChangeText?.('note');
    });
    act(() => {
      tree.root.findByProps({ testID: 'diff-comment-save' }).props.onPress?.();
    });
    expect(tree.root.findAllByProps({ testID: 'diff-submit-comments' }).length).toBeGreaterThan(0);

    act(() => {
      tree.root.findByProps({ testID: 'diff-comment-remove-0' }).props.onPress?.();
    });
    expect(tree.root.findAllByProps({ testID: 'diff-submit-comments' }).length).toBe(0);
  });
});
