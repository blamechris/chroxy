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

import { usePermissionAnnouncer } from '../../hooks/usePermissionAnnouncer';
// #5759 — the predicate now lives in store-core (shared with the dashboard).
import { firstLivePermissionPrompt } from '@chroxy/store-core';

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

function Harness({ messages, sessionKey }: { messages: ChatMessage[]; sessionKey: string }) {
  usePermissionAnnouncer(messages, sessionKey);
  return null;
}

function render(messages: ChatMessage[], sessionKey = 'A') {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Harness messages={messages} sessionKey={sessionKey} />);
  });
  return tree;
}

function update(tree: renderer.ReactTestRenderer, messages: ChatMessage[], sessionKey = 'A') {
  act(() => {
    tree.update(<Harness messages={messages} sessionKey={sessionKey} />);
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

  // #5760 review — more than one permission can be live at once (parallel SDK
  // tool calls). A second prompt arriving while the first is still live must
  // still announce (keying on the first-by-position would swallow it).
  it('announces a second concurrent prompt while the first is still live', () => {
    const tree = render([]);
    update(tree, [permPrompt({ requestId: 'req-1' })]);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenLastCalledWith('Permission requested: Bash(ls)');
    // Second prompt arrives; the first is STILL live (unanswered).
    update(tree, [
      permPrompt({ requestId: 'req-1' }),
      permPrompt({ id: 'p2', requestId: 'req-2', tool: 'Edit', toolInput: { file_path: '/x/y/z.ts' } }),
    ]);
    expect(announceMock).toHaveBeenCalledTimes(2);
    expect(announceMock).toHaveBeenLastCalledWith('Permission requested: Edit(z.ts)');
  });

  // #5760 review — ChatView isn't remounted on a tab-switch; it re-renders with
  // the destination session's messages. Switching to a session that ALREADY
  // has a live pending prompt must stay SILENT (re-seed on sessionKey change),
  // not announce a prompt that was pending before the user navigated to it.
  it('does NOT announce a pre-existing prompt when switching to another session', () => {
    // Active session A, no prompt.
    const tree = render([], 'A');
    expect(announceMock).not.toHaveBeenCalled();
    // Switch to session B, whose cache ALREADY holds a live prompt → silent.
    update(tree, [permPrompt({ requestId: 'req-B' })], 'B');
    expect(announceMock).not.toHaveBeenCalled();
    // A genuinely NEW prompt arriving in B (after the switch settled) announces.
    update(tree, [permPrompt({ requestId: 'req-B', answered: 'allow' }), permPrompt({ id: 'p3', requestId: 'req-B2', tool: 'Bash', toolInput: { command: 'rm x' } })], 'B');
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith('Permission requested: Bash(rm x)');
  });
});
