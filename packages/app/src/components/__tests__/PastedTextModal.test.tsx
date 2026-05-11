/**
 * PastedTextModal tests (mobile, #3797 / #3798 review).
 *
 * Renders the modal under various visibility / content scenarios and
 * exercises the close + remove handlers. Mirrors the dashboard's
 * PastedTextModal.test.tsx coverage so both clients enforce the same
 * UX contract.
 */
import React from 'react';
import { act } from 'react';
import renderer from 'react-test-renderer';
import { PastedTextModal } from '../PastedTextModal';

describe('PastedTextModal (mobile)', () => {
  const baseProps = {
    visible: true,
    id: 7,
    content: 'line one\nline two\nline three',
    onClose: jest.fn(),
    onRemove: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when id is null', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(
        <PastedTextModal {...baseProps} id={null} />
      );
    });
    expect(component!.toJSON()).toBeNull();
  });

  it('renders the full content', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(<PastedTextModal {...baseProps} />);
    });
    const tree = component!.toJSON();
    const json = JSON.stringify(tree);
    expect(json).toContain('line one');
    expect(json).toContain('line two');
    expect(json).toContain('line three');
  });

  it('renders the header with line count and char count', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(<PastedTextModal {...baseProps} />);
    });
    const json = JSON.stringify(component!.toJSON());
    expect(json).toContain('Pasted text #7');
    expect(json).toContain('3 lines');
    expect(json).toContain('28 chars');
  });

  it('uses singular "1 line" for single-line pastes', () => {
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(<PastedTextModal {...baseProps} content="single line" />);
    });
    const json = JSON.stringify(component!.toJSON());
    expect(json).toContain('1 line');
    expect(json).not.toContain('1 lines');
  });

  it('calls onClose when the close button is pressed', () => {
    const onClose = jest.fn();
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(<PastedTextModal {...baseProps} onClose={onClose} />);
    });
    const closeBtn = component!.root.findByProps({ testID: 'pasted-text-modal-close' });
    act(() => {
      closeBtn.props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when the backdrop is pressed', () => {
    const onClose = jest.fn();
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(<PastedTextModal {...baseProps} onClose={onClose} />);
    });
    const backdrop = component!.root.findByProps({ testID: 'pasted-text-modal-backdrop' });
    act(() => {
      backdrop.props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onRemove(id) and onClose when "Remove paste" is pressed', () => {
    const onClose = jest.fn();
    const onRemove = jest.fn();
    let component: renderer.ReactTestRenderer;
    act(() => {
      component = renderer.create(<PastedTextModal {...baseProps} onClose={onClose} onRemove={onRemove} />);
    });
    const removeBtn = component!.root.findByProps({ testID: 'pasted-text-modal-remove' });
    act(() => {
      removeBtn.props.onPress();
    });
    expect(onRemove).toHaveBeenCalledWith(7);
    expect(onClose).toHaveBeenCalled();
  });
});
