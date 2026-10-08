/**
 * #8446 — the mobile pre-write review sends WHICH hunks were dropped, never text.
 * The diff it draws is over the redacted tool input, so any text built from it
 * would carry `[REDACTED]` where a secret was; the server rebuilds the narrowed
 * content from the raw input and these ranges. Mirrors the dashboard's
 * `PreWriteDiffReview.test.tsx`.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { PreWriteDiffReview } from '../../components/PreWriteDiffReview';

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(el);
  });
  return root;
}

describe('PreWriteDiffReview emits drop decisions (#8446)', () => {
  it('Edit: dropping the only hunk emits its range and no text', () => {
    const onChange = jest.fn();
    const root = render(
      <PreWriteDiffReview
        tool="Edit"
        input={{ old_string: 'a\nkey = [REDACTED]\nc', new_string: 'a\nkey = [REDACTED]\nC' }}
        onEditedInputChange={onChange}
      />,
    );
    const toggle = root.root.findByProps({ testID: 'hunk-toggle' });
    act(() => {
      toggle.props.onPress();
    });
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(last).toEqual({ droppedHunks: [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 }], keptHunks: [] });
    expect(JSON.stringify(last).includes('REDACTED')).toBe(false);
  });

  it('emits null again once every hunk is kept (a plain Allow)', () => {
    const onChange = jest.fn();
    const root = render(
      <PreWriteDiffReview tool="Edit" input={{ old_string: 'a\nb', new_string: 'a\nB' }} onEditedInputChange={onChange} />,
    );
    const toggle = root.root.findByProps({ testID: 'hunk-toggle' });
    act(() => {
      toggle.props.onPress();
    });
    act(() => {
      toggle.props.onPress();
    });
    expect(onChange.mock.calls[onChange.mock.calls.length - 1]![0]).toBeNull();
  });
});
