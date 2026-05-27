/**
 * Mobile ToolBubble collapsed-preview field-priority tests (#4243).
 *
 * Mirrors the dashboard's `getPartialSummary` behaviour on mobile:
 * when the in-flight `toolInputPartial` (or the post-handleToolStart
 * `content` string of a JSON-stringified input) parses to a
 * recognised tool-input object, the collapsed bubble surfaces the
 * single most useful field (`command` / `file_path` / `path` /
 * `description`) rather than the truncated raw JSON. Without this,
 * mobile shows `{"command":"rm -rf node_mod` while the dashboard
 * shows `rm -rf node_modules` — breaking the Bash early-abort UX
 * (#4063) on mobile.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { ToolBubble } from '../chat/ToolBubble';
import type { ChatMessage } from '../../store/connection';

function makeToolMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'tool-partial-1',
    type: 'tool_use',
    content: 'Bash', // placeholder content from handleToolStart when msg.input is missing
    tool: 'Bash',
    toolUseId: 'toolu_partial',
    timestamp: 0,
    ...overrides,
  };
}

function renderBubble(message: ChatMessage): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <ToolBubble
        message={message}
        isSelected={false}
        isSelecting={false}
        onToggleSelection={() => {}}
        onOpenDetail={() => {}}
      />,
    );
  });
  return root;
}

/**
 * Mobile renders the collapsed preview as a `<Text>` tagged with
 * `testID="tool-collapsed-preview"` (#4260). Select explicitly by
 * testID rather than walking by `numberOfLines={1}` — the latter
 * silently binds to the wrong node if a future one-line Text is
 * added above the preview, causing field-priority assertions to
 * pass/fail against unrelated text.
 */
function getCollapsedPreview(root: renderer.ReactTestRenderer): string {
  const collapsed = root.root.findByProps({ testID: 'tool-collapsed-preview' });
  expect(collapsed).toBeTruthy();
  const children = Array.isArray(collapsed.props.children)
    ? collapsed.props.children
    : [collapsed.props.children];
  return children.filter((c: unknown): c is string => typeof c === 'string').join('');
}

