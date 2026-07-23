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
import { TextInput, StyleSheet, Text } from 'react-native';
import { InputBar, type InputBarHandle } from '../InputBar';
import { COLORS } from '../../constants/colors';

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

describe('InputBar send-while-streaming un-gate (#5938)', () => {
  // findByProps throws on 0 or >1; it collapses composite+host duplicates to the
  // single component, so it's the reliable presence/absence probe here.
  function present(tree: renderer.ReactTestRenderer, id: string): boolean {
    try { tree.root.findByProps({ testID: id }); return true; } catch { return false; }
  }

  it('shows ONLY the Send button when idle', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<InputBar {...baseProps} isStreaming={false} onChangeText={noop} />);
    });
    expect(present(tree, 'chat-send-button')).toBe(true);
    expect(present(tree, 'chat-stop-button')).toBe(false);
  });

  it('shows BOTH Send and Stop while streaming (so a mid-turn send can queue)', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<InputBar {...baseProps} isStreaming={true} onChangeText={noop} />);
    });
    // Send stays available → routes to the outgoing queue.
    expect(present(tree, 'chat-send-button')).toBe(true);
    // Stop is alongside it → interrupts the live turn.
    expect(present(tree, 'chat-stop-button')).toBe(true);
  });

  it('the streaming Send button is enabled and fires onSend (enqueue path)', () => {
    const onSend = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<InputBar {...baseProps} isStreaming={true} onSend={onSend} onChangeText={noop} />);
    });
    const send = tree.root.findByProps({ testID: 'chat-send-button' });
    expect(send.props.accessibilityState?.disabled).toBeFalsy();
    // The label flips to "Queue message" mid-turn for clarity.
    expect(send.props.accessibilityLabel).toBe('Queue message');
    act(() => { send.props.onPress(); });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('Enter-to-send stays wired while streaming (onSubmitEditing fires onSend)', () => {
    const onSend = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} isStreaming={true} enterToSend onSend={onSend} onChangeText={noop} />,
      );
    });
    const input = getTextInput(tree);
    expect(input.props.onSubmitEditing).toBeDefined();
    act(() => { input.props.onSubmitEditing(); });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  // #6116 — the agent_busy-but-not-streaming window (isBusy && !isStreaming):
  // the send queues (#6113), so the busy affordance must show even though no
  // text is streaming yet.
  it('shows Stop + "Queue message" + follow-up placeholder when busy pre-stream', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} isStreaming={false} isBusy={true} onChangeText={noop} />,
      );
    });
    expect(present(tree, 'chat-stop-button')).toBe(true);
    const send = tree.root.findByProps({ testID: 'chat-send-button' });
    expect(send.props.accessibilityLabel).toBe('Queue message');
    expect(getTextInput(tree).props.placeholder).toBe('Type to send follow-up…');
  });

  it('idle (not streaming, not busy) shows neither Stop nor the queue label', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} isStreaming={false} isBusy={false} onChangeText={noop} />,
      );
    });
    expect(present(tree, 'chat-stop-button')).toBe(false);
    expect(tree.root.findByProps({ testID: 'chat-send-button' }).props.accessibilityLabel).toBe('Send message');
  });

  // #6118 — attach/camera stay available during an active turn so a queued
  // follow-up can carry attachments.
  const hasLabel = (tree: renderer.ReactTestRenderer, label: string) => {
    try { tree.root.findByProps({ accessibilityLabel: label }); return true; } catch { return false; }
  };

  it.each([
    ['streaming', { isStreaming: true, isBusy: false }],
    ['busy pre-stream', { isStreaming: false, isBusy: true }],
  ])('keeps Attach + Camera available while %s (queue a follow-up with files)', (_label, turn) => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} {...turn} onAttach={noop} onCamera={noop} onChangeText={noop} />,
      );
    });
    expect(hasLabel(tree, 'Attach file')).toBe(true);
    expect(hasLabel(tree, 'Take photo')).toBe(true);
  });

  it('still hides Attach + Camera while disconnected (disabled), even mid-turn', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} isStreaming={true} disabled onAttach={noop} onCamera={noop} onChangeText={noop} />,
      );
    });
    expect(hasLabel(tree, 'Attach file')).toBe(false);
    expect(hasLabel(tree, 'Take photo')).toBe(false);
  });
});

describe('InputBar activity hairline (chat redesign #6391)', () => {
  // The root composer View's style is [styles.inputContainer, { paddingBottom,
  // borderTopColor }]. The base style ALSO sets borderTopColor, so target the
  // inline override — uniquely identified by carrying BOTH paddingBottom and
  // borderTopColor — to read the EFFECTIVE (later-wins) edge color.
  function hairlineColor(tree: renderer.ReactTestRenderer): unknown {
    const view = tree.root.findAll(
      (node) =>
        String(node.type) === 'View' &&
        Array.isArray(node.props.style) &&
        node.props.style.some(
          (s: any) => s && typeof s === 'object' && 'paddingBottom' in s && 'borderTopColor' in s,
        ),
    )[0];
    // Flatten to the EFFECTIVE (later-wins) edge color RN actually paints —
    // robust even if a future style element re-overrides borderTopColor.
    return StyleSheet.flatten(view.props.style).borderTopColor;
  }

  it('keeps the neutral edge at idle (default — no visible change at rest)', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<InputBar {...baseProps} onChangeText={noop} />); });
    expect(hairlineColor(tree)).toBe(COLORS.backgroundCard);
  });

  it('tints the composer edge by chat-activity state (no layout shift — color only)', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<InputBar {...baseProps} onChangeText={noop} activityState="thinking" />);
    });
    expect(hairlineColor(tree)).toBe(COLORS.accentBlue);

    act(() => { tree.update(<InputBar {...baseProps} onChangeText={noop} activityState="waiting" />); });
    expect(hairlineColor(tree)).toBe(COLORS.accentOrange);

    act(() => { tree.update(<InputBar {...baseProps} onChangeText={noop} activityState="error" />); });
    expect(hairlineColor(tree)).toBe(COLORS.textError);
  });
});

