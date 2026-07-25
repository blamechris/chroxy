/**
 * AddMcpServerForm (#6999) — collapsible "+ Add server" form embedded in
 * SidebarMcpView. Wires `add_mcp_server` end to end:
 *
 * - Client-side validation (mcp-server-validation.ts) mirrors the server's
 *   actual rules (name charset, no `__`, reserved keys, ambiguous
 *   command+url) for a fast, clear error before the round-trip — the server
 *   remains authoritative and re-validates from scratch on write.
 * - There is no dedicated result type on the wire (#6974/#6998): success is
 *   the re-emitted `mcp_servers` broadcast (the row simply appears in
 *   SidebarMcpView's list), not a reply to this form. `addMcpServer`'s
 *   `callback` (armed via `armMcpServerOpCallback`, connection.ts) resolves
 *   on whichever of {matching error, satisfying broadcast, bounded timeout}
 *   happens first, so `submitting` is guaranteed to clear.
 * - Primary-token gating is NOT hidden: a persistent notice explains the
 *   requirement before every submit, and once a real rejection teaches the
 *   store `mcpConfigForbiddenNonPrimary` (message-handler.ts), the form
 *   disables itself and explains why — using the server's own (already
 *   human-readable) rejection text, not a generic error.
 * - "Adding is not trusting": a fixed notice makes clear the daemon still
 *   gates the first spawn behind its trust prompt, even for a name that was
 *   previously trusted (trust is re-keyed to the full spawn config as of
 *   #6998).
 * - Secrets: `env` / `headers` VALUES are read from the form only to build
 *   the outgoing `config` payload. They are never logged, never placed in a
 *   URL, and the form clears itself (including these fields) on success —
 *   nothing typed here is rendered back after submit. Validation errors
 *   reference only KEY names, never values (mcp-server-validation.ts).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useConnectionStore } from '../store/connection';
import type { McpConfigScope, McpServerConfigInput, McpServerOpResult } from '../store/types';
import { validateMcpServerConfig, validateMcpServerName } from '../lib/mcp-server-validation';
import './AddMcpServerForm.css';

type Transport = 'stdio' | 'remote';

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `KEY=VALUE` per line. A line with no `=` (or an empty key) is reported as invalid rather than silently dropped. */
function parseKeyValueLines(text: string): { map: Record<string, string>; invalidLines: string[] } {
  // Null-prototype map, NOT `{}`. On a plain object `map['__proto__'] = 'x'`
  // hits the legacy `__proto__` setter, which ignores a string value — so the
  // key never becomes an own property. That silently discarded the line AND
  // made it invisible to the reserved-key refusal in mcp-server-validation.ts
  // (which iterates Object.keys), so `__proto__` could never be reported.
  // With a null prototype every key is an ordinary own key: `__proto__` is
  // carried through and correctly rejected as reserved.
  const map: Record<string, string> = Object.create(null);
  const invalidLines: string[] = [];
  for (const line of parseLines(text)) {
    const idx = line.indexOf('=');
    const key = idx > 0 ? line.slice(0, idx).trim() : '';
    if (!key) {
      invalidLines.push(line);
      continue;
    }
    map[key] = line.slice(idx + 1);
  }
  return { map, invalidLines };
}

const EMPTY_FIELDS = {
  name: '',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
};

