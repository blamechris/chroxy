/**
 * MessageBubble permission-outcome record -- #8348
 *
 * A permission prompt that has ENDED is rebuilt, on a session switch or a reload,
 * from the server's durable `permission_outcome` history entry (the live card is
 * not replayed). MessageBubble renders it as a compact, non-interactive record:
 * "Permission expired - <tool>: <description> - dropped" for a prompt that ended
 * with no decision (the same line the dashboard shows), and an Allowed / Denied
 * line for an answered one. It must never offer Allow / Deny or a countdown.
 * #8392: retained/journaled input can be inspected without reopening decisions.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { StyleSheet, Text, TextInput } from 'react-native';
import { createDispatchTable, runDispatch, resetReplayReconcile } from '@chroxy/store-core';
import type { ClientStoreAdapter } from '@chroxy/store-core';
import { MessageBubble } from '../chat/MessageBubble';
import type { ChatMessage } from '../../store/types';

// Only state/transport boundaries are replaced. React hooks, MessageBubble,
// PermissionOutcomeRecord, the detail renderer and reconciliation run for real.
const mockRequestPermissionInput = jest.fn();
const mockStoreState = {
  sessions: [],
  serverCapabilities: { ide: false },
  permissionInputs: {},
  requestPermissionInput: mockRequestPermissionInput,
};
jest.mock('../../store/connection', () => ({
  useConnectionStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));
jest.mock('../../store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: (selector: (state: { connectionPhase: string }) => unknown) =>
    selector({ connectionPhase: 'connected' }),
}));

const trees: renderer.ReactTestRenderer[] = [];
beforeEach(() => {
  mockStoreState.serverCapabilities.ide = false;
  mockRequestPermissionInput.mockClear();
  resetReplayReconcile({ clearCursors: true });
});
afterEach(() => {
  act(() => trees.splice(0).forEach((tree) => tree.unmount()));
});

function makeOutcome(outcome: 'allowed' | 'denied' | 'expired' | 'stopped', overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'perm-out-1',
    type: 'prompt',
    content: 'Bash: Commit the restructured fix',
    tool: 'Bash',
    requestId: 'req-out-1',
    permissionOutcome: outcome,
    ...(outcome === 'allowed' ? { answered: 'allow' } : {}),
    ...(outcome === 'denied' ? { answered: 'deny' } : {}),
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessage;
}

function bubble(message: ChatMessage, onSelectOption = jest.fn()) {
  return <MessageBubble
    message={message}
    isSelected={false}
    isSelecting={false}
    onLongPress={() => {}}
    onPress={() => {}}
    onOpenDetail={() => {}}
    onSelectOption={onSelectOption}
  />;
}

function render(message: ChatMessage, onSelectOption = jest.fn()) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      bubble(message, onSelectOption),
    );
  });
  trees.push(tree);
  return tree;
}

function text(root: ReactTestInstance): string {
  const flatten = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(flatten).join('');
    if (value && typeof value === 'object' && 'props' in value) {
      return flatten((value as { props: { children?: unknown } }).props.children);
    }
    return '';
  };
  return root
    .findAllByType(Text)
    .map((node) => flatten(node.props.children))
    .join(' ');
}

describe('MessageBubble permission outcome record (#8348)', () => {
  it('renders an expired outcome as the dropped record', () => {
    const tree = render(makeOutcome('expired'));
    const record = tree.root.findByProps({ testID: 'permission-outcome-perm-out-1' });
    expect(record.props.accessibilityLabel).toBe('Permission expired — Bash: Commit the restructured fix — dropped');
    expect(text(tree.root)).toContain('Permission expired');
    expect(text(tree.root)).toContain('dropped');
  });

  it('#8374: renders a stopped outcome as its own record, neither Denied nor expired', () => {
    const tree = render(makeOutcome('stopped'));
    const record = tree.root.findByProps({ testID: 'permission-outcome-perm-out-1' });
    expect(record.props.accessibilityLabel).toBe('Permission stopped \u2014 Bash: Commit the restructured fix \u2014 not run');
    expect(text(tree.root)).toContain('Permission stopped');
    expect(text(tree.root)).not.toMatch(/Denied|expired/);
  });

  it('renders allowed and denied outcomes with their decision', () => {
    expect(text(render(makeOutcome('allowed')).root)).toMatch(/Allowed: Bash: Commit the restructured fix/);
    expect(text(render(makeOutcome('denied')).root)).toMatch(/Denied: Bash: Commit the restructured fix/);
  });

  it('offers no controls: no Allow/Deny, no countdown, no expand', () => {
    for (const outcome of ['allowed', 'denied', 'expired', 'stopped'] as const) {
      const tree = render(makeOutcome(outcome));
      expect(tree.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
      expect(tree.root.findAllByProps({ accessibilityRole: 'timer' })).toHaveLength(0);
      expect(text(tree.root)).not.toMatch(/Action Required|Tap to expand/);
    }
  });

  it('is a record even if a stray expiresAt is left on it', () => {
    const tree = render(makeOutcome('expired', { expiresAt: Date.now() + 60_000 }));
    expect(tree.root.findAllByProps({ testID: 'permission-outcome-perm-out-1' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ accessibilityRole: 'timer' })).toHaveLength(0);
  });

  it('#8503: a record that holds its journaled tool input is still the compact record, not a full detail card', () => {
    const tree = render(makeOutcome('allowed', { toolInput: { command: 'touch smoke-perm.txt' } }));
    expect(tree.root.findAllByProps({ testID: 'permission-outcome-perm-out-1' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'approval-card-perm-out-1' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityRole: 'timer' })).toHaveLength(0);
  });

  it('POSITIVE CONTROL: a live prompt with no outcome still shows its countdown', () => {
    const live = {
      id: 'perm-live', type: 'prompt', content: 'Bash: ls', tool: 'Bash', requestId: 'req-live',
      options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
      expiresAt: Date.now() + 60_000, timestamp: Date.now(),
    } as ChatMessage;
    const tree = render(live);
    expect(tree.root.findAllByProps({ testID: 'permission-outcome-perm-live' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityRole: 'timer' }).length).toBeGreaterThan(0);
  });
});

type Outcome = 'allowed' | 'denied' | 'expired' | 'stopped';
interface TestSession { sessionId: string; messages: ChatMessage[] }

/** Real permission_outcome dispatch, with only an in-memory client adapter. */
function replayOutcome(held: ChatMessage[], outcome: Outcome, tool: string, input?: Record<string, unknown>) {
  let session: TestSession = { sessionId: 's1', messages: held };
  const addMessage = jest.fn();
  const pushSessionNotification = jest.fn();
  const adapter = {
    getActiveSessionId: () => 's1',
    hasSession: (id: string) => id === 's1',
    updateSession: (_id: string, update: (value: TestSession) => Partial<TestSession>) => {
      session = { ...session, ...update(session) };
    },
    addMessage,
    pushSessionNotification,
  } as unknown as ClientStoreAdapter<TestSession>;
  expect(runDispatch(createDispatchTable<TestSession>(), {
    type: 'permission_outcome', sessionId: 's1', requestId: 'req-out-1',
    tool, description: 'Inspect this proposal', outcome, input,
  }, adapter)).toBe(true);
  expect(addMessage).not.toHaveBeenCalled();
  expect(pushSessionNotification).not.toHaveBeenCalled();
  expect(session.messages).toHaveLength(1);
  return session.messages[0]!;
}

