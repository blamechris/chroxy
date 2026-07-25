/**
 * WebFetch permission-card URL safety.
 *
 * The URL on a WebFetch permission prompt comes from `toolInput.url` — the
 * model's PROPOSED tool call, i.e. fully model-controlled content shown at
 * exactly the moment the user is being asked to approve it. Rendering it as
 * a tappable link with no scheme gate would hand an arbitrary scheme
 * (`file://`, `tel:`, `sms:`, `itms-apps://`, another app's custom scheme)
 * straight to the OS from a permission card.
 *
 * What matters here mirrors `WebToolResult.test.tsx`: an unsafe URL must
 * produce NO press handler at all — not a handler that merely declines to
 * open — while still being visible so the user can see what was asked for.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, Linking } from 'react-native';
import { renderPermissionDetail } from '../PermissionDetail';

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(el);
  });
  return root;
}

function renderWebFetch(toolInput: Record<string, unknown>): renderer.ReactTestRenderer {
  const el = renderPermissionDetail('WebFetch', toolInput);
  if (!el) throw new Error('expected a WebFetch permission detail element');
  return render(el);
}

function byTestId(root: renderer.ReactTestRenderer, id: string): ReactTestInstance[] {
  return root.root.findAllByProps({ testID: id });
}

/** The node that actually carries the press handler for `id`, if any. */
function pressableByTestId(root: renderer.ReactTestRenderer, id: string): ReactTestInstance | undefined {
  return byTestId(root, id).find((n) => typeof n.props.onPress === 'function');
}

/** Every node in the tree with a press handler — used to prove an unsafe URL
 *  leaves nothing tappable anywhere on the card. */
function allPressHandlers(root: renderer.ReactTestRenderer): ReactTestInstance[] {
  return root.root.findAll((n) => typeof n.props?.onPress === 'function', { deep: true });
}

/** Flatten RN's nested `children` into the concatenated string it renders. */
function textOf(node: ReactTestInstance | undefined): string {
  if (!node) return '';
  const walk = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(walk).join('');
    if (c && typeof c === 'object' && 'props' in (c as Record<string, unknown>)) {
      return walk((c as { props: { children?: unknown } }).props.children);
    }
    return '';
  };
  return walk(node.props.children);
}

beforeEach(() => {
  jest.restoreAllMocks();
  // RN mocks Linking.openURL as a shared jest.fn — clear leaked calls.
  jest.clearAllMocks();
});

describe('WebFetch permission detail — URL scheme gate', () => {
  const UNSAFE = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'tel:+15555550123',
    'sms:+15555550123',
    'itms-apps://apps.apple.com/app/id123456789',
    'chroxy://session/1',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example/x',
  ];

  it.each(UNSAFE)('renders %s as inert text with NO press handler', (url) => {
    const root = renderWebFetch({ url, prompt: 'Summarize this' });

    // Nothing is a link...
    expect(byTestId(root, 'permission-webfetch-url-link')).toHaveLength(0);
    // ...and nothing anywhere on the card is tappable.
    expect(allPressHandlers(root)).toHaveLength(0);

    // But the URL is still SHOWN — the user must be able to see exactly what
    // the model asked to fetch before approving or denying.
    const inert = byTestId(root, 'permission-webfetch-url-unsafe');
    expect(inert.length).toBeGreaterThan(0);
    expect(textOf(inert[0])).toBe(url);
  });

  it('does not open an unsafe URL even if a press is somehow dispatched', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const root = renderWebFetch({ url: 'file:///etc/passwd' });

    // There is no handler to dispatch — that IS the assertion.
    expect(allPressHandlers(root)).toHaveLength(0);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it.each(['https://example.com/page', 'http://example.com', 'HTTPS://Example.com/x'])(
    'renders %s as a tappable link',
    (url) => {
      const root = renderWebFetch({ url });
      expect(pressableByTestId(root, 'permission-webfetch-url-link')).toBeTruthy();
      expect(byTestId(root, 'permission-webfetch-url-unsafe')).toHaveLength(0);
    },
  );

  it('confirms with the FULL destination URL before opening a safe link', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const url = 'https://github.com/blamechris/chroxy';
    const root = renderWebFetch({ url, prompt: 'Summarize the README' });

    act(() => {
      pressableByTestId(root, 'permission-webfetch-url-link')!.props.onPress();
    });

    // Anti-phishing treatment (#6447): the full URL is shown, and nothing
    // opens until the user confirms.
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0]?.[1]).toBe(url);
    expect(openSpy).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    act(() => {
      buttons.find((b) => b.text === 'Open')!.onPress!();
    });
    expect(openSpy).toHaveBeenCalledWith(url);
  });

  it('still renders the prompt alongside an unsafe URL', () => {
    const root = renderWebFetch({ url: 'file:///etc/passwd', prompt: 'Read my secrets' });
    const texts = root.root.findAll((n) => typeof n.props?.children === 'string', { deep: true });
    expect(texts.some((n) => n.props.children === 'Read my secrets')).toBe(true);
  });

  it('renders nothing tappable when the URL is absent or not a string', () => {
    for (const toolInput of [{ prompt: 'p' }, { url: 42, prompt: 'p' }, { url: null }]) {
      const el = renderPermissionDetail('WebFetch', toolInput as Record<string, unknown>);
      if (!el) continue;
      const root = render(el);
      expect(allPressHandlers(root)).toHaveLength(0);
      expect(byTestId(root, 'permission-webfetch-url-link')).toHaveLength(0);
    }
  });
});
