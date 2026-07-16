/**
 * Integration tests for ActivityGroup / ActivityEntry's structured-renderer
 * wiring (#4201).
 *
 * Background: PR #4194/#4180 added the mobile TodoList renderer to
 * `ToolBubble`. `ChatView` only routes `group.type === 'single'` messages
 * through `MessageBubble → ToolBubble`, but `groupMessages()` in store-core
 * always bundles `tool_use` into `'activity'` groups — so `ToolBubble` was
 * dead code for chat. The structured renderer never appeared in the app.
 *
 * Fix: `ActivityEntry` now has its own per-entry expand state. When an
 * entry is tapped (outside selection mode), it expands inline. For TodoWrite
 * with `toolResult` present, the expanded body renders `<TodoList />` with
 * the same `testID`s ToolBubble uses (todo-list-header,
 * todo-list-item-<id>). For other tools, the expanded body renders the
 * full `toolResult` instead of the 60-char truncation.
 *
 * The collapsed row's text/preview behaviour is unchanged so the activity
 * group's compact density is preserved.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { ActivityGroup } from '../chat/ActivityGroup';
import type { ChatMessage } from '../../store/connection';

const TODOWRITE_RESULT = [
  'Todo list (3 items): 1 in progress, 1 pending, 1 completed',
  '  [x] Wrote helper (t1)',
  '  [~] Running tests (t2)',
  '  [ ] Address review (t3)',
].join('\n');

function makeToolMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'tool-1',
    type: 'tool_use',
    content: '{"todos":[{"id":"t1","status":"completed","content":"Wrote helper"}]}',
    tool: 'TodoWrite',
    toolUseId: 'toolu_xyz',
    toolResult: TODOWRITE_RESULT,
    timestamp: 0,
    ...overrides,
  };
}

function renderGroup(messages: ChatMessage[]): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <ActivityGroup
        messages={messages}
        isActive={false}
        isSelecting={false}
        selectedIds={new Set()}
        onToggleSelection={() => {}}
      />,
    );
  });
  return root;
}

function findByTestId(root: renderer.ReactTestRenderer, id: string) {
  return root.root.findAllByProps({ testID: id });
}

function expandGroup(root: renderer.ReactTestRenderer) {
  // ActivityGroup is a View with testID "activity-group"; the header row
  // inside is a TouchableOpacity with testID "activity-group-header".
  // Match by testID rather than activeOpacity so the test isn't order-
  // dependent on the TouchableOpacity tree (per #4202 Copilot review).
  const header = findByTestId(root, 'activity-group-header')[0];
  expect(header).toBeTruthy();
  act(() => {
    header!.props.onPress();
  });
}

function expandEntry(root: renderer.ReactTestRenderer, entryTestId: string) {
  const entry = findByTestId(root, entryTestId)[0];
  expect(entry).toBeTruthy();
  act(() => {
    entry!.props.onPress();
  });
}

describe('ActivityGroup / ActivityEntry — structured-renderer wiring (#4201)', () => {
  it('does not render the TodoList while the group is collapsed', () => {
    const root = renderGroup([makeToolMessage({ id: 'm1' })]);
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
  });

  it('shows the error icon for a failed tool_result and not for a successful one (#6712)', () => {
    const errored = renderGroup([makeToolMessage({ id: 'm1', tool: 'db/query', toolResult: 'boom', toolResultIsError: true })]);
    expandGroup(errored);
    expect(findByTestId(errored, 'activity-entry-error-m1')[0]).toBeTruthy();

    const ok = renderGroup([makeToolMessage({ id: 'm2', toolResult: 'ok' })]);
    expandGroup(ok);
    expect(findByTestId(ok, 'activity-entry-error-m2')).toHaveLength(0);

    // Pending (no result yet) also shows no error icon.
    const pending = renderGroup([makeToolMessage({ id: 'm3', toolResult: undefined })]);
    expandGroup(pending);
    expect(findByTestId(pending, 'activity-entry-error-m3')).toHaveLength(0);
  });

  it('does not render the TodoList when only the group is expanded but the entry is not', () => {
    const root = renderGroup([makeToolMessage({ id: 'm1' })]);
    expandGroup(root);
    // Group expanded → entry visible. But the entry itself is still collapsed
    // (showing its truncated preview row), so the structured renderer
    // shouldn't be present yet.
    expect(findByTestId(root, 'activity-entry-m1')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
  });

  it('renders the structured TodoList after expanding the entry for a TodoWrite', () => {
    const root = renderGroup([makeToolMessage({ id: 'm1' })]);
    expandGroup(root);
    expandEntry(root, 'activity-entry-m1');
    expect(findByTestId(root, 'todo-list-header')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-item-t1')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-item-t2')[0]).toBeTruthy();
    expect(findByTestId(root, 'todo-list-item-t3')[0]).toBeTruthy();
  });

  it('parses message.toolResult — not message.content (regression net for #4194)', () => {
    // `content` is plainly NOT a TodoWrite header. If the parser were
    // pointed at it, the structured renderer would not appear — and the raw
    // JSON would leak into the expanded body's text.
    const root = renderGroup([makeToolMessage({
      id: 'm1',
      content: '{"some":"input"}',
      toolResult: TODOWRITE_RESULT,
    })]);
    expandGroup(root);
    expandEntry(root, 'activity-entry-m1');
    expect(findByTestId(root, 'todo-list-header')[0]).toBeTruthy();
    const texts = root.root.findAllByType(Text);
    const allText = texts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(allText).not.toMatch(/"some":"input"/);
  });

  it('falls back to raw toolResult text when toolResult is present but unparseable', () => {
    const root = renderGroup([makeToolMessage({
      id: 'm1',
      tool: 'Bash',
      toolResult: 'bash: command not found\nexit=127',
    })]);
    expandGroup(root);
    expandEntry(root, 'activity-entry-m1');
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
    // The expanded body shows the full toolResult, not the 60-char
    // truncation from the collapsed row preview.
    const texts = root.root.findAllByType(Text);
    const allText = texts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(allText).toMatch(/exit=127/);
  });

  it('does not invoke the structured renderer for non-TodoWrite tools (Bash, Read, etc.)', () => {
    const root = renderGroup([makeToolMessage({
      id: 'm1',
      tool: 'Bash',
      // Even with a TodoWrite-shaped string the tool gate stays.
      toolResult: TODOWRITE_RESULT,
    })]);
    expandGroup(root);
    expandEntry(root, 'activity-entry-m1');
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
  });

  it('falls back to raw content when toolResult has not arrived yet (pending state)', () => {
    const root = renderGroup([makeToolMessage({
      id: 'm1',
      toolResult: undefined,
    })]);
    expandGroup(root);
    expandEntry(root, 'activity-entry-m1');
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
    // Pending entries should still expand and show whatever content
    // (typically the tool's JSON input) so the user has something to see.
    const texts = root.root.findAllByType(Text);
    const allText = texts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(allText).toMatch(/"todos"/);
  });

  it('preserves selection-mode behaviour — tap toggles selection, no expand', () => {
    // Mount with isSelecting=false so the group can expand and render
    // the entry, then update to isSelecting=true to mimic the user
    // entering selection mode after the group is already open
    // (e.g. via long-press elsewhere in the chat). This matches how
    // selection mode actually flips on at runtime.
    const selected: string[] = [];
    let root!: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(
        <ActivityGroup
          messages={[makeToolMessage({ id: 'm1' })]}
          isActive={false}
          isSelecting={false}
          selectedIds={new Set()}
          onToggleSelection={(id) => { selected.push(id); }}
        />,
      );
    });
    expandGroup(root);
    // Now flip to selection mode.
    act(() => {
      root.update(
        <ActivityGroup
          messages={[makeToolMessage({ id: 'm1' })]}
          isActive={false}
          isSelecting={true}
          selectedIds={new Set()}
          onToggleSelection={(id) => { selected.push(id); }}
        />,
      );
    });
    const entry = findByTestId(root, 'activity-entry-m1')[0];
    expect(entry).toBeTruthy();
    act(() => {
      entry!.props.onPress();
    });
    // Structured renderer must NOT have appeared (the press toggled
    // selection, not expand).
    expect(findByTestId(root, 'todo-list-header')).toHaveLength(0);
    expect(selected).toEqual(['m1']);
  });

  it('disables onLongPress once expanded so the user can select text in the body (#4202 Copilot review)', () => {
    // When the entry is collapsed, long-press routes into selection
    // mode. When expanded the user expects long-press on the visible
    // expanded text to trigger iOS text selection (the `<Text selectable>`).
    // If onLongPress is still wired, the gesture is consumed before text
    // selection can fire. Mirrors ToolBubble's pattern (ToolBubble.tsx:74).
    const root = renderGroup([makeToolMessage({ id: 'm1' })]);
    expandGroup(root);
    const collapsedEntry = findByTestId(root, 'activity-entry-m1')[0];
    // Before expanding the entry: onLongPress is present.
    expect(typeof collapsedEntry!.props.onLongPress).toBe('function');
    // Expand the entry.
    act(() => {
      collapsedEntry!.props.onPress();
    });
    const expandedEntry = findByTestId(root, 'activity-entry-m1')[0];
    // After expanding: onLongPress is undefined → iOS text selection on
    // the expanded body's <Text selectable> isn't pre-empted.
    expect(expandedEntry!.props.onLongPress).toBeUndefined();
  });

  it('each entry expands independently in a multi-tool activity group', () => {
    // Bash output is longer than the 60-char collapsed-row preview slice
    // so we can distinguish "row preview" (truncated) from "expanded body"
    // (full). The unique marker "MARKER-IN-EXPANDED-ONLY" sits past
    // position 60 in the toolResult string and therefore only appears
    // when the entry is expanded.
    const longBashResult =
      '0123456789'.repeat(7) + ' MARKER-IN-EXPANDED-ONLY ' + 'tail';
    const root = renderGroup([
      makeToolMessage({ id: 'm1' }),
      makeToolMessage({ id: 'm2', tool: 'Bash', toolResult: longBashResult }),
    ]);
    expandGroup(root);
    // Expand only m1.
    expandEntry(root, 'activity-entry-m1');
    expect(findByTestId(root, 'todo-list-header')[0]).toBeTruthy();
    // m2 still collapsed → its expanded body (containing MARKER) must
    // not be in the tree yet.
    const beforeTexts = root.root.findAllByType(Text);
    const beforeAll = beforeTexts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(beforeAll).not.toMatch(/MARKER-IN-EXPANDED-ONLY/);
    // Now expand m2 too — TodoList stays, Bash MARKER appears.
    expandEntry(root, 'activity-entry-m2');
    expect(findByTestId(root, 'todo-list-header')[0]).toBeTruthy();
    const afterTexts = root.root.findAllByType(Text);
    const afterAll = afterTexts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(afterAll).toMatch(/MARKER-IN-EXPANDED-ONLY/);
  });

  // #4203: tool returns images-only (toolResult === undefined, toolResultImages
  // has entries). Pre-fix the expanded body resolved to '' because hasResult
  // is true via images but the text-rendering expression used toolResult ||
  // '' which is the empty string. Now the expanded body falls back to an
  // explicit "N images attached" placeholder so the user sees something.
  it('renders an images-attached placeholder when toolResult is undefined and images are present (#4203)', () => {
    const root = renderGroup([
      makeToolMessage({
        id: 'm1',
        tool: 'Screenshot',
        toolResult: undefined,
        toolResultImages: [
          { mediaType: 'image/png', data: 'AAAA' },
          { mediaType: 'image/png', data: 'BBBB' },
        ],
      } as ChatMessage),
    ]);
    expandGroup(root);
    expandEntry(root, 'activity-entry-m1');
    const texts = root.root.findAllByType(Text);
    const allText = texts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(allText).toMatch(/2 images attached/);
  });

  it('renders the singular placeholder when exactly 1 image is attached (#4203)', () => {
    const root = renderGroup([
      makeToolMessage({
        id: 'm1',
        tool: 'Screenshot',
        toolResult: undefined,
        toolResultImages: [{ mediaType: 'image/png', data: 'AAAA' }],
      } as ChatMessage),
    ]);
    expandGroup(root);
    expandEntry(root, 'activity-entry-m1');
    const texts = root.root.findAllByType(Text);
    const allText = texts
      .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(allText).toMatch(/1 image attached/);
    expect(allText).not.toMatch(/2 images attached/);
  });

  // #5517: virtualization recycle-safety. ChatView now renders the
  // transcript through a FlatList, so a group / entry can unmount when
  // scrolled off-screen and remount on the way back. The group + entry expand
  // flags must seed from ChatView's id-keyed registry (getInitialExpanded /
  // onExpandedChange) so the row reopens to the user's last choice rather than
  // snapping back to collapsed.
  describe('expand state survives FlatList row recycling (#5517)', () => {
    function makeRegistry() {
      const map = new Map<string, boolean>();
      return {
        getInitialExpanded: (id: string) => map.get(id) ?? false,
        onExpandedChange: (id: string, expanded: boolean) => {
          if (expanded) map.set(id, true);
          else map.delete(id);
        },
        map,
      };
    }

    function mountGroup(
      reg: ReturnType<typeof makeRegistry>,
      messages: ChatMessage[],
    ): renderer.ReactTestRenderer {
      let root!: renderer.ReactTestRenderer;
      act(() => {
        root = renderer.create(
          <ActivityGroup
            messages={messages}
            isActive={false}
            isSelecting={false}
            selectedIds={new Set()}
            onToggleSelection={() => {}}
            groupKey={`activity-${messages[0].id}`}
            getInitialExpanded={reg.getInitialExpanded}
            onExpandedChange={reg.onExpandedChange}
          />,
        );
      });
      return root;
    }

    it('reopens an expanded group + entry after unmount/remount via the registry', () => {
      const reg = makeRegistry();
      const messages = [makeToolMessage({ id: 'm1' })];

      // First mount: expand the group then the entry, then unmount (recycle).
      const first = mountGroup(reg, messages);
      expandGroup(first);
      expandEntry(first, 'activity-entry-m1');
      expect(findByTestId(first, 'todo-list-header')[0]).toBeTruthy();
      act(() => first.unmount());

      // The registry remembers both the group key and the entry id.
      expect(reg.map.get('activity-m1')).toBe(true);
      expect(reg.map.get('m1')).toBe(true);

      // Remount (scrolled back into view): the structured renderer appears
      // immediately, with no taps — proving the row seeded from the registry.
      const second = mountGroup(reg, messages);
      expect(findByTestId(second, 'todo-list-header')[0]).toBeTruthy();
    });

    it('a collapsed group stays collapsed after recycling (no false-positive)', () => {
      const reg = makeRegistry();
      const messages = [makeToolMessage({ id: 'm2' })];
      const first = mountGroup(reg, messages);
      // Never expanded.
      act(() => first.unmount());
      expect(reg.map.has('activity-m2')).toBe(false);
      const second = mountGroup(reg, messages);
      expect(findByTestId(second, 'todo-list-header')).toHaveLength(0);
    });
  });
});
