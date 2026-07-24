/**
 * Tests for the mobile WebSearch/WebFetch structured renderers (#6982).
 *
 * Mirrors the dashboard coverage in
 * `packages/dashboard/src/components/WebToolResult.test.tsx`. The parsing
 * itself lives in (and is tested by) `@chroxy/store-core`; what matters
 * here is the RN render layer's contract:
 *
 *   - routing (raw tool name in, structured shape out, `null` → the
 *     caller's existing flat-text fallback),
 *   - link SAFETY — an unsafe URL must produce no press handler at all,
 *     not merely a handler that declines to open,
 *   - never throwing on malformed input.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, Linking, StyleSheet } from 'react-native';
import type { ParsedWebSearchResults, ParsedWebFetchResult } from '@chroxy/store-core';
import {
  WebSearchResultList,
  WebFetchResult,
  WebToolResultView,
  parseWebToolResult,
  openWebResultUrl,
  domainFromUrl,
} from '../chat/WebToolResult';

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(el);
  });
  return root;
}

function byTestId(root: renderer.ReactTestRenderer, id: string): ReactTestInstance[] {
  return root.root.findAllByProps({ testID: id });
}

/** The node that actually carries the press handler for `id`, if any. */
function pressableByTestId(root: renderer.ReactTestRenderer, id: string): ReactTestInstance | undefined {
  return byTestId(root, id).find((n) => typeof n.props.onPress === 'function');
}

/** Every node in the tree that has a press handler — used to prove that an
 *  unsafe result produces NO tappable element whatsoever. */
function allPressHandlers(root: renderer.ReactTestRenderer): ReactTestInstance[] {
  return root.root.findAll((n) => typeof n.props?.onPress === 'function', { deep: true });
}

const SAFE_SEARCH: ParsedWebSearchResults = {
  query: 'chroxy remote terminal',
  results: [
    {
      title: 'chroxy — remote terminal for Claude Code',
      url: 'https://github.com/blamechris/chroxy',
      snippet: 'Run a lightweight daemon on your dev machine.',
    },
    { title: 'Docs', url: 'https://www.example.com:8443/docs' },
  ],
};

beforeEach(() => {
  jest.restoreAllMocks();
  // RN mocks Linking.openURL as a shared jest.fn — clear leaked calls.
  jest.clearAllMocks();
});

describe('parseWebToolResult routing', () => {
  const searchJson = JSON.stringify({
    query: 'q',
    results: [{ title: 'T', url: 'https://example.com/a', snippet: 'S' }],
  });

  it('routes WebSearch (and its separator variants) to the search shape', () => {
    for (const tool of ['WebSearch', 'web_search', 'web-search', 'websearch']) {
      const parsed = parseWebToolResult(tool, searchJson);
      expect(parsed?.kind).toBe('search');
    }
  });

  it('routes WebFetch to the fetch shape and splits the executor header', () => {
    const text = 'Prompt: Summarize\nURL: https://example.com/p\n\n# Body';
    const parsed = parseWebToolResult('WebFetch', text);
    expect(parsed?.kind).toBe('fetch');
    if (parsed?.kind !== 'fetch') throw new Error('expected fetch');
    expect(parsed.fetch.url).toBe('https://example.com/p');
    expect(parsed.fetch.content).toBe('# Body');
  });

  it('returns null for unrelated tools so the caller keeps its flat-text render', () => {
    expect(parseWebToolResult('Bash', searchJson)).toBeNull();
    expect(parseWebToolResult('TodoWrite', searchJson)).toBeNull();
    // `fetch` must NOT cross-match WebFetch (store-core scoping decision).
    expect(parseWebToolResult('fetch', 'some text')).toBeNull();
  });

  it('returns null for a missing/empty result (tool still in flight)', () => {
    expect(parseWebToolResult('WebSearch', undefined)).toBeNull();
    expect(parseWebToolResult('WebSearch', null)).toBeNull();
    expect(parseWebToolResult('WebSearch', '')).toBeNull();
  });

  it('returns null — not a throw — for malformed WebSearch payloads', () => {
    expect(parseWebToolResult('WebSearch', '{"results":[')).toBeNull();
    expect(parseWebToolResult('WebSearch', 'total garbage, no links here')).toBeNull();
    expect(parseWebToolResult('WebSearch', JSON.stringify({ results: [] }))).toBeNull();
  });

  it('drops results whose URL fails the scheme allowlist', () => {
    // Mirrors the `show-websearch` mock fixture, whose third result is a
    // deliberate `javascript:` entry.
    const payload = JSON.stringify({
      results: [
        { title: 'ok', url: 'https://example.com/ok' },
        { title: 'xss', url: 'javascript:alert(1)' },
        { title: 'proto-relative', url: '//evil.example/x' },
        { title: 'data', url: 'data:text/html,<script>alert(1)</script>' },
      ],
    });
    const parsed = parseWebToolResult('WebSearch', payload);
    if (parsed?.kind !== 'search') throw new Error('expected search');
    expect(parsed.search.results).toHaveLength(1);
    expect(parsed.search.results[0]?.url).toBe('https://example.com/ok');
  });
});