function toggle(tree: renderer.ReactTestRenderer, id: string) {
  const control = tree.root.findAll((node) =>
    node.props.testID === `permission-outcome-${id}` && typeof node.props.onPress === 'function',
  )[0];
  expect(control).toBeDefined();
  act(() => control!.props.onPress());
}

function expectReadOnly(tree: renderer.ReactTestRenderer) {
  expect(tree.root.findAll((node) => /^approval-button-/.test(node.props.testID ?? ''))).toHaveLength(0);
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  expect(tree.root.findAllByProps({ accessibilityRole: 'timer' })).toHaveLength(0);
  expect(text(tree.root)).not.toMatch(/Action Required|Permission expires|Timed out|Approve|Deny|Send/);
}

describe('MessageBubble terminal permission inspection (#8392)', () => {
  const writeInput = { file_path: '/fixture/proposal.ts', content: 'const proposedWrite = "held proposal";' };
  const editInput = { file_path: '/fixture/proposal.ts', old_string: 'old proposal', new_string: 'new proposal' };

  it('keeps a held Write inspectable after real permission_outcome reconciliation', () => {
    const onSelect = jest.fn();
    const held = makeOutcome('allowed', {
      permissionOutcome: undefined, answered: 'allow', tool: 'Write', toolInput: writeInput,
      content: 'Write: Inspect this proposal',
      options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
      expiresAt: Date.now() + 60_000,
    });
    const tree = render(held, onSelect);
    // The ordinary answered permission starts as its existing expandable pill.
    expect(tree.root.findAllByProps({ testID: `permission-outcome-${held.id}` })).toHaveLength(0);
    expect(text(tree.root)).toContain('Allowed: Write(proposal.ts)');

    const record = replayOutcome([held], 'allowed', 'Write');
    expect(record.id).toBe(held.id);
    expect(record.toolInput).toBe(writeInput);
    expect(record.options).toBeUndefined();
    act(() => tree.update(bubble(record, onSelect)));
    const before = JSON.stringify(record);
    expect(text(tree.root)).toContain('Allowed: Write: Inspect this proposal');
    expect(text(tree.root)).not.toContain('held proposal');
    expectReadOnly(tree);

    toggle(tree, record.id);
    expect(text(tree.root)).toContain('/fixture/proposal.ts');
    expect(text(tree.root)).toContain('const proposedWrite = "held proposal";');
    expect(text(tree.root)).toContain('Allowed: Write: Inspect this proposal');
    expectReadOnly(tree);
    toggle(tree, record.id);
    expect(text(tree.root)).not.toContain('held proposal');
    toggle(tree, record.id);
    expect(text(tree.root)).toContain('held proposal');
    expectReadOnly(tree);
    expect(onSelect).not.toHaveBeenCalled();
    expect(mockRequestPermissionInput).not.toHaveBeenCalled();
    expect(JSON.stringify(record)).toBe(before);
  });

  it.each(['allowed', 'denied', 'expired', 'stopped'] as const)(
    'preserves %s while inspecting fresh journaled Write/Edit records', (outcome) => {
      for (const [tool, input, expected] of [
        ['Write', writeInput, ['Content', 'held proposal']],
        ['Edit', editInput, ['Changes', '-old proposal', '+new proposal']],
      ] as const) {
        const record = replayOutcome([], outcome, tool, input);
        const onSelect = jest.fn();
        const tree = render({ ...record,
          // Terminal authority must still win over leftover live fields or a
          // conflicting local answer. Expired/stopped normally have no answer.
          options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
          expiresAt: Date.now() + 60_000,
          answered: outcome === 'allowed' ? 'deny' : outcome === 'denied' ? 'allow' : undefined,
        }, onSelect);
        const label = outcome === 'expired' ? 'Permission expired — Write: Inspect this proposal — dropped'
          : outcome === 'stopped' ? 'Permission stopped — Write: Inspect this proposal — not run'
          : `${outcome === 'allowed' ? 'Allowed' : 'Denied'}: Write: Inspect this proposal`;
        const expectedLabel = label.replace('Write:', `${tool}:`);
        const header = () => tree.root.findAll((node) =>
          node.props.testID === `permission-outcome-${record.id}` && typeof node.props.onPress === 'function',
        )[0]!;
        expect(header().props.accessibilityLabel).toBe(expectedLabel);
        expect(header().props.accessibilityState).toEqual({ expanded: false });
        expect(header().props.accessibilityHint).toMatch(/details/i);
        const style = StyleSheet.flatten(header().props.style);
        expect(style.minHeight).toBeGreaterThanOrEqual(44);
        expect(text(tree.root)).not.toContain(expected[1]);
        expectReadOnly(tree);
        toggle(tree, record.id);
        expect(header().props.accessibilityState).toEqual({ expanded: true });
        expect(header().props.accessibilityLabel).toBe(expectedLabel);
        for (const value of expected) expect(text(tree.root)).toContain(value);
        expectReadOnly(tree);
        toggle(tree, record.id);
        expect(header().props.accessibilityState).toEqual({ expanded: false });
        expect(text(tree.root)).not.toContain(expected[1]);
        expectReadOnly(tree);
        expect(onSelect).not.toHaveBeenCalled();
        expect(mockRequestPermissionInput).not.toHaveBeenCalled();
      }
    },
  );

  it('does not make inputless legacy records or empty inputs expandable', () => {
    for (const toolInput of [undefined, {}]) {
      const tree = render(makeOutcome('allowed', { toolInput }));
      expect(tree.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
      expectReadOnly(tree);
    }
  });

  it.each(['allow', 'deny'])('preserves the ordinary live answered %s pill', (answered) => {
    mockStoreState.serverCapabilities.ide = true;
    const tree = render(makeOutcome('allowed', { permissionOutcome: undefined, answered, tool: 'Write', toolInput: writeInput }));
    expect(tree.root.findAllByProps({ testID: 'permission-outcome-perm-out-1' })).toHaveLength(0);
    expect(text(tree.root)).toContain(`${answered === 'allow' ? 'Allowed' : 'Denied'}: Write(proposal.ts)`);
    expect(tree.root.findAll((node) => typeof node.props.onPress === 'function' &&
      /Tap to expand/.test(node.props.accessibilityLabel ?? '')).length).toBeGreaterThan(0);
    expect(mockRequestPermissionInput).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: a live pending permission is still actionable', () => {
    mockStoreState.serverCapabilities.ide = true;
    const onSelect = jest.fn();
    const tree = render(makeOutcome('allowed', {
      permissionOutcome: undefined, answered: undefined, tool: 'Write', toolInput: writeInput,
      options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
      expiresAt: Date.now() + 60_000,
    }), onSelect);
    expect(tree.root.findAllByProps({ accessibilityRole: 'timer' }).length).toBeGreaterThan(0);
    expect(mockRequestPermissionInput).toHaveBeenCalledTimes(1);
    expect(mockRequestPermissionInput).toHaveBeenCalledWith('req-out-1');
    const allow = tree.root.findAll((node) => node.props.testID === 'approval-button-allow' &&
      typeof node.props.onPress === 'function')[0]!;
    expect(allow.props.accessibilityState.disabled).toBe(false);
    act(() => allow.props.onPress());
    expect(onSelect).toHaveBeenCalledWith('allow', 'perm-out-1', 'req-out-1', undefined, null);
  });

  it('stops live controls and input reads when a held pending Write becomes terminal', () => {
    mockStoreState.serverCapabilities.ide = true;
    const onSelect = jest.fn();
    const held = makeOutcome('stopped', {
      permissionOutcome: undefined, answered: undefined, tool: 'Write', toolInput: writeInput,
      options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
      expiresAt: Date.now() + 60_000,
    });
    const tree = render(held, onSelect);
    expect(mockRequestPermissionInput).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByProps({ testID: 'approval-button-allow' }).length).toBeGreaterThan(0);
    const record = replayOutcome([held], 'stopped', 'Write');
    expect(record.answered).toBeUndefined();
    act(() => tree.update(bubble(record, onSelect)));
    expect(text(tree.root)).toContain('Permission stopped');
    expectReadOnly(tree);
    toggle(tree, record.id);
    expect(text(tree.root)).toContain('held proposal');
    expectReadOnly(tree);
    expect(mockRequestPermissionInput).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(['allowed', 'denied', 'expired', 'stopped'] as const)(
    'never reads live IDE input when mounting or inspecting a terminal %s record', (outcome) => {
      mockStoreState.serverCapabilities.ide = true;
      const record = replayOutcome([], outcome, 'Write', writeInput);
      // All terminal states must be inert independently of `answered`. In
      // particular expired/stopped normally have no answer at all (#8374).
      const tree = render({ ...record, answered: undefined });
      expect(mockRequestPermissionInput).not.toHaveBeenCalled();
      toggle(tree, record.id);
      toggle(tree, record.id);
      expect(mockRequestPermissionInput).not.toHaveBeenCalled();
      expectReadOnly(tree);
    },
  );
});
