/**
 * FolderTrustBanner (mobile) — states, snapshot semantics and the read-only cases.
 * Mirrors the dashboard banner's tests; plain react-test-renderer + act.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import type { FolderTrustEntry } from '@chroxy/store-core';
import { FolderTrustBanner } from '../FolderTrustBanner';

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);

const summary = (over: Record<string, unknown> = {}): NonNullable<FolderTrustEntry['summary']> => ({
  files: [{ path: '/proj/.mcp.json' }, { path: '/proj/.claude/settings.json', linkTarget: '/elsewhere/settings.json' }],
  mcpServers: [{ file: '/proj/.mcp.json', name: 'srv', command: 'npx', args: ['-y', 'x'], envKeys: ['TOKEN'] }],
  hooks: [{ file: '/proj/.claude/settings.json', event: 'PreToolUse', commands: ['./check.sh'] }],
  statusLine: [{ file: '/proj/.claude/settings.json', command: './status.sh' }],
  enabledPlugins: [{ file: '/proj/.claude/settings.json', plugin: 'tool@market' }],
  counts: { agents: 1, skills: 2, commands: 0 },
  warnings: ['One file is a symlink'],
  hasCommandBearingFiles: true,
  untrustable: false,
  ...over,
});
const untrusted = (over: Partial<FolderTrustEntry> = {}): FolderTrustEntry => ({
  status: 'untrusted', appliesFrom: 'next_turn', summary: summary(), digest: D1, ...over,
});

interface Props { entry: FolderTrustEntry | null | undefined; pending?: boolean; error?: string | null }
function mount(props: Props) {
  const onTrust = jest.fn();
  const onUntrust = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<FolderTrustBanner {...props} onTrust={onTrust} onUntrust={onUntrust} />);
  });
  const rerender = (next: Props) => act(() => {
    tree.update(<FolderTrustBanner {...next} onTrust={onTrust} onUntrust={onUntrust} />);
  });
  // The outermost match is the composite element the component rendered (it carries the props).
  const find = (id: string): ReactTestInstance | null => tree.root.findAll((n) => n.props.testID === id)[0] ?? null;
  const findAll = (id: string): ReactTestInstance[] => tree.root.findAll((n) => n.props.testID === id && n.type === Text);
  const press = (id: string) => { act(() => { find(id)!.props.onPress(); }); };
  const text = (id: string): string => {
    const node = find(id);
    if (!node) return '';
    const out: string[] = [];
    const walk = (n: ReactTestInstance | string) => {
      if (typeof n === 'string') { out.push(n); return; }
      n.children.forEach(walk);
    };
    walk(node);
    return out.join('');
  };
  return { tree, rerender, find, findAll, press, text, onTrust, onUntrust };
}

describe('FolderTrustBanner', () => {
  it('renders nothing without an entry, with appliesFrom n/a, or while the daemon has not said', () => {
    expect(mount({ entry: null }).tree.toJSON()).toBeNull();
    expect(mount({ entry: undefined }).tree.toJSON()).toBeNull();
    expect(mount({ entry: { status: 'trusted', appliesFrom: 'n/a' } }).tree.toJSON()).toBeNull();
    expect(mount({ entry: { status: 'untrusted', appliesFrom: 'n/a', summary: summary(), digest: D1 } }).tree.toJSON()).toBeNull();
  });

  describe('untrusted', () => {
    it('shows the strip with Review and no dialog content yet', () => {
      const m = mount({ entry: untrusted() });
      expect(m.text('folder-trust-banner')).toContain("This folder's project settings are not loaded.");
      expect(m.find('folder-trust-review')).not.toBeNull();
      expect(m.find('folder-trust-dialog')).toBeNull();
      expect(m.find('folder-trust-still-loaded')).toBeNull();
    });

    it('notes that a running session keeps project settings loaded when launchedWithProject is true', () => {
      const m = mount({ entry: untrusted({ launchedWithProject: true }) });
      expect(m.find('folder-trust-still-loaded')).not.toBeNull();
      expect(mount({ entry: untrusted({ launchedWithProject: false }) }).find('folder-trust-still-loaded')).toBeNull();
    });

    it('Review opens a dialog listing what would run', () => {
      const m = mount({ entry: untrusted() });
      m.press('folder-trust-review');
      expect(m.find('folder-trust-dialog')).not.toBeNull();
      expect(m.text('folder-trust-mcp-server')).toBe('srv npx -y x (sets environment: TOKEN)');
      expect(m.text('folder-trust-hook')).toContain('PreToolUse');
      expect(m.text('folder-trust-hook')).toContain('./check.sh');
      expect(m.text('folder-trust-status-line')).toBe('./status.sh');
      expect(m.text('folder-trust-plugin')).toBe('tool@market');
      expect(m.text('folder-trust-counts')).toBe('1 agent file, 2 skill files, 0 command files');
      expect(m.findAll('folder-trust-file')).toHaveLength(2);
      expect(m.text('folder-trust-warnings')).toContain('One file is a symlink');
      expect(m.text('folder-trust-warning')).toContain('lets these settings run');
      expect(m.text('folder-trust-applies')).toBe('Applies from the next turn');
      expect(m.find('folder-trust-no-commands')).toBeNull();
      expect(m.find('folder-trust-readonly')).toBeNull();
    });

    it('says so when nothing command-bearing was found', () => {
      const m = mount({ entry: untrusted({ summary: summary({ mcpServers: [], hooks: [], statusLine: [], enabledPlugins: [], counts: { agents: 0, skills: 0, commands: 0 }, files: [], warnings: [], hasCommandBearingFiles: false }) }) });
      m.press('folder-trust-review');
      expect(m.find('folder-trust-no-commands')).not.toBeNull();
      expect(m.find('folder-trust-counts')).toBeNull();
      expect(m.find('folder-trust-mcp-server')).toBeNull();
    });

    it('Trust sends the digest of the reviewed snapshot', () => {
      const m = mount({ entry: untrusted() });
      m.press('folder-trust-review');
      m.press('folder-trust-confirm');
      expect(m.onTrust).toHaveBeenCalledWith(D1);
    });

    it('Cancel closes the dialog without trusting', () => {
      const m = mount({ entry: untrusted() });
      m.press('folder-trust-review');
      m.press('folder-trust-cancel');
      expect(m.find('folder-trust-dialog')).toBeNull();
      expect(m.onTrust).not.toHaveBeenCalled();
    });

    it('a newer frame with another digest warns, disables Trust, and keeps showing the reviewed snapshot', () => {
      const m = mount({ entry: untrusted() });
      m.press('folder-trust-review');
      m.rerender({ entry: untrusted({ digest: D2, summary: summary({ mcpServers: [{ file: 'f', name: 'newer', command: 'evil' }] }) }) });
      expect(m.find('folder-trust-changed')).not.toBeNull();
      expect(m.find('folder-trust-warning')).toBeNull();
      expect(m.text('folder-trust-mcp-server')).toContain('srv');
      expect(m.text('folder-trust-mcp-server')).not.toContain('newer');
      expect(m.find('folder-trust-confirm')!.props.disabled).toBe(true);
    });

    it('Reload re-takes the snapshot, so Trust then sends the NEW digest', () => {
      const m = mount({ entry: untrusted() });
      m.press('folder-trust-review');
      m.rerender({ entry: untrusted({ digest: D2 }) });
      m.press('folder-trust-reload');
      expect(m.find('folder-trust-changed')).toBeNull();
      expect(m.find('folder-trust-confirm')!.props.disabled).toBe(false);
      m.press('folder-trust-confirm');
      expect(m.onTrust).toHaveBeenCalledWith(D2);
    });

    it('a frame with the same digest does not raise the changed notice', () => {
      const m = mount({ entry: untrusted() });
      m.press('folder-trust-review');
      m.rerender({ entry: untrusted({ appliesFrom: 'restart' }) });
      expect(m.find('folder-trust-changed')).toBeNull();
      expect(m.text('folder-trust-applies')).toBe('Applies from the next turn');
    });

    it('is read-only without a summary and digest (a session-bound client)', () => {
      const m = mount({ entry: { status: 'untrusted', appliesFrom: 'next_turn' } });
      m.press('folder-trust-review');
      expect(m.find('folder-trust-readonly')).not.toBeNull();
      expect(m.find('folder-trust-confirm')).toBeNull();
      expect(m.find('folder-trust-warning')).toBeNull();
      expect(m.find('folder-trust-cancel')).not.toBeNull();
    });

    it('is read-only for an untrustable folder', () => {
      const m = mount({ entry: untrusted({ summary: summary({ untrustable: true }) }) });
      m.press('folder-trust-review');
      expect(m.find('folder-trust-readonly')).not.toBeNull();
      expect(m.find('folder-trust-confirm')).toBeNull();
    });

    it('shows the restart wording for restart providers', () => {
      const m = mount({ entry: untrusted({ appliesFrom: 'restart' }) });
      m.press('folder-trust-review');
      expect(m.text('folder-trust-applies')).toBe('Restart the session to apply');
    });

    it('shows a failure reason in the dialog and disables Trust while a change is in flight', () => {
      const m = mount({ entry: untrusted(), error: 'Only the owner can do that' });
      m.press('folder-trust-review');
      expect(m.text('folder-trust-error')).toBe('Only the owner can do that');
      m.rerender({ entry: untrusted(), pending: true });
      expect(m.find('folder-trust-confirm')!.props.disabled).toBe(true);
    });

    it('closes the dialog once the folder becomes trusted', () => {
      const m = mount({ entry: untrusted() });
      m.press('folder-trust-review');
      m.rerender({ entry: { status: 'trusted', appliesFrom: 'next_turn' } });
      expect(m.find('folder-trust-dialog')).toBeNull();
      expect(m.find('folder-trust-trusted')).not.toBeNull();
    });
  });

  describe('trusted', () => {
    it('shows the strip with Stop trusting, the applies text and any error', () => {
      const m = mount({ entry: { status: 'trusted', appliesFrom: 'restart' }, error: 'nope' });
      expect(m.text('folder-trust-trusted')).toContain('Project settings for this folder are trusted.');
      expect(m.text('folder-trust-applies')).toBe('Restart the session to apply');
      expect(m.text('folder-trust-error')).toBe('nope');
      m.press('folder-trust-untrust');
      expect(m.onUntrust).toHaveBeenCalledTimes(1);
    });

    it('disables Stop trusting while a change is in flight', () => {
      const m = mount({ entry: { status: 'trusted', appliesFrom: 'next_turn' }, pending: true });
      expect(m.find('folder-trust-untrust')!.props.disabled).toBe(true);
    });
  });

  describe('accessibility and tap targets', () => {
    const buttonIds = ['folder-trust-review', 'folder-trust-reload', 'folder-trust-cancel', 'folder-trust-confirm', 'folder-trust-untrust'];

    it('every button has role, label and a tap target of at least 44pt', () => {
      const seen: string[] = [];
      const check = (m: ReturnType<typeof mount>) => {
        for (const id of buttonIds) {
          const node = m.find(id);
          if (!node) continue;
          seen.push(id);
          expect(node.props.accessibilityRole).toBe('button');
          expect(typeof node.props.accessibilityLabel).toBe('string');
          const style = StyleSheet.flatten(node.props.style) as { minHeight?: number; minWidth?: number };
          expect(style.minHeight).toBeGreaterThanOrEqual(44);
          expect(style.minWidth).toBeGreaterThanOrEqual(44);
        }
      };
      const u = mount({ entry: untrusted() });
      check(u);
      u.press('folder-trust-review');
      u.rerender({ entry: untrusted({ digest: D2 }) });
      check(u);
      check(mount({ entry: { status: 'trusted', appliesFrom: 'next_turn' } }));
      // control: every button was actually examined (a loop over nothing proves nothing)
      expect(new Set(seen)).toEqual(new Set(buttonIds));
    });

    it('keeps the warning, error and buttons outside the scrolling summary', () => {
      const m = mount({ entry: untrusted(), error: 'x' });
      m.press('folder-trust-review');
      const scroll = m.find('folder-trust-summary-scroll')!;
      const inside = (id: string) => scroll.findAll((n) => n.props.testID === id).length > 0;
      for (const id of ['folder-trust-warning', 'folder-trust-error', 'folder-trust-confirm', 'folder-trust-cancel', 'folder-trust-applies']) {
        expect(m.find(id)).not.toBeNull();
        expect(inside(id)).toBe(false);
      }
      expect(inside('folder-trust-summary')).toBe(true);
    });
  });
});