describe('domainFromUrl', () => {
  it('strips www and the port', () => {
    expect(domainFromUrl('https://www.example.com/a/b')).toBe('example.com');
    expect(domainFromUrl('https://example.com:8443/x')).toBe('example.com');
  });

  it('shows the REAL host when userinfo is used to spoof a prefix', () => {
    expect(domainFromUrl('https://github.com@evil.example/x')).toBe('evil.example');
  });

  it('terminates the authority on a backslash (WHATWG parity) instead of reading past it to a spoofed @-suffix', () => {
    // WHATWG/browsers treat `\` like `/` for special schemes, so the
    // backslash ends the authority BEFORE `@github.com` is ever reached —
    // the real navigation target is `evil.example`. A regex that doesn't
    // terminate on `\` would read all the way to the last `@` and display
    // `github.com`: a trusted-looking domain over a phishing target.
    expect(domainFromUrl('https://evil.example\\@github.com/')).toBe('evil.example');
    expect(domainFromUrl('https://evil.example\\\\@github.com/')).toBe('evil.example');
    expect(domainFromUrl('https://evil.example\\?@github.com/')).toBe('evil.example');
  });

  it('falls back to the raw string rather than throwing', () => {
    expect(domainFromUrl('not a url')).toBe('not a url');
  });
});

describe('WebSearchResultList render', () => {
  it('renders the query and one row per result with structured testIDs', () => {
    const root = render(<WebSearchResultList parsed={SAFE_SEARCH} />);
    expect(byTestId(root, 'web-search-results').length).toBeGreaterThan(0);
    expect(byTestId(root, 'web-search-query').length).toBeGreaterThan(0);
    expect(byTestId(root, 'web-search-result-0').length).toBeGreaterThan(0);
    expect(byTestId(root, 'web-search-result-1').length).toBeGreaterThan(0);
    expect(byTestId(root, 'web-search-result-snippet-0').length).toBeGreaterThan(0);
    // Second fixture result has no snippet — the element must be omitted.
    expect(byTestId(root, 'web-search-result-snippet-1')).toHaveLength(0);
  });

  it('renders the domain, not the full URL, under each title', () => {
    const root = render(<WebSearchResultList parsed={SAFE_SEARCH} />);
    expect(byTestId(root, 'web-search-result-domain-0')[0]?.props.children).toBe('github.com');
    expect(byTestId(root, 'web-search-result-domain-1')[0]?.props.children).toBe('example.com');
  });

  it('gives every safe link a 44pt minimum touch target', () => {
    const root = render(<WebSearchResultList parsed={SAFE_SEARCH} />);
    const link = pressableByTestId(root, 'web-search-result-link-0');
    expect(link).toBeTruthy();
    const style = StyleSheetFlatten(link!.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });

  it('renders an unsafe URL as inert text with NO press handler', () => {
    // Hand-built parsed value — the parser would have dropped these, so this
    // is the render layer's independent second gate.
    const unsafe: ParsedWebSearchResults = {
      results: [
        { title: 'javascript payload', url: 'javascript:alert(1)' },
        { title: 'protocol relative', url: '//evil.example/x' },
      ],
    };
    const root = render(<WebSearchResultList parsed={unsafe} />);
    // Titles are still shown...
    expect(byTestId(root, 'web-search-result-unsafe-0').length).toBeGreaterThan(0);
    expect(byTestId(root, 'web-search-result-unsafe-1').length).toBeGreaterThan(0);
    // ...but nothing is a link, and nothing anywhere in the tree is tappable.
    expect(byTestId(root, 'web-search-result-link-0')).toHaveLength(0);
    expect(byTestId(root, 'web-search-result-link-1')).toHaveLength(0);
    expect(allPressHandlers(root)).toHaveLength(0);
  });

  it('tapping a safe link confirms first, then opens it', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const root = render(<WebSearchResultList parsed={SAFE_SEARCH} />);

    act(() => {
      pressableByTestId(root, 'web-search-result-link-0')!.props.onPress();
    });

    // The confirm dialog shows the FULL destination (anti-phishing, #6447).
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0]?.[1]).toBe('https://github.com/blamechris/chroxy');
    expect(openSpy).not.toHaveBeenCalled();

    // Confirming actually opens it.
    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    act(() => {
      buttons.find((b) => b.text === 'Open')!.onPress!();
    });
    expect(openSpy).toHaveBeenCalledWith('https://github.com/blamechris/chroxy');
  });
});

