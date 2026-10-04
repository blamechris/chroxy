/**
 * AuthRequiredChip tests — #8223
 *
 * Mobile companion to the dashboard chip: the registry headline, the server's
 * message as selectable body text, and the login command as selectable text.
 * No Retry control (signing in on the host is the only fix), hence no button
 * and no tap-target to size.
 *
 * react-test-renderer + act, like StreamStallChip.test.tsx.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { getErrorPresentation, CLAUDE_LOGIN_COMMAND } from '@chroxy/store-core';
import { AuthRequiredChip } from '../AuthRequiredChip';

const SERVER_TEXT =
  'Claude is not logged in on this host, or its login expired. Run `claude auth login` in a terminal on the host (or `/login` inside claude), then retry.';

function textOf(node: ReactTestInstance): string {
  const c = node.props.children;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join('');
  return '';
}

describe('AuthRequiredChip (#8223)', () => {
  let tree: renderer.ReactTestRenderer | null = null;

  afterEach(() => {
    if (tree) {
      act(() => { tree!.unmount(); });
      tree = null;
    }
  });

  function render(errorText: string): renderer.ReactTestRenderer {
    act(() => { tree = renderer.create(<AuthRequiredChip errorText={errorText} />); });
    return tree!;
  }

  it('renders the registry headline, the server message and the login command', () => {
    const t = render(SERVER_TEXT);
    expect(textOf(t.root.findByProps({ testID: 'auth-required-chip-headline' })))
      .toBe(getErrorPresentation('AUTH_REQUIRED').headline);
    expect(textOf(t.root.findByProps({ testID: 'auth-required-chip-body' }))).toBe(SERVER_TEXT);
    expect(textOf(t.root.findByProps({ testID: 'auth-required-chip-command' }))).toBe(CLAUDE_LOGIN_COMMAND);
    expect(CLAUDE_LOGIN_COMMAND).toBe('claude auth login');
  });

  it('makes the message and the command selectable so they can be copied', () => {
    const t = render(SERVER_TEXT);
    expect(t.root.findByProps({ testID: 'auth-required-chip-body' }).props.selectable).toBe(true);
    expect(t.root.findByProps({ testID: 'auth-required-chip-command' }).props.selectable).toBe(true);
  });

  it('announces assertively as an alert and keeps the raw server text as the a11y hint', () => {
    const t = render(SERVER_TEXT);
    const chip = t.root.findByProps({ testID: 'auth-required-chip' });
    expect(chip.props.accessibilityRole).toBe('alert');
    expect(chip.props.accessibilityLiveRegion).toBe('assertive');
    expect(chip.props.accessibilityLabel).toBe(getErrorPresentation('AUTH_REQUIRED').headline);
    expect(chip.props.accessibilityHint).toBe(SERVER_TEXT);
  });

  it('offers no Retry and no other pressable control', () => {
    const t = render(SERVER_TEXT);
    expect(t.root.findAll((n) => typeof n.props.onPress === 'function')).toHaveLength(0);
    // The server prose ends "then retry." — it is a Retry BUTTON that must be absent.
    const labels = t.root.findAllByType(Text).map(textOf);
    expect(labels).not.toContain('Retry');
  });

  it('omits the body line when the server text is empty', () => {
    const t = render('   ');
    expect(t.root.findAllByProps({ testID: 'auth-required-chip-body' })).toHaveLength(0);
    expect(textOf(t.root.findByProps({ testID: 'auth-required-chip-command' }))).toBe('claude auth login');
  });
});
