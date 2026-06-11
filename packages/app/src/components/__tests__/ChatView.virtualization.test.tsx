/**
 * ChatView virtualization — #5517 (epic #5514, "streaming latency")
 *
 * Replaces the ScrollView + `displayGroups.map` with a virtualized FlatList.
 * These tests pin the behaviours the issue requires be preserved across the
 * migration:
 *
 *  1. The conversation renders through a FlatList (so off-screen rows can be
 *     recycled instead of all mounting at once).
 *  2. Stable keys — activity groups keyed by `group.key`, single rows by the
 *     message id — so the #5516 memo comparator's identity check holds and
 *     FlatList recycling never collapses two rows onto one key.
 *  3. Expand/collapse state of tool bubbles survives row recycling, because it
 *     lives OUTSIDE the recyclable row (in a ChatView-held registry keyed by
 *     message id) rather than in a row-local `useState` that resets on remount.
 *  4. The auto-scroll-to-bottom / sticky-streaming / keyboard behaviours from
 *     ChatView are still wired (source-level, mirroring the existing #1711
 *     auto-scroll test which also reads the source).
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { FlatList } from 'react-native';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: { sendInput: () => void }) => unknown) =>
    selector({ sendInput: () => {} }),
}));

import { AccessibilityInfo } from 'react-native';
import { ChatView } from '../ChatView';

// The AccessibilityInfo reduceMotion listener resolves async after the test
// completes; under react-test-renderer + jsdom the resulting setState fires a
// global error event into a window without dispatchEvent, crashing teardown.
// Spy on the real methods so the component's effect is inert in tests without
// replacing the module (which the renderer's internals also depend on).
beforeAll(() => {
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({ remove: () => {} } as never);
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(true);
});
afterAll(() => jest.restoreAllMocks());
import type { ChatMessage } from '../../store/types';

const source = fs.readFileSync(
  path.resolve(__dirname, '../ChatView.tsx'),
  'utf-8',
);

function toolMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'tool_use',
    content: 'cat file.txt',
    tool: 'Bash',
    toolUseId: `toolu_${id}`,
    toolResult: 'file contents',
    timestamp: 1000,
    ...overrides,
  } as ChatMessage;
}

function responseMessage(id: string, content: string): ChatMessage {
  return { id, type: 'response', content, timestamp: 1000 } as ChatMessage;
}

const noop = () => {};

function makeProps(messages: ChatMessage[]) {
  const ref = React.createRef<FlatList>();
  return {
    messages,
    scrollViewRef: ref as unknown as React.RefObject<FlatList<unknown> | null>,
    claudeReady: true,
    onSelectOption: noop,
    isCliMode: false,
    selectedIds: new Set<string>(),
    isSelecting: false,
    isSelectingRef: { current: false } as React.MutableRefObject<boolean>,
    onToggleSelection: noop,
    streamingMessageId: null,
  };
}

/** Pull every host node of a given type out of a react-test-renderer tree. */
function findAllByType(root: renderer.ReactTestInstance, type: unknown) {
  return root.findAllByType(type as never);
}

describe('ChatView virtualization (#5517)', () => {
  it('renders the conversation through a FlatList', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<ChatView {...makeProps([responseMessage('m1', 'hi')])} />);
    });
    const lists = findAllByType(tree.root, FlatList);
    expect(lists.length).toBeGreaterThan(0);
  });

  it('gives each row a stable key (single by id, activity by group key)', () => {
    // Two contiguous tool_use messages collapse into one activity group; a
    // trailing response stays single. keyExtractor must return the group key
    // for the activity and the message id for the response.
    const messages = [
      toolMessage('t1'),
      toolMessage('t2'),
      responseMessage('r1', 'done'),
    ];
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<ChatView {...makeProps(messages)} />);
    });
    const list = findAllByType(tree.root, FlatList)[0];
    const data = list.props.data as { type: string; key?: string; message?: ChatMessage }[];
    const keyExtractor = list.props.keyExtractor as (item: unknown, i: number) => string;
    const keys = data.map((item, i) => keyExtractor(item, i));
    // Stable, unique keys.
    expect(new Set(keys).size).toBe(keys.length);
    // The activity group's key is the synthetic activity-<firstId>.
    expect(keys).toContain('activity-t1');
    // The trailing single response keys by its message id.
    expect(keys).toContain('r1');
  });

  it('keeps the streamed/tail message identity stable for the memo comparator', () => {
    // The keyExtractor must not wrap items in fresh objects per render — the
    // #5516 memo relies on `prev.message === next.message`. Re-deriving keys
    // from ids/group keys (not array index alone) guarantees a streamed delta
    // only re-renders its own row.
    const messages = [responseMessage('a', 'one'), responseMessage('b', 'two')];
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<ChatView {...makeProps(messages)} />);
    });
    const list = findAllByType(tree.root, FlatList)[0];
    const keyExtractor = list.props.keyExtractor as (item: unknown, i: number) => string;
    const data = list.props.data as unknown[];
    expect(keyExtractor(data[0], 0)).toBe('a');
    expect(keyExtractor(data[1], 1)).toBe('b');
  });

  // --- Source-level guarantees (recycling-safe expand state + scroll) ---

  it('holds tool-bubble expand state outside the recyclable row (keyed by id)', () => {
    // The registry must live in ChatView so a recycled row re-reads its
    // expanded flag from the parent instead of resetting to collapsed.
    expect(source).toMatch(/expandedIds|expandedRegistry|expandedMap/);
  });

  it('passes the expand registry / toggle down to the rows', () => {
    // ChatView wires controlled expand props into the activity + bubble rows.
    expect(source).toMatch(/onToggleExpanded|setExpandedIds|onExpandedChange/);
  });

  it('still auto-scrolls to bottom when content grows (sticky streaming)', () => {
    // FlatList exposes scrollToEnd just like ScrollView; the onContentSizeChange
    // → scrollToEnd path that keeps the latest message visible must survive.
    expect(source).toMatch(/onContentSizeChange[\s\S]{0,200}scrollToEnd/);
  });

  it('still pauses auto-scroll while selecting or an unanswered prompt is up', () => {
    expect(source).toMatch(/isSelectingRef\.current[\s\S]{0,120}hasUnansweredPrompt/);
  });

  it('does not yank a scrolled-up reader to the bottom on content-size churn', () => {
    // FlatList fires onContentSizeChange on windowing too, so the auto-scroll
    // must also gate on showScrollToBottomRef (user is near the bottom).
    expect(source).toMatch(/onContentSizeChange[\s\S]{0,400}showScrollToBottomRef\.current/);
  });

  it('keeps keyboard auto-scroll wiring', () => {
    expect(source).toMatch(/keyboardVisible[\s\S]{0,300}scrollToEnd/);
  });

  it('preserves keyboard handling props (dismiss-on-drag, persist taps)', () => {
    expect(source).toMatch(/keyboardDismissMode=["']on-drag["']/);
    expect(source).toMatch(/keyboardShouldPersistTaps=["']handled["']/);
  });
});