describe('openWebResultUrl', () => {
  it('refuses unsafe schemes without prompting or opening', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '//evil.example/x',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'chroxy://session/1',
    ]) {
      openWebResultUrl(bad);
    }
    expect(alertSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('swallows a Linking.openURL rejection instead of leaving it unhandled', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler') as never);
    openWebResultUrl('https://example.com/x');
    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    expect(() => buttons.find((b) => b.text === 'Open')!.onPress!()).not.toThrow();
    // Flush the rejected promise — an unhandled rejection would fail the run.
    await act(async () => { await Promise.resolve(); });
  });

  it('does not strip trailing punctuation that belongs to the URL', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const wiki = 'https://en.wikipedia.org/wiki/Ruby_(programming_language)';
    openWebResultUrl(wiki);
    expect(alertSpy.mock.calls[0]?.[1]).toBe(wiki);
  });
});

describe('WebFetchResult render', () => {
  const parsed: ParsedWebFetchResult = {
    url: 'https://example.com/chroxy',
    prompt: 'Summarize this page',
    content: '# Chroxy\n\nA **remote terminal** app.',
  };

  it('renders the source link and the formatted content', () => {
    const root = render(<WebFetchResult parsed={parsed} />);
    expect(byTestId(root, 'web-fetch-result').length).toBeGreaterThan(0);
    expect(byTestId(root, 'web-fetch-content').length).toBeGreaterThan(0);
    expect(pressableByTestId(root, 'web-fetch-source')).toBeTruthy();
  });

  it('omits the source link entirely when the URL is unsafe', () => {
    const root = render(
      <WebFetchResult parsed={{ url: 'javascript:alert(1)', content: 'body' }} />,
    );
    expect(byTestId(root, 'web-fetch-source')).toHaveLength(0);
  });

  it('renders content with no source header when the result carried no URL', () => {
    const root = render(<WebFetchResult parsed={{ content: 'just some text' }} />);
    expect(byTestId(root, 'web-fetch-source')).toHaveLength(0);
    expect(byTestId(root, 'web-fetch-content').length).toBeGreaterThan(0);
  });

  it('does not throw on empty content', () => {
    expect(() => render(<WebFetchResult parsed={{ content: '' }} />)).not.toThrow();
  });
});

describe('WebToolResultView dispatch', () => {
  it('renders the search list for a search shape', () => {
    const root = render(<WebToolResultView parsed={{ kind: 'search', search: SAFE_SEARCH }} />);
    expect(byTestId(root, 'web-search-results').length).toBeGreaterThan(0);
    expect(byTestId(root, 'web-fetch-result')).toHaveLength(0);
  });

  it('renders the fetch view for a fetch shape', () => {
    const root = render(
      <WebToolResultView parsed={{ kind: 'fetch', fetch: { content: 'hello' } }} />,
    );
    expect(byTestId(root, 'web-fetch-result').length).toBeGreaterThan(0);
    expect(byTestId(root, 'web-search-results')).toHaveLength(0);
  });
});

/** Thin wrapper around RN's own `StyleSheet.flatten` (#6988 review) — a
 *  hand-rolled merge happened to work only because `StyleSheet.create`
 *  returns plain objects in RN 0.81; using the real API means the 44pt
 *  touch-target assertion below fails loudly instead of vacuously passing
 *  if that ever changes back to numeric style IDs. */
function StyleSheetFlatten(style: unknown): Record<string, number> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, number>;
}
