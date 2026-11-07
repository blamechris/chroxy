/**
 * #8357 -- Approve-mode AskUserQuestion on the mobile app.
 *
 * Two rules, both already true on the dashboard (#8264, #4685):
 *   1. The permission card reads as a question -- "Claude wants to ask you a
 *      question", the question and its options as text -- never the tool input
 *      as JSON.
 *   2. The question card is withheld until the user ALLOWS the permission. A
 *      deny, a missing decision or the replay placeholder keeps it withheld.
 *
 * Rendered through the real ChatView so the gate is proven where it is wired,
 * not just in the predicate.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, FlatList, Text } from 'react-native';

jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (s: { sendInput: () => void; activeSessionId: string | null }) => unknown) =>
    selector({ sendInput: () => {}, activeSessionId: null }),
}));

import { ChatView } from '../ChatView';
import { renderPermissionDetail } from '../PermissionDetail';
import type { ChatMessage } from '../../store/types';

beforeAll(() => {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const noop = () => {};

const TOOL_INPUT = {
  questions: [
    {
      question: 'Which color should the button be?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Crimson', description: 'warm' },
        { label: 'Teal', description: 'cool' },
      ],
    },
  ],
};

function permissionPrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'perm-1',
    type: 'prompt',
    // The server's `description` for a tool with no command/file_path: the tool
    // input as JSON, cut at 200 characters. This is what the old card printed.
    content: 'AskUserQuestion: {"questions":[{"question":"Which color should the button be?","header":"Color"',
    tool: 'AskUserQuestion',
    toolInput: TOOL_INPUT,
    requestId: 'req-1',
    expiresAt: Date.now() + 60_000,
    options: [
      { label: 'Allow', value: 'allow' },
      { label: 'Deny', value: 'deny' },
    ],
    timestamp: 1000,
    ...overrides,
  } as ChatMessage;
}

function questionCard(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'q-1',
    type: 'prompt',
    content: 'Which color should the button be?',
    toolUseId: 'toolu_q1',
    options: [
      { label: 'Crimson', value: 'Crimson' },
      { label: 'Teal', value: 'Teal' },
    ],
    questions: [
      {
        question: 'Which color should the button be?',
        options: [
          { label: 'Crimson', value: 'Crimson' },
          { label: 'Teal', value: 'Teal' },
        ],
      },
    ],
    timestamp: 1001,
    ...overrides,
  } as ChatMessage;
}

function renderFeed(messages: ChatMessage[]) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(feedElement(messages));
  });
  return tree;
}

function feedElement(messages: ChatMessage[]) {
  const ref = React.createRef<FlatList>();
  return (
      <ChatView
        messages={messages}
        scrollViewRef={ref as unknown as React.RefObject<FlatList<unknown> | null>}
        claudeReady
        onSelectOption={noop}
        isCliMode={false}
        selectedIds={new Set<string>()}
        isSelecting={false}
        isSelectingRef={{ current: false } as React.MutableRefObject<boolean>}
        onToggleSelection={noop}
        streamingMessageId={null}
        isPlanPending={false}
        planAllowedPrompts={[]}
        onApprovePlan={noop}
        onFocusInput={noop}
      />
  );
}

function allText(tree: renderer.ReactTestRenderer): string {
  return tree.root
    .findAll((n) => n.type === Text)
    .map((n) => [n.props.children].flat(Infinity).filter((c) => typeof c === 'string').join(''))
    .join('\n');
}

const questionCardShown = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll((n) => n.props?.testID === 'approval-card-q-1' && typeof n.type === 'string').length > 0;

describe('AskUserQuestion permission card (#8357, rule 1)', () => {
  it('reads as a question with the question and options as text, not JSON', () => {
    const tree = renderFeed([permissionPrompt()]);
    const text = allText(tree);
    expect(text).toContain('Claude wants to ask you a question');
    expect(text).toContain('Which color should the button be?');
    expect(text).toContain('Crimson');
    expect(text).toContain('Teal');
    expect(text.includes('{"questions"')).toBe(false);
    expect(text.includes('"question":')).toBe(false);
    act(() => tree.unmount());
  });

  it('counts the questions when there are several', () => {
    const two = { questions: [TOOL_INPUT.questions[0], { question: 'Which size?', options: [{ label: 'S' }, { label: 'L' }] }] };
    const tree = renderFeed([permissionPrompt({ toolInput: two })]);
    expect(allText(tree)).toContain('Claude wants to ask you 2 questions');
    act(() => tree.unmount());
  });

  it('falls back to the headline alone, never JSON, when the input is the server truncation placeholder', () => {
    const tree = renderFeed([permissionPrompt({ toolInput: { _truncated: true, summary: 'AskUserQuestion input' } })]);
    const text = allText(tree);
    expect(text).toContain('Claude wants to ask you a question');
    expect(text.includes('_truncated')).toBe(false);
    act(() => tree.unmount());
  });

  it('is only the AskUserQuestion tool: other tools keep their own body', () => {
    expect(renderPermissionDetail('Read', { file_path: '/tmp/x' })).not.toBeNull();
    const el = renderer.create(renderPermissionDetail('Bash', { command: 'ls' }) as React.ReactElement);
    expect(JSON.stringify(el.toJSON()).includes('Claude wants to ask you')).toBe(false);
    act(() => el.unmount());
  });
});

describe('AskUserQuestion consent gate (#8357, rule 2 / #4685)', () => {
  it('withholds the question card while the permission is unanswered', () => {
    const tree = renderFeed([permissionPrompt(), questionCard()]);
    expect(questionCardShown(tree)).toBe(false);
    // The question text appears once -- on the permission card -- and its
    // option buttons (answer controls) do not exist yet.
    expect(tree.root.findAll((n) => n.props?.testID === 'approval-button-Crimson').length).toBe(0);
    act(() => tree.unmount());
  });

  it('gates a question card whatever tool name the payload carries (never keyed on the name)', () => {
    for (const tool of [undefined, 'AskUserQuestion', 'SomethingElse']) {
      const tree = renderFeed([permissionPrompt(), questionCard({ tool })]);
      expect(questionCardShown(tree)).toBe(false);
      act(() => tree.unmount());
    }
  });

  it.each(['allow', 'allowSession', 'allowAlways'])('reveals the question card once the permission is answered "%s"', (answered) => {
    const tree = renderFeed([permissionPrompt({ answered }), questionCard()]);
    expect(questionCardShown(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it.each(['deny', '(resolved)'])('keeps the question card withheld when the permission is "%s"', (answered) => {
    const tree = renderFeed([permissionPrompt({ answered }), questionCard()]);
    expect(questionCardShown(tree)).toBe(false);
    act(() => tree.unmount());
  });

  it('reveals the SAME question row when Allow lands (the memoised bubble re-renders)', () => {
    const q = questionCard();
    const tree = renderFeed([permissionPrompt(), q]);
    expect(questionCardShown(tree)).toBe(false);
    act(() => {
      tree.update(feedElement([permissionPrompt({ answered: 'allow' }), q]));
    });
    expect(questionCardShown(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it('does not gate a question the user already answered', () => {
    const tree = renderFeed([permissionPrompt(), questionCard({ answered: 'Teal' })]);
    expect(questionCardShown(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it('does not gate a question when no AskUserQuestion permission is pending (auto / bypass modes)', () => {
    const tree = renderFeed([questionCard()]);
    expect(questionCardShown(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it('is not opened by a pending permission for a DIFFERENT tool being allowed', () => {
    const bash = permissionPrompt({ id: 'perm-2', requestId: 'req-2', tool: 'Bash', toolInput: { command: 'ls' }, answered: 'allow' });
    const tree = renderFeed([permissionPrompt(), bash, questionCard()]);
    expect(questionCardShown(tree)).toBe(false);
    act(() => tree.unmount());
  });
});
