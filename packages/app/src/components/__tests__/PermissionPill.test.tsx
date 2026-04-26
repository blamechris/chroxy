/**
 * Regression tests for issue #3078:
 * Tool result label inconsistent — most show 'Allowed', one shows 'Resolved'.
 *
 * Root cause: history_replay_end marks any prompt that was unanswered at the
 * time of replay with the opaque value `'(resolved)'` (see
 * packages/app/src/store/message-handler.ts:1192). The mobile app's
 * PermissionPill previously rendered that as "Resolved" while the live
 * `permission_resolved` path stamped one of `'allow' | 'allowAlways' |
 * 'allowSession'` and rendered as "Allowed". When a single permission's
 * resolution event was lost over a flaky reconnect, the user saw a stray
 * "Resolved" pill in an otherwise uniform "Allowed" sequence.
 *
 * Fix: collapse the label space to {Allowed, Denied}. This matches the
 * dashboard's PermissionPrompt rendering (see
 * packages/dashboard/src/components/PermissionPrompt.tsx:221).
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { PermissionPill } from '../PermissionDetail';
import type { ChatMessage } from '../../store/types';

function makePromptMessage(answered: string | undefined): ChatMessage {
  return {
    id: 'perm-test',
    type: 'prompt',
    content: 'Bash: ls',
    tool: 'Bash',
    requestId: 'req-test',
    toolInput: { command: 'ls' },
    answered,
    timestamp: Date.now(),
  } as ChatMessage;
}

function renderPill(answered: string | undefined): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <PermissionPill
        message={makePromptMessage(answered)}
        onExpand={() => {}}
      />,
    );
  });
  return root;
}

function collectVisibleText(root: ReactTestInstance): string {
  const texts = root.findAllByType(Text).map((node) => {
    const children = node.props.children;
    if (typeof children === 'string') return children;
    if (typeof children === 'number') return String(children);
    if (Array.isArray(children)) {
      return children
        .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
        .join('');
    }
    return '';
  });
  return texts.join(' ');
}

describe('PermissionPill — issue #3078 label normalization', () => {
  it.each([
    ['allow'],
    ['allowAlways'],
    ['allowSession'],
  ])('renders "%s" answered as "Allowed"', (answered) => {
    const tree = renderPill(answered);
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Allowed');
    expect(text).not.toContain('Denied');
  });

  it('renders "deny" answered as "Denied"', () => {
    const tree = renderPill('deny');
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Denied');
    expect(text).not.toContain('Allowed');
    expect(text).not.toContain('Resolved');
  });

  // Core regression: history_replay_end stamps `'(resolved)'`. Without the
  // fix, this rendered as "Resolved" while live-resolved peers rendered as
  // "Allowed", producing the visible inconsistency in the user's screenshot.
  it('renders the "(resolved)" replay sentinel as "Allowed" (not "Resolved")', () => {
    const tree = renderPill('(resolved)');
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Allowed');
    expect(text).not.toContain('Resolved');
  });

  // Defensive: any other unknown decision string from a future server should
  // also render as "Allowed" rather than fall through to a stale label.
  it('renders unknown answered values as "Allowed"', () => {
    const tree = renderPill('approved-by-rule-engine');
    const text = collectVisibleText(tree.root);
    expect(text).toContain('Allowed');
    expect(text).not.toContain('Resolved');
  });
});
