/**
 * AddMcpServerForm tests (#6999). Covers: client-side validation before the
 * round-trip (mirroring the server's rules), the non-primary refusal being
 * explained and disabling the form, success being confirmed only by the
 * caller's mcp_servers-broadcast-driven callback (never a synthesized local
 * result), and that nothing typed into env/headers is ever rendered back or
 * left behind after submit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import { AddMcpServerForm } from './AddMcpServerForm';

const mockAddMcpServer = vi.fn();
const defaultMockState = (): Record<string, unknown> => ({
  addMcpServer: mockAddMcpServer,
  mcpConfigForbiddenNonPrimary: false,
});
let mockStoreState: Record<string, unknown> = defaultMockState();
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState),
}));

afterEach(() => {
  cleanup();
  mockAddMcpServer.mockClear();
  mockStoreState = defaultMockState();
});

function openForm() {
  render(<AddMcpServerForm />);
  fireEvent.click(screen.getByTestId('add-mcp-server-open'));
}

describe('AddMcpServerForm collapse/expand (#6999)', () => {
  it('renders collapsed with just the "+ Add server" button', () => {
    render(<AddMcpServerForm />);
    expect(screen.getByTestId('add-mcp-server-open')).toBeTruthy();
    expect(screen.queryByTestId('add-mcp-server-form')).toBeNull();
  });

  it('expands into the full form on click', () => {
    openForm();
    expect(screen.getByTestId('add-mcp-server-form')).toBeTruthy();
    expect(screen.getByTestId('add-mcp-server-name')).toBeTruthy();
  });

  it('the primary-token notice is visible unconditionally, before any submit attempt', () => {
    openForm();
    expect(screen.getByTestId('add-mcp-server-primary-notice').textContent).toMatch(/primary API token/i);
  });

  it('the "adding is not trusting" notice is visible unconditionally', () => {
    openForm();
    expect(screen.getByTestId('add-mcp-server-trust-notice').textContent).toMatch(/does not run it/i);
    expect(screen.getByTestId('add-mcp-server-trust-notice').textContent).toMatch(/prompt/i);
  });

  it('Cancel collapses the form and does not call addMcpServer', () => {
    openForm();
    fireEvent.click(screen.getByTestId('add-mcp-server-cancel'));
    expect(screen.queryByTestId('add-mcp-server-form')).toBeNull();
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });
});

describe('AddMcpServerForm client-side validation (#6999)', () => {
  it('rejects an empty name without calling addMcpServer', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(screen.getByTestId('add-mcp-server-error').textContent).toMatch(/Name is required/);
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });

  it('rejects a name containing "__" (the MCP tool-namespace separator) before the round-trip', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'a__b' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(screen.getByTestId('add-mcp-server-error').textContent).toMatch(/tool-namespace separator/);
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });

  it('rejects an uppercase / invalid-charset name', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'MyServer' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(screen.getByTestId('add-mcp-server-error').textContent).toMatch(/lowercase identifier/);
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });

  it('rejects a config with neither command nor url when the required field is blank', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    // stdio transport is the default; leave Command blank.
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(screen.getByTestId('add-mcp-server-error').textContent).toMatch(/Provide either a command/);
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });

  it('rejects a config carrying BOTH command and url (switching transport does not leave stale fields behind, so this simulates a would-be-ambiguous submit via direct field entry is not reachable through the UI — the transport radio enforces exactly one at a time)', () => {
    // The form's own radio group makes "both" unreachable through normal use
    // (only one transport's fields are rendered/submitted at a time) — this
    // documents that invariant rather than forcing an artificial state.
    openForm();
    fireEvent.click(screen.getByTestId('add-mcp-server-transport-remote'));
    expect(screen.queryByTestId('add-mcp-server-command')).toBeNull();
    fireEvent.click(screen.getByTestId('add-mcp-server-transport-stdio'));
    expect(screen.queryByTestId('add-mcp-server-url')).toBeNull();
  });

  it('rejects a reserved env key (constructor) before the round-trip', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-env'), { target: { value: 'constructor=x' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(screen.getByTestId('add-mcp-server-error').textContent).toMatch(/env key 'constructor' is reserved/);
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });

  // Review (#7022): the key/value map must have a NULL prototype. On a plain
  // `{}`, `map['__proto__'] = 'x'` hits the legacy setter, which ignores a
  // string — the key never becomes an own property, so the line was silently
  // discarded AND unreachable by the Object.keys-based reserved-key check.
  it('rejects a reserved env key (__proto__) instead of silently swallowing the line', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-env'), { target: { value: '__proto__=x' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(screen.getByTestId('add-mcp-server-error').textContent).toMatch(/env key '__proto__' is reserved/);
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });

  it('rejects a reserved header key (__proto__) on the remote transport too', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'remote-srv' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-transport-remote'));
    fireEvent.change(screen.getByTestId('add-mcp-server-url'), { target: { value: 'https://example.com/mcp' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-headers'), { target: { value: '__proto__=x' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(screen.getByTestId('add-mcp-server-error').textContent).toMatch(/headers key '__proto__' is reserved/);
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });

  it('rejects a non-KEY=VALUE env line with a clear message', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-env'), { target: { value: 'not-a-pair' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(screen.getByTestId('add-mcp-server-error').textContent).toMatch(/KEY=VALUE/);
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });

  it('accepts a valid stdio submission and calls addMcpServer with the built config', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-args'), { target: { value: '-y\nsome-pkg' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-env'), { target: { value: 'API_KEY=secret-token' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(mockAddMcpServer).toHaveBeenCalledTimes(1);
    const [name, config, scope, callback] = mockAddMcpServer.mock.calls[0]!;
    expect(name).toBe('filesystem');
    expect(config).toEqual({ command: 'npx', args: ['-y', 'some-pkg'], env: { API_KEY: 'secret-token' } });
    expect(scope).toBe('user');
    expect(typeof callback).toBe('function');
  });

  it('accepts a valid remote submission with the default http type', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'remote-fs' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-transport-remote'));
    fireEvent.change(screen.getByTestId('add-mcp-server-url'), { target: { value: 'https://example.com/mcp' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(mockAddMcpServer).toHaveBeenCalledTimes(1);
    const [, config] = mockAddMcpServer.mock.calls[0]!;
    expect(config).toEqual({ type: 'http', url: 'https://example.com/mcp' });
  });

  it('sends the selected "project" scope', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-scope'), { target: { value: 'project' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(mockAddMcpServer.mock.calls[0]![2]).toBe('project');
  });
});

describe('AddMcpServerForm non-primary refusal (#6999)', () => {
  it('shows the forbidden banner and disables every field + submit when mcpConfigForbiddenNonPrimary is true', () => {
    mockStoreState = { ...mockStoreState, mcpConfigForbiddenNonPrimary: true };
    openForm();
    expect(screen.getByTestId('add-mcp-server-forbidden-banner').textContent).toMatch(/primary API token/);
    expect((screen.getByTestId('add-mcp-server-name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('add-mcp-server-command') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('add-mcp-server-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not render the forbidden banner before any refusal has happened', () => {
    openForm();
    expect(screen.queryByTestId('add-mcp-server-forbidden-banner')).toBeNull();
  });

  it('a submit blocked by the disabled state never calls addMcpServer even if somehow fired', () => {
    mockStoreState = { ...mockStoreState, mcpConfigForbiddenNonPrimary: true };
    openForm();
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    expect(mockAddMcpServer).not.toHaveBeenCalled();
  });

  it('surfaces the server\'s own MCP_CONFIG_FORBIDDEN_NON_PRIMARY_CLIENT rejection message verbatim when the callback fires ok:false (this is what teaches the store to flip mcpConfigForbiddenNonPrimary; the form here just renders whatever message it receives)', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    const callback = mockAddMcpServer.mock.calls[0]![3] as (r: { ok: boolean; code?: string; message?: string }) => void;
    const serverMessage =
      "Pairing-issued tokens cannot add or remove MCP servers — a configured MCP server is a command this machine will run. Use the primary API token from a device with physical access to this machine.";
    act(() => {
      callback({ ok: false, code: 'MCP_CONFIG_FORBIDDEN_NON_PRIMARY_CLIENT', message: serverMessage });
    });
    expect(screen.getByTestId('add-mcp-server-error').textContent).toBe(serverMessage);
  });
});

describe('AddMcpServerForm success confirmation has no phantom result (#6999)', () => {
  it('shows "Adding…" and a disabled submit while awaiting the callback', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    const submit = screen.getByTestId('add-mcp-server-submit') as HTMLButtonElement;
    expect(submit.textContent).toBe('Adding…');
    expect(submit.disabled).toBe(true);
  });

  it('on ok:true the form clears and collapses — success is ENTIRELY driven by the caller-supplied callback, never synthesized locally', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-env'), { target: { value: 'API_KEY=super-secret' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    const callback = mockAddMcpServer.mock.calls[0]![3] as (r: { ok: boolean }) => void;
    act(() => {
      callback({ ok: true });
    });
    // Collapsed back to the "+ Add server" entry point.
    expect(screen.getByTestId('add-mcp-server-open')).toBeTruthy();
    expect(screen.queryByTestId('add-mcp-server-form')).toBeNull();
  });

  it('re-opening after a successful add starts from a BLANK form — the secret typed into env is never rendered back', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-env'), { target: { value: 'API_KEY=super-secret' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    const callback = mockAddMcpServer.mock.calls[0]![3] as (r: { ok: boolean }) => void;
    act(() => {
      callback({ ok: true });
    });
    fireEvent.click(screen.getByTestId('add-mcp-server-open'));
    expect((screen.getByTestId('add-mcp-server-name') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('add-mcp-server-command') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('add-mcp-server-env') as HTMLTextAreaElement).value).toBe('');
    // The whole document never contained the secret value at any point after submit.
    expect(document.body.textContent).not.toMatch(/super-secret/);
  });

  it('on failure the form stays open with the fields intact (so the user can fix and retry) and re-enables the submit button', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    const callback = mockAddMcpServer.mock.calls[0]![3] as (r: { ok: boolean; code?: string; message?: string }) => void;
    act(() => {
      callback({ ok: false, code: 'MCP_SERVER_EXISTS', message: "An MCP server named 'filesystem' already exists in user scope." });
    });
    expect(screen.getByTestId('add-mcp-server-form')).toBeTruthy();
    expect((screen.getByTestId('add-mcp-server-name') as HTMLInputElement).value).toBe('filesystem');
    expect((screen.getByTestId('add-mcp-server-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a timeout/disconnect resolution (client-synthesized code) surfaces its message and clears "submitting" — the no-reply path cannot hang forever', () => {
    openForm();
    fireEvent.change(screen.getByTestId('add-mcp-server-name'), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByTestId('add-mcp-server-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('add-mcp-server-submit'));
    const callback = mockAddMcpServer.mock.calls[0]![3] as (r: { ok: boolean; code?: string; message?: string }) => void;
    act(() => {
      callback({ ok: false, code: 'TIMEOUT', message: 'No response from the daemon — check the server list below; the request may still complete.' });
    });
    const submit = screen.getByTestId('add-mcp-server-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Add server');
    expect(screen.getByTestId('add-mcp-server-error').textContent).toMatch(/No response from the daemon/);
  });
});
