/**
 * WebToolResult — React Native structured renderers for WebSearch /
 * WebFetch tool_result content.
 *
 * Mobile port of `packages/dashboard/src/components/WebToolResult.tsx`
 * (#6757), closing the parity gap tracked in #6982. Both platforms share
 * the SAME parser (`@chroxy/store-core`'s `parseWebSearchResults` /
 * `parseWebFetchResult`) — this module is the RN render layer only, and
 * deliberately re-implements nothing the parser already does.
 *
 * Contract mirrors `parseTodoList`/`TodoList` (#4180): the parse can fail
 * (returns `null`) and every call site falls back to its existing
 * plain-text render, so a malformed or unrecognized result never blanks
 * or crashes the bubble.
 *
 * ## Security
 *
 * A search/fetch result's `url` is fully model- and web-controlled — it is
 * exactly the content an attacker-influenced page or search index can
 * inject. Two independent gates apply:
 *
 * 1. **Parse time** — the shared parser already drops any result whose URL
 *    fails `isSafeWebUrl` (http/https only; `javascript:`, `data:`,
 *    `vbscript:` and protocol-relative `//host` are all rejected).
 * 2. **Render time** — every URL is re-checked with the same `isSafeWebUrl`
 *    here before it is allowed to become a `Pressable`. A URL that fails
 *    renders as inert `<Text>`: not tappable, no press handler, nothing to
 *    open. This branch is unreachable through the parser today; it exists
 *    so a future caller that hand-builds a `Parsed*` value cannot smuggle a
 *    dangerous scheme into a tappable element.
 *
 * There is no HTML-injection surface: RN `<Text>` renders strings as text
 * nodes, never as markup, so titles/snippets/domains are inherently
 * escaped. WebFetch's body is the one rich-rendered field and it goes
 * through the app's existing `FormattedResponse` markdown renderer — the
 * same pipeline assistant prose already uses, whose own `openURL` helper
 * enforces an `^https?://` scheme gate before calling `Linking.openURL`.
 *
 * Opening a link routes through {@link openWebResultUrl}, which shows the
 * full destination URL in a confirm dialog first (the #6447 anti-phishing
 * treatment applied to every model-supplied link in the app).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform, Alert, Linking } from 'react-native';
import {
  isSafeWebUrl,
  isWebSearchToolName,
  isWebFetchToolName,
  parseWebSearchResults,
  parseWebFetchResult,
} from '@chroxy/store-core';
import type { ParsedWebSearchResults, ParsedWebFetchResult } from '@chroxy/store-core';
import { COLORS } from '../../constants/colors';
import { FormattedResponse } from '../MarkdownRenderer';

/** Minimum tappable height for a link row (iOS HIG / Android a11y: 44pt). */
const MIN_TOUCH_TARGET = 44;

/**
 * Extract a display host from a URL WITHOUT depending on the global `URL`
 * constructor — React Native's bundled `URL` polyfill is incomplete and
 * does not reliably implement `.hostname`, so the dashboard's
 * `new URL(url).hostname` approach is not portable here.
 *
 * Userinfo is stripped by taking the segment after the LAST `@`, which is
 * the real host per the URL spec. That matters for display integrity: for
 * `https://github.com@evil.example/x` this shows `evil.example`, not the
 * `github.com` prefix an attacker put there to look legitimate.
 */
export function domainFromUrl(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  const authority = m?.[1];
  if (!authority) return url;
  const hostAndPort = authority.split('@').pop() ?? authority;
  const host = hostAndPort.replace(/:\d+$/, '');
  return host.replace(/^www\./i, '') || url;
}

/**
 * Open a web result's URL, gated on the shared scheme allowlist.
 *
 * Unsafe schemes return silently — callers already render those as inert
 * text, so reaching here with one means a bug, not a user action worth
 * surfacing. Safe URLs get the #6447 confirm-with-full-URL prompt before
 * `Linking.openURL`, whose rejection (no handler installed for the
 * scheme, user cancelled at the OS layer) is swallowed rather than left
 * as an unhandled promise rejection.
 *
 * Unlike `MarkdownRenderer`'s `openURL`, this does NOT strip trailing
 * punctuation: that strip exists to undo greedy bare-URL autolinking in
 * prose, and applying it to an exact structured URL would corrupt
 * legitimate links such as
 * `https://en.wikipedia.org/wiki/Ruby_(programming_language)`.
 */
export function openWebResultUrl(url: string): void {
  if (!isSafeWebUrl(url)) return;
  const target = url.trim();
  Alert.alert(
    'Open link?',
    target,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open',
        onPress: () => {
          void Linking.openURL(target).catch(() => {
            // Nothing actionable for the user — the OS declined to handle
            // the URL. Never let this surface as an unhandled rejection.
          });
        },
      },
    ],
    { cancelable: true },
  );
}

/** Discriminated result of {@link parseWebToolResult} — lets a call site
 *  make ONE routing decision and hand the outcome straight to
 *  {@link WebToolResultView}. */
export type ParsedWebToolResult =
  | { kind: 'search'; search: ParsedWebSearchResults }
  | { kind: 'fetch'; fetch: ParsedWebFetchResult };