export function AddMcpServerForm() {
  const addMcpServer = useConnectionStore((s) => s.addMcpServer);
  const forbiddenNonPrimary = useConnectionStore((s) => s.mcpConfigForbiddenNonPrimary);

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<McpConfigScope>('user');
  const [transport, setTransport] = useState<Transport>('stdio');
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards the callback from setting state after unmount (panel collapsed /
  // navigated away mid-request) — armMcpServerOpCallback still resolves the
  // request server-side/via timeout either way, this only guards the setState.
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const disabled = forbiddenNonPrimary;

  const resetFields = () => {
    setFields(EMPTY_FIELDS);
    setScope('user');
    setTransport('stdio');
  };

  const buildConfig = (): { config: McpServerConfigInput | null; error: string | null } => {
    if (transport === 'stdio') {
      const { map: env, invalidLines } = parseKeyValueLines(fields.envText);
      if (invalidLines.length > 0) {
        return { config: null, error: `Env line(s) must be KEY=VALUE: ${invalidLines.join(', ')}` };
      }
      const config: McpServerConfigInput = { command: fields.command.trim() };
      const args = parseLines(fields.argsText);
      if (args.length > 0) config.args = args;
      if (Object.keys(env).length > 0) config.env = env;
      return { config, error: null };
    }
    const { map: headers, invalidLines } = parseKeyValueLines(fields.headersText);
    if (invalidLines.length > 0) {
      return { config: null, error: `Header line(s) must be KEY=VALUE: ${invalidLines.join(', ')}` };
    }
    const config: McpServerConfigInput = { type: 'http', url: fields.url.trim() };
    if (Object.keys(headers).length > 0) config.headers = headers;
    return { config, error: null };
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting || disabled) return;
    setError(null);

    const nameError = validateMcpServerName(fields.name);
    if (nameError) {
      setError(nameError);
      return;
    }
    const built = buildConfig();
    if (built.error || !built.config) {
      setError(built.error);
      return;
    }
    const configError = validateMcpServerConfig(built.config);
    if (configError) {
      setError(configError);
      return;
    }

    setSubmitting(true);
    addMcpServer(fields.name.trim(), built.config, scope, (result: McpServerOpResult) => {
      if (!mountedRef.current) return;
      setSubmitting(false);
      if (result.ok) {
        resetFields();
        setOpen(false);
        return;
      }
      setError(result.message || 'Failed to add MCP server.');
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        className="add-mcp-server-open"
        data-testid="add-mcp-server-open"
        // Stays clickable even when known-forbidden — opening the form is how
        // the user SEES the explanation (the forbidden banner below). A
        // disabled entry point with no visible reason reads as broken; the
        // `title` hint plus the banner-on-open together satisfy "explained
        // before submitting" without hiding the affordance.
        title={forbiddenNonPrimary ? 'Requires the primary API token — click to see why' : undefined}
        onClick={() => setOpen(true)}
      >
        + Add server
      </button>
    );
  }

  return (
    <form className="add-mcp-server-form" data-testid="add-mcp-server-form" onSubmit={handleSubmit}>
      {/* Always visible — the primary-token requirement is explained BEFORE
          submitting, whether or not we already know this connection is non-primary. */}
      <p className="add-mcp-server-notice" data-testid="add-mcp-server-primary-notice">
        Requires the primary API token. A paired device (phone) will be refused.
      </p>

      {disabled && (
        <p className="add-mcp-server-forbidden" data-testid="add-mcp-server-forbidden-banner" role="alert">
          This connection isn't using the primary API token, so adding or removing MCP servers is
          refused here — connect from the device with direct/physical access to this machine and its
          primary API token.
        </p>
      )}

      <label className="add-mcp-server-field">
        <span>Name</span>
        <input
          type="text"
          data-testid="add-mcp-server-name"
          value={fields.name}
          disabled={disabled}
          onChange={(e) => setFields((f) => ({ ...f, name: e.target.value }))}
          placeholder="filesystem"
        />
      </label>

      <label className="add-mcp-server-field">
        <span>Scope</span>
        <select
          data-testid="add-mcp-server-scope"
          value={scope}
          disabled={disabled}
          onChange={(e) => setScope(e.target.value as McpConfigScope)}
        >
          <option value="user">User (this machine)</option>
          <option value="project">Project (this working directory)</option>
        </select>
      </label>

      <div className="add-mcp-server-transport" role="radiogroup" aria-label="Transport">
        <label>
          <input
            type="radio"
            name="mcp-transport"
            data-testid="add-mcp-server-transport-stdio"
            checked={transport === 'stdio'}
            disabled={disabled}
            onChange={() => setTransport('stdio')}
          />
          Local command (stdio)
        </label>
        <label>
          <input
            type="radio"
            name="mcp-transport"
            data-testid="add-mcp-server-transport-remote"
            checked={transport === 'remote'}
            disabled={disabled}
            onChange={() => setTransport('remote')}
          />
          Remote (http/https)
        </label>
      </div>

      {transport === 'stdio' ? (
        <>
          <label className="add-mcp-server-field">
            <span>Command</span>
            <input
              type="text"
              data-testid="add-mcp-server-command"
              value={fields.command}
              disabled={disabled}
              onChange={(e) => setFields((f) => ({ ...f, command: e.target.value }))}
              placeholder="npx"
            />
          </label>
          <label className="add-mcp-server-field">
            <span>Args (one per line)</span>
            <textarea
              data-testid="add-mcp-server-args"
              value={fields.argsText}
              disabled={disabled}
              onChange={(e) => setFields((f) => ({ ...f, argsText: e.target.value }))}
              rows={2}
            />
          </label>
          <label className="add-mcp-server-field">
            <span>Env (KEY=VALUE, one per line)</span>
            <textarea
              data-testid="add-mcp-server-env"
              value={fields.envText}
              disabled={disabled}
              onChange={(e) => setFields((f) => ({ ...f, envText: e.target.value }))}
              rows={2}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </>
      ) : (
        <>
          <label className="add-mcp-server-field">
            <span>URL</span>
            <input
              type="text"
              data-testid="add-mcp-server-url"
              value={fields.url}
              disabled={disabled}
              onChange={(e) => setFields((f) => ({ ...f, url: e.target.value }))}
              placeholder="https://example.com/mcp"
            />
          </label>
          <label className="add-mcp-server-field">
            <span>Headers (KEY=VALUE, one per line)</span>
            <textarea
              data-testid="add-mcp-server-headers"
              value={fields.headersText}
              disabled={disabled}
              onChange={(e) => setFields((f) => ({ ...f, headersText: e.target.value }))}
              rows={2}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </>
      )}

      <p className="add-mcp-server-trust-notice" data-testid="add-mcp-server-trust-notice">
        Adding a server does not run it. The daemon will still prompt to confirm before the first
        spawn — even for a name you trusted before, since trust is keyed to the exact command, args,
        and environment.
      </p>

      {error && (
        <p className="add-mcp-server-error" data-testid="add-mcp-server-error" role="alert">
          {error}
        </p>
      )}

      <div className="add-mcp-server-actions">
        <button
          type="button"
          data-testid="add-mcp-server-cancel"
          onClick={() => {
            resetFields();
            setError(null);
            setOpen(false);
          }}
        >
          Cancel
        </button>
        <button type="submit" data-testid="add-mcp-server-submit" disabled={disabled || submitting}>
          {submitting ? 'Adding…' : 'Add server'}
        </button>
      </div>
    </form>
  );
}