describe('InputBar slash-command grouping (chat redesign #6391)', () => {
  // Intentionally out of source order to prove the picker sorts/groups them.
  const slashCommands = [
    { name: 'zeta-user', description: 'u', source: 'user' as const },
    { name: 'alpha-builtin', description: 'b', source: 'builtin' as const },
    { name: 'mid-project', description: 'p', source: 'project' as const },
  ];

  // All visible Text content in tree (render) order — headers, names, badges.
  function textsInOrder(tree: renderer.ReactTestRenderer): string[] {
    return tree.root
      .findAllByType(Text)
      .map((t) => (Array.isArray(t.props.children) ? t.props.children.join('') : t.props.children))
      .filter((c): c is string => typeof c === 'string');
  }

  // `inputText="/"` seeds the internal draft to '/', which opens the picker
  // with the full (sorted) command list.
  function openPicker(): renderer.ReactTestRenderer {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} onChangeText={noop} inputText="/" slashCommands={slashCommands} />,
      );
    });
    return tree;
  }

  it('renders source section headers in Built-in → Project → User order', () => {
    const texts = textsInOrder(openPicker());
    const iBuiltin = texts.indexOf('Built-in');
    const iProject = texts.indexOf('Project');
    const iUser = texts.indexOf('User');
    expect(iBuiltin).toBeGreaterThanOrEqual(0);
    expect(iProject).toBeGreaterThan(iBuiltin);
    expect(iUser).toBeGreaterThan(iProject);
    // The builtin command sorts under its header, ahead of the user command.
    expect(texts.indexOf('/alpha-builtin')).toBeGreaterThan(iBuiltin);
    expect(texts.indexOf('/alpha-builtin')).toBeLessThan(texts.indexOf('/zeta-user'));
  });

  it('badges builtin and user but leaves project badgeless (dashboard parity)', () => {
    const tree = openPicker();
    const texts = textsInOrder(tree);
    expect(texts).toContain('built-in');
    expect(texts).toContain('user');
    // No lowercase 'project' badge — the "Project" header conveys the group.
    expect(texts).not.toContain('project');
    // #3856 parity: built-in is the distinct OUTLINED accent chip (transparent
    // bg); user is the flat chip. Pin the visual distinction against regression.
    const badgeStyle = (label: string) => {
      const t = tree.root.findAllByType(Text).find((n) => {
        const c = Array.isArray(n.props.children) ? n.props.children.join('') : n.props.children;
        return c === label;
      })!;
      return StyleSheet.flatten(t.props.style);
    };
    expect(badgeStyle('built-in').backgroundColor).toBe('transparent');
    expect(badgeStyle('user').backgroundColor).not.toBe('transparent');
  });
});

describe('InputBar composer state lozenge (chat redesign #6391)', () => {
  // Mirrors the dashboard's InputBarLozenge.test.tsx — same three cases the
  // design doc's signature moment calls out: streaming with a queued
  // follow-up, streaming with none, and hidden at idle. `formatComposerLozenge`
  // (shared via @chroxy/store-core) is the single source of the copy, so
  // these assert the mobile twin actually renders what that helper returns.
  function lozengeText(tree: renderer.ReactTestRenderer): string | null {
    try {
      const node = tree.root.findByProps({ testID: 'input-bar-lozenge' });
      const textNode = node.findByType(Text);
      return Array.isArray(textNode.props.children)
        ? textNode.props.children.join('')
        : textNode.props.children;
    } catch {
      return null;
    }
  }

  it('shows "◐ streaming · +N queued" when thinking with queued follow-ups', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} onChangeText={noop} activityState="thinking" queuedCount={2} />,
      );
    });
    expect(lozengeText(tree)).toBe('◐ streaming · +2 queued');
  });

  it('shows "◐ streaming" with no queued suffix when thinking with none queued', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} onChangeText={noop} activityState="thinking" queuedCount={0} />,
      );
    });
    expect(lozengeText(tree)).toBe('◐ streaming');
  });

  it('hides the lozenge entirely at idle, even with a stale queued count', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} onChangeText={noop} activityState="idle" queuedCount={3} />,
      );
    });
    expect(lozengeText(tree)).toBeNull();
  });

  it('hides the lozenge when activityState/queuedCount are omitted (default idle)', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<InputBar {...baseProps} onChangeText={noop} />);
    });
    expect(lozengeText(tree)).toBeNull();
  });

  it('labels the busy and waiting states distinctly from streaming', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <InputBar {...baseProps} onChangeText={noop} activityState="busy" queuedCount={1} />,
      );
    });
    expect(lozengeText(tree)).toBe('◐ busy · +1 queued');

    act(() => {
      tree.update(
        <InputBar {...baseProps} onChangeText={noop} activityState="waiting" queuedCount={0} />,
      );
    });
    expect(lozengeText(tree)).toBe('◐ waiting');
  });
});
