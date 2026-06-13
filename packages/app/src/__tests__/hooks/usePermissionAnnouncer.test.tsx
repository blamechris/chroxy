/**
 * #5750 (item 2) — `usePermissionAnnouncer` assertive screen-reader
 * announcement when a NEW permission prompt arrives.
 *
 * Mirrors the dashboard's #5733 assertive treatment on mobile:
 *   - a prompt already present at mount stays silent (seed),
 *   - a newly-arriving live permission prompt is announced once, with a
 *     human summary,
 *   - AskUserQuestion / answered / expired prompts never announce,
 *   - after a prompt resolves, a genuinely new prompt announces again.
 *
 * Same react-test-renderer + mocked `announceForAccessibility` harness as
 * `useConnectionAnnouncer.test.tsx`. The hook is timer-less (it reads
 * `Date.now()` directly), so no fake timers are needed.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo } from 'react-native';
import type { ChatMessage } from '@chroxy/store-core';

import {
  usePermissionAnnouncer,
  firstLivePermissionPrompt,
} from '../../hooks/usePermissionAnnouncer';

jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
const announceMock = AccessibilityInfo.announceForAccessibility as jest.Mock;

function permPrompt(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'p',
    type: 'prompt',
    requestId: 'req-1',
    expiresAt: Date.now() + 60_000,
    tool: 'Bash',
    toolInput: { command: 'ls' },
    ...over,
  } as ChatMessage;
}

function Harness({ messages }: { messages: ChatMessage[] }) {
  usePermissionAnnouncer(messages);
  return null;
}

function render(messages: ChatMessage[]) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Harness messages={messages} />);
  });
  return tree;
}

function update(tree: renderer.ReactTestRenderer, messages: ChatMessage[]) {
  act(() => {
    tree.update(<Harness messages={messages} />);
  });
}

beforeEach(() => {
  announceMock.mockClear();
});

describe('firstLivePermissionPrompt', () => {
  const now = 1_000_000;
  it('returns a live, unanswered permission prompt', () => {
    expect(firstLivePermissionPrompt([permPrompt({ expiresAt: now + 1 })], now)?.requestId).toBe('req-1');
  });
  it('skips answered / expired / AskUserQuestion / non-prompt', () => {
    expect(firstLivePermissionPrompt([permPrompt({ answered: 'allow' })], now)).toBeNull();
    expect(firstLivePermissionPrompt([permPrompt({ expiresAt: now - 1 })], now)).toBeNull();
    expect(firstLivePermissionPrompt([{ id: 'q', type: 'prompt' } as ChatMessage], now)).toBeNull();
    expect(firstLivePermissionPrompt([{ id: 't', type: 'text' } as unknown as ChatMessage], now)).toBeNull();
  });
});

describe('usePermissionAnnouncer', () => {
  it('does NOT announce a prompt already present at mount (seed)', () => {
    render([permPrompt()]);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it('announces a newly-arriving permission prompt once, with a summary', () => {
    const tree = render([]);
    expect(announceMock).not.toHaveBeenCalled();
    update(tree, [permPrompt()]);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith('Permission requested: Bash(ls)');
    // A re-render with the same prompt does not re-announce.
    update(tree, [permPrompt()]);
    expect(announceMock).toHaveBeenCalledTimes(1);
  });

  it('does not announce an AskUserQuestion prompt (no requestId / expiresAt)', () => {
    const tree = render([]);
    update(tree, [{ id: 'q', type: 'prompt' } as ChatMessage]);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it('does not announce an answered or expired prompt', () => {
    const tree = render([]);
    update(tree, [permPrompt({ answered: 'allow' })]);
    update(tree, [permPrompt({ requestId: 'req-x', expiresAt: Date.now() - 1 })]);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it('announces a genuinely new prompt after the previous one resolves', () => {
    // Mount with a pending prompt (seeded → silent).
    const tree = render([permPrompt()]);
    expect(announceMock).not.toHaveBeenCalled();
    // It gets answered → ref clears.
    update(tree, [permPrompt({ answered: 'allow' })]);
    expect(announceMock).not.toHaveBeenCalled();
    // A new, different prompt arrives → announced.
    update(tree, [permPrompt({ answered: 'allow' }), permPrompt({ id: 'p2', requestId: 'req-2', tool: 'Edit', toolInput: { file_path: '/a/b/c.ts' } })]);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith('Permission requested: Edit(c.ts)');
  });
});