describe('ToolBubble collapsed preview — partial-input field priority (#4243)', () => {
  // #4260: collapsed-preview Text is tagged so Maestro + jest can
  // select it explicitly. Without this testID, render-tree walkers
  // bind to the first `numberOfLines={1}` Text and silently mis-target
  // future siblings.
  it('renders the collapsed preview with testID="tool-collapsed-preview" (#4260)', () => {
    const root = renderBubble(makeToolMessage({
      toolInputPartial: '{"command":"ls"}',
    }));
    const node = root.root.findByProps({ testID: 'tool-collapsed-preview' });
    expect(node).toBeTruthy();
    expect(node.props.numberOfLines).toBe(1);
  });

  describe('streaming toolInputPartial', () => {
    it('prefers `command` over the raw 60-char JSON slice when partial is parseable', () => {
      const root = renderBubble(makeToolMessage({
        toolInputPartial: '{"command":"rm -rf node_modules"}',
      }));
      expect(getCollapsedPreview(root)).toBe('rm -rf node_modules');
    });

    it('prefers `file_path` when no `command`', () => {
      const root = renderBubble(makeToolMessage({
        tool: 'Read',
        content: 'Read', // matches tool — placeholder, partial wins
        toolInputPartial: '{"file_path":"/etc/hosts"}',
      }));
      expect(getCollapsedPreview(root)).toBe('/etc/hosts');
    });

    it('prefers `path` when no `command`/`file_path`', () => {
      const root = renderBubble(makeToolMessage({
        tool: 'List',
        content: 'List',
        toolInputPartial: '{"path":"/tmp/foo"}',
      }));
      expect(getCollapsedPreview(root)).toBe('/tmp/foo');
    });

    it('falls back to `description` when no command/file_path/path', () => {
      const root = renderBubble(makeToolMessage({
        tool: 'Task',
        content: 'Task',
        toolInputPartial: '{"description":"do the thing"}',
      }));
      expect(getCollapsedPreview(root)).toBe('do the thing');
    });

    it('falls back to the raw pretty-printed JSON when partial has no priority field', () => {
      // No command/file_path/path/description — preserve legacy behaviour
      // so the user still sees what fields are forming.
      const root = renderBubble(makeToolMessage({
        toolInputPartial: '{"foo":"bar","baz":"qux"}',
      }));
      const preview = getCollapsedPreview(root);
      expect(preview).toMatch(/"foo"/);
      expect(preview).toMatch(/"bar"/);
    });
  });

  describe('final content (JSON-stringified input from handleToolStart)', () => {
    it('extracts `command` from JSON-stringified content rather than slicing the raw JSON', () => {
      // handleToolStart sets `content = JSON.stringify(msg.input)`.
      // Without #4243 the collapsed bubble would show
      // `{"command":"rm -rf node_mod`; with #4243 it shows
      // `rm -rf node_modules`.
      const root = renderBubble(makeToolMessage({
        content: JSON.stringify({ command: 'rm -rf node_modules', description: 'clean' }),
      }));
      expect(getCollapsedPreview(root)).toBe('rm -rf node_modules');
    });

    it('extracts `file_path` from JSON-stringified content', () => {
      const root = renderBubble(makeToolMessage({
        tool: 'Read',
        content: JSON.stringify({ file_path: '/etc/hosts' }),
      }));
      expect(getCollapsedPreview(root)).toBe('/etc/hosts');
    });

    it('falls back to legacy truncated content when content is not JSON', () => {
      // Raw-string inputs land as quoted text on the wire; the
      // post-handleToolStart content may also be plain text in that
      // case. The legacy 60-char-slice + ellipsis fallback wins.
      const root = renderBubble(makeToolMessage({
        content: 'plain text input that should pass through unchanged',
      }));
      expect(getCollapsedPreview(root)).toBe('plain text input that should pass through unchanged');
    });

    it('falls back to legacy truncated content when content JSON has no priority fields', () => {
      const root = renderBubble(makeToolMessage({
        content: JSON.stringify({ foo: 'bar', baz: 'qux' }),
      }));
      const preview = getCollapsedPreview(root);
      // No priority field → no extraction → show the raw JSON head.
      expect(preview).toMatch(/"foo"/);
    });

    it('truncates extracted summaries longer than 60 chars with the legacy ellipsis', () => {
      const long = 'x'.repeat(120);
      const root = renderBubble(makeToolMessage({
        content: JSON.stringify({ command: long }),
      }));
      const preview = getCollapsedPreview(root);
      // 60 raw chars + ellipsis — matches the existing collapsed-preview
      // truncation contract.
      expect(preview).toBe('x'.repeat(60) + '...');
    });
  });

  describe('precedence: streaming partial wins while content is placeholder', () => {
    it('uses partial summary when content is still the tool-name placeholder', () => {
      // handleToolStart falls back to `content = tool` when msg.input
      // is missing — that's the "placeholder" state where the streaming
      // partial buffer is the actual source of truth.
      const root = renderBubble(makeToolMessage({
        content: 'Bash',
        toolInputPartial: '{"command":"ls -la"}',
      }));
      expect(getCollapsedPreview(root)).toBe('ls -la');
    });

    it('uses content summary once non-placeholder content arrives, ignoring stale partial', () => {
      // The final `content` overrides the streaming buffer once it
      // lands — same precedence as the existing partialPreview /
      // rawContent logic above.
      const root = renderBubble(makeToolMessage({
        content: JSON.stringify({ command: 'final-cmd' }),
        toolInputPartial: '{"command":"streaming-stale"}',
      }));
      expect(getCollapsedPreview(root)).toBe('final-cmd');
    });
  });
});
