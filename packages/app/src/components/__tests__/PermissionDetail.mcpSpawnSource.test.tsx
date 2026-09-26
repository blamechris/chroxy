/**
 * #7939 — MCP spawn-trust permission card shows WHICH config scope the
 * server was resolved from, with the repo-provided `.mcp.json` case
 * ('project-mcp-json') visibly flagged: that scope is `<cwd>/.mcp.json`,
 * checked into a repository a user may have just cloned, so an approval must
 * be able to tell it apart from the user's own machine-local config.
 *
 * `source` is OPTIONAL on the wire (older server / wire-compat) — an
 * absent or unrecognized value must render no "Configured from" row at all,
 * never a blank or garbled one.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { renderPermissionDetail } from '../PermissionDetail';

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(el);
  });
  return root;
}

function renderMcpSpawn(toolInput: Record<string, unknown>): renderer.ReactTestRenderer {
  const el = renderPermissionDetail('mcp_spawn', toolInput);
  if (!el) throw new Error('expected an mcp_spawn permission detail element');
  return render(el);
}

function byTestId(root: renderer.ReactTestRenderer, id: string): ReactTestInstance[] {
  return root.root.findAllByProps({ testID: id });
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

describe('MCP spawn-trust permission detail — source (#7939)', () => {
  it('shows the "From this repository\'s .mcp.json" flag for project-mcp-json', () => {
    const root = renderMcpSpawn({
      mcpServer: { name: 'sneaky', command: 'npx', args: ['-y', 'x'], envKeys: [], source: 'project-mcp-json' },
    });
    const nodes = byTestId(root, 'permission-mcp-source');
    expect(nodes.length).toBeGreaterThan(0);
    expect(textOf(nodes[0])).toBe("From this repository's .mcp.json");
  });

  it('renders a distinct label for the "local" scope', () => {
    const root = renderMcpSpawn({
      mcpServer: { name: 'fs', command: 'node', args: [], envKeys: [], source: 'local' },
    });
    const nodes = byTestId(root, 'permission-mcp-source');
    expect(textOf(nodes[0])).toBe('Your local Claude config for this project');
  });

  it('renders a distinct label for the "user" scope', () => {
    const root = renderMcpSpawn({
      mcpServer: { name: 'github', command: 'node', args: [], envKeys: [], source: 'user' },
    });
    const nodes = byTestId(root, 'permission-mcp-source');
    expect(textOf(nodes[0])).toBe('Your user-wide Claude config');
  });

  it('renders no "Configured from" row when source is absent', () => {
    const root = renderMcpSpawn({
      mcpServer: { name: 'github', command: 'node', args: [], envKeys: [] },
    });
    expect(byTestId(root, 'permission-mcp-source')).toHaveLength(0);
  });

  it('renders no "Configured from" row for an unrecognized source', () => {
    const root = renderMcpSpawn({
      mcpServer: { name: 'github', command: 'node', args: [], envKeys: [], source: 'not-a-real-scope' },
    });
    expect(byTestId(root, 'permission-mcp-source')).toHaveLength(0);
  });

  it('still shows server name and command regardless of source', () => {
    const root = renderMcpSpawn({
      mcpServer: { name: 'github', command: 'node', args: ['gh.js'], envKeys: ['GITHUB_TOKEN'], source: 'user' },
    });
    const texts = root.root.findAll((n) => typeof n.props?.children === 'string', { deep: true });
    expect(texts.some((n) => n.props.children === 'github')).toBe(true);
    expect(texts.some((n) => n.props.children === 'node')).toBe(true);
  });

  it('shows the URL for a remote server when no command is present', () => {
    const root = renderMcpSpawn({
      mcpServer: { name: 'remote', url: 'https://mcp.example.com/sse', headerKeys: [], source: 'project-mcp-json' },
    });
    const texts = root.root.findAll((n) => typeof n.props?.children === 'string', { deep: true });
    expect(texts.some((n) => n.props.children === 'https://mcp.example.com/sse')).toBe(true);
    expect(textOf(byTestId(root, 'permission-mcp-source')[0])).toBe("From this repository's .mcp.json");
  });

  it('falls through to the generic JSON renderer (no MCP source row) when mcpServer is absent', () => {
    const el = renderPermissionDetail('mcp_spawn', { unrelated: true });
    if (!el) throw new Error('expected the generic JSON-fallback element');
    const root = render(el);
    expect(byTestId(root, 'permission-mcp-source')).toHaveLength(0);
  });
});
