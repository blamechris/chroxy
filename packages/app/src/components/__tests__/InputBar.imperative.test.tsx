/**
 * Render tests for the mobile InputBar input-state ownership (#5556).
 *
 * InputBar now owns its composer draft internally and exposes an imperative
 * handle (focus/getValue/setValue/clear). This decouples typing from parent
 * streaming re-renders: the parent no longer holds the draft in render-scope
 * state, so message-delta re-renders don't churn the TextInput.
 *
 * Covers:
 *  - getValue/setValue/clear round-trips through the ref
 *  - user typing fires onChangeText(next, prev) and updates the draft
 *  - setValue is silent (does NOT fire onChangeText) — the property the
 *    voice-merge / paste-collapse / marker-strip paths rely on to avoid
 *    recursing back into the parent diff
 *  - React.memo: a parent re-render that leaves InputBar's props unchanged
 *    does NOT re-render InputBar (the typing/streaming decoupling)
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { InputBar, type InputBarHandle } from '../InputBar';

const noop = () => {};

const baseProps = {
  onSend: noop,
  onInterrupt: noop,
  onKeyPress: noop,
  onClearTerminal: noop,
  enterToSend: true,
  onToggleEnterMode: noop,
  isStreaming: false,
  claudeReady: true,
  viewMode: 'chat' as const,
  hasTerminal: false,
  bottomPadding: 0,
};

function getTextInput(tree: renderer.ReactTestRenderer): ReactTestInstance {
  return tree.root.findByProps({ testID: 'chat-message-input' });
}

describe('InputBar imperative draft ownership (#5556)', () => {
  it('round-trips draft via getValue/setValue/clear on the ref', () => {
    const ref = React.createRef<InputBarHandle>();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<InputBar ref={ref} {...baseProps} onChangeText={noop} />);
    });

    expect(ref.current?.getValue()).toBe('');

    act(() => { ref.current?.setValue('hello'); });
    expect(ref.current?.getValue()).toBe('hello');
    expect(getTextInput(tree).props.value).toBe('hello');

    act(() => { ref.current?.clear(); });
    expect(ref.current?.getValue()).toBe('');
    expect(getTextInput(tree).props.value).toBe('');
  });

  it('seeds the initial draft from the inputText prop', () => {
    const ref = React.createRef<InputBarHandle>();
    act(() => {
      renderer.create(<InputBar ref={ref} {...baseProps} inputText="seed" onChangeText={noop} />);
    });
    expect(ref.current?.getValue()).toBe('seed');
  });

  it('user typing fires onChangeText(next, prev) and updates the draft', () => {
    const ref = React.createRef<InputBarHandle>();
    const onChangeText = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<InputBar ref={ref} {...baseProps} onChangeText={onChangeText} />);
    });

    act(() => { getTextInput(tree).props.onChangeText('a'); });
    expect(onChangeText).toHaveBeenCalledWith('a', '');
    expect(ref.current?.getValue()).toBe('a');

    act(() => { getTextInput(tree).props.onChangeText('ab'); });
    expect(onChangeText).toHaveBeenLastCalledWith('ab', 'a');
    expect(ref.current?.getValue()).toBe('ab');
  });

  it('setValue does NOT fire onChangeText (silent programmatic write)', () => {
    const ref = React.createRef<InputBarHandle>();
    const onChangeText = jest.fn();
    act(() => {
      renderer.create(<InputBar ref={ref} {...baseProps} onChangeText={onChangeText} />);
    });

    act(() => { ref.current?.setValue('voice transcript'); });
    expect(onChangeText).not.toHaveBeenCalled();
    expect(ref.current?.getValue()).toBe('voice transcript');

    act(() => { ref.current?.clear(); });
    expect(onChangeText).not.toHaveBeenCalled();
  });

  it('focus() drives the underlying TextInput', () => {
    const ref = React.createRef<InputBarHandle>();
    const focusSpy = jest.spyOn(TextInput.prototype, 'focus').mockImplementation(noop);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<InputBar ref={ref} {...baseProps} onChangeText={noop} />);
    });
    // Sanity: the input is rendered.
    expect(getTextInput(tree)).toBeTruthy();
    act(() => { ref.current?.focus(); });
    expect(focusSpy).toHaveBeenCalled();
    focusSpy.mockRestore();
  });

  it('is memoized — a parent re-render with unchanged InputBar props does not re-render InputBar', () => {
    // Count actual InputBar renders. InputBar reads `attachments.length` in its
    // JSX body on every render (the attachment-strip gate, not memoized), so a
    // Proxy whose `length` getter increments a counter fires exactly once per
    // committed InputBar render.
    let renderCount = 0;
    const attachmentsArr: never[] = [];
    const attachments = new Proxy(attachmentsArr, {
      get(target, prop, recv) {
        if (prop === 'length') renderCount++;
        return Reflect.get(target, prop, recv);
      },
    });

    // Stable handler / prop identities (what SessionScreen now guarantees via
    // useCallback + the latest-ref send wrapper) keep InputBar's props shallow-
    // equal across parent re-renders, so React.memo can short-circuit.
    const stableProps = { ...baseProps, onChangeText: noop, attachments };

    function Parent({ bump }: { bump: number }) {
      // `bump` simulates streaming churn; intentionally not in InputBar's props.
      void bump;
      return <InputBar {...stableProps} />;
    }

    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Parent bump={0} />); });
    const afterFirst = renderCount;
    expect(afterFirst).toBeGreaterThan(0);

    // Parent re-renders with a new `bump` but every InputBar prop value is
    // referentially equal → React.memo short-circuits → no InputBar re-render.
    act(() => { tree.update(<Parent bump={1} />); });
    expect(renderCount).toBe(afterFirst);

    act(() => { tree.update(<Parent bump={2} />); });
    expect(renderCount).toBe(afterFirst);
  });
});