/**
 * Route a tool_result through the right shared parser based on the tool
 * name. Returns `null` for any non-web tool, an absent result, or a
 * payload the parser could not make sense of — in every one of those
 * cases the caller must fall back to its existing plain-text render.
 *
 * IMPORTANT: pass the RAW tool name (`message.tool`), not the formatted
 * display name. `formatToolName` turns `web_search` into `Web Search`,
 * and the shared matchers normalize separators (`_`/`-`) but not spaces,
 * so a display name would silently fail to route.
 */
export function parseWebToolResult(
  tool: string | undefined | null,
  toolResult: string | undefined | null,
): ParsedWebToolResult | null {
  if (typeof toolResult !== 'string' || toolResult.length === 0) return null;
  if (isWebSearchToolName(tool)) {
    const search = parseWebSearchResults(toolResult);
    return search ? { kind: 'search', search } : null;
  }
  if (isWebFetchToolName(tool)) {
    const fetched = parseWebFetchResult(toolResult);
    return fetched ? { kind: 'fetch', fetch: fetched } : null;
  }
  return null;
}

export interface WebSearchResultListProps {
  parsed: ParsedWebSearchResults;
}

/** WebSearch: a compact list of source rows (title link, domain, snippet),
 *  replacing the raw joined-text dump. */
export function WebSearchResultList({ parsed }: WebSearchResultListProps) {
  return (
    <View style={styles.container} testID="web-search-results">
      {parsed.query ? (
        <Text style={styles.query} testID="web-search-query" numberOfLines={2}>
          Results for “{parsed.query}”
        </Text>
      ) : null}
      {parsed.results.map((r, i) => {
        // Defense in depth — the parser already dropped unsafe URLs, so a
        // failure here means the value was constructed by hand. Render the
        // title as inert text with NO press handler in that case.
        const safe = isSafeWebUrl(r.url);
        return (
          <View key={`${r.url}-${i}`} style={styles.item} testID={`web-search-result-${i}`}>
            {safe ? (
              <Pressable
                onPress={() => openWebResultUrl(r.url)}
                style={styles.linkPressable}
                hitSlop={4}
                accessibilityRole="link"
                accessibilityLabel={`${r.title}, ${domainFromUrl(r.url)}`}
                accessibilityHint="Opens in your browser after confirmation"
                testID={`web-search-result-link-${i}`}
              >
                <Text style={styles.title}>{r.title}</Text>
              </Pressable>
            ) : (
              <View style={styles.linkPressable}>
                <Text style={styles.titleUnsafe} testID={`web-search-result-unsafe-${i}`}>
                  {r.title}
                </Text>
              </View>
            )}
            <Text style={styles.domain} testID={`web-search-result-domain-${i}`} numberOfLines={1}>
              {domainFromUrl(r.url)}
            </Text>
            {r.snippet ? (
              <Text style={styles.snippet} testID={`web-search-result-snippet-${i}`}>
                {r.snippet}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export interface WebFetchResultProps {
  parsed: ParsedWebFetchResult;
}

/** WebFetch: the fetched page body run through the app's existing markdown
 *  renderer (the same one assistant prose uses), with the source URL shown
 *  as a link above it when the result carried a safe one. */
export function WebFetchResult({ parsed }: WebFetchResultProps) {
  const safeUrl = isSafeWebUrl(parsed.url) ? parsed.url : undefined;
  return (
    <View style={styles.container} testID="web-fetch-result">
      {safeUrl ? (
        <Pressable
          onPress={() => openWebResultUrl(safeUrl)}
          style={styles.linkPressable}
          hitSlop={4}
          accessibilityRole="link"
          accessibilityLabel={`Source: ${domainFromUrl(safeUrl)}`}
          accessibilityHint="Opens in your browser after confirmation"
          testID="web-fetch-source"
        >
          <Text style={styles.sourceUrl} numberOfLines={1}>
            {safeUrl}
          </Text>
        </Pressable>
      ) : null}
      <View testID="web-fetch-content">
        <FormattedResponse content={parsed.content} messageTextStyle={styles.fetchContent} />
      </View>
    </View>
  );
}

/** Render whichever web-tool shape {@link parseWebToolResult} produced. */
export function WebToolResultView({ parsed }: { parsed: ParsedWebToolResult }) {
  return parsed.kind === 'search' ? (
    <WebSearchResultList parsed={parsed.search} />
  ) : (
    <WebFetchResult parsed={parsed.fetch} />
  );
}

const styles = StyleSheet.create({
  // Matches TodoList's inset-rule treatment so the three structured
  // tool-result renderers read as one family.
  container: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accentBlue,
    marginVertical: 2,
  },
  query: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  item: {
    paddingVertical: 2,
  },
  // 44pt minimum tappable height (iOS HIG). `justifyContent: 'center'`
  // keeps a single-line title vertically centred in the taller target.
  linkPressable: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  title: {
    color: COLORS.accentBlue,
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  // An unsafe URL still shows its title so the user sees what was returned
  // — just with no link affordance and no press handler.
  titleUnsafe: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  domain: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  snippet: {
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  sourceUrl: {
    color: COLORS.accentBlue,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    textDecorationLine: 'underline',
  },
  fetchContent: {
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
});
