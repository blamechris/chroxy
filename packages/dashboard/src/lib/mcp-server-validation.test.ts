/**
 * #6999 — mcp-server-validation tests. Each case mirrors a real server-side
 * rejection from packages/server/src/byok-mcp-config.js so the add-form's
 * client-side check stays in sync with the actual write-path validator.
 */
import { describe, it, expect } from 'vitest';
import { validateMcpServerName, validateMcpServerConfig, MCP_SERVER_NAME_RE } from './mcp-server-validation';

describe('validateMcpServerName (#6999)', () => {
  it('accepts a valid lowercase identifier', () => {
    expect(validateMcpServerName('filesystem')).toBeNull();
    expect(validateMcpServerName('ccd_session_mgmt')).toBeNull();
    expect(validateMcpServerName('a')).toBeNull();
    expect(validateMcpServerName('a-b-c')).toBeNull();
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(validateMcpServerName('')).toBe('Name is required.');
    expect(validateMcpServerName('   ')).toBe('Name is required.');
  });

  it('rejects a name that does not start with a lowercase letter', () => {
    expect(validateMcpServerName('1abc')).toMatch(/lowercase identifier/);
    expect(validateMcpServerName('-abc')).toMatch(/lowercase identifier/);
  });

  it('rejects uppercase characters', () => {
    expect(validateMcpServerName('MyServer')).toMatch(/lowercase identifier/);
  });

  it('rejects a name over 64 characters', () => {
    const tooLong = 'a' + 'b'.repeat(64);
    expect(tooLong.length).toBe(65);
    expect(validateMcpServerName(tooLong)).toMatch(/lowercase identifier/);
  });

  it('rejects a name containing "__" (the MCP tool-namespace separator)', () => {
    expect(validateMcpServerName('a__b')).toMatch(/tool-namespace separator/);
    expect(validateMcpServerName('server__x')).toMatch(/tool-namespace separator/);
  });

  it('rejects reserved names (constructor / prototype)', () => {
    expect(validateMcpServerName('constructor')).toMatch(/reserved/);
    expect(validateMcpServerName('prototype')).toMatch(/reserved/);
  });

  it('__proto__ is caught by the reserved check before the charset regex', () => {
    // Leading underscore also fails MCP_SERVER_NAME_RE, but the reserved
    // check runs first and gives a clearer message either way.
    expect(validateMcpServerName('__proto__')).toMatch(/reserved/);
  });

  it('MCP_SERVER_NAME_RE matches the server-side pattern shape', () => {
    expect(MCP_SERVER_NAME_RE.test('filesystem')).toBe(true);
    expect(MCP_SERVER_NAME_RE.test('Filesystem')).toBe(false);
  });
});

describe('validateMcpServerConfig (#6999)', () => {
  it('accepts a minimal stdio config', () => {
    expect(validateMcpServerConfig({ command: 'npx' })).toBeNull();
  });

  it('accepts a minimal remote (http) config', () => {
    expect(validateMcpServerConfig({ url: 'https://example.com/mcp' })).toBeNull();
  });

  it('rejects a config with neither command nor url', () => {
    expect(validateMcpServerConfig({})).toMatch(/Provide either a command/);
  });

  it('rejects a config carrying BOTH command and url (ambiguous transport)', () => {
    const err = validateMcpServerConfig({ command: 'npx', url: 'https://example.com/mcp' });
    expect(err).toMatch(/cannot carry both/);
  });

  it('rejects a non-http(s) url scheme', () => {
    expect(validateMcpServerConfig({ url: 'file:///etc/passwd' })).toMatch(/must be http\(s\)/);
    expect(validateMcpServerConfig({ url: 'ws://example.com' })).toMatch(/must be http\(s\)/);
  });

  it('rejects an unparseable url', () => {
    expect(validateMcpServerConfig({ url: 'not a url' })).toBe('url is not a valid URL.');
  });

  it('rejects a url targeting the cloud-metadata / link-local range', () => {
    expect(validateMcpServerConfig({ url: 'http://169.254.169.254/latest/meta-data' })).toMatch(
      /cloud-metadata/,
    );
  });

  it('rejects a reserved key in env (stdio)', () => {
    const err = validateMcpServerConfig({ command: 'npx', env: { constructor: 'x' } });
    expect(err).toMatch(/env key 'constructor' is reserved/);
  });

  it('rejects a reserved key in headers (remote)', () => {
    const err = validateMcpServerConfig({ url: 'https://example.com', headers: { constructor: 'x' } });
    expect(err).toMatch(/headers key 'constructor' is reserved/);
  });

  it('rejects an env carrying "__proto__" as an OWN key (the real wire shape after JSON.parse, not a literal-syntax setter)', () => {
    // `{ __proto__: 'x' }` as object-literal syntax hits the Object.prototype
    // setter and never becomes an own key — but a message parsed off the wire
    // via JSON.parse DOES produce a real own "__proto__" property (JSON.parse
    // uses [[DefineOwnProperty]], not assignment). Round-trip through
    // JSON.parse so this test exercises the shape that actually reaches the
    // validator in production, matching the server's own UNSAFE_MAP_KEYS note.
    const env = JSON.parse('{"__proto__":"secret-value"}') as Record<string, string>;
    expect(Object.prototype.hasOwnProperty.call(env, '__proto__')).toBe(true);
    const err = validateMcpServerConfig({ command: 'npx', env });
    expect(err).toMatch(/env key '__proto__' is reserved/);
  });

  it('accepts a stdio config with args and safe env', () => {
    expect(
      validateMcpServerConfig({ command: 'npx', args: ['-y', 'some-pkg'], env: { API_KEY: 'secret' } }),
    ).toBeNull();
  });

  it('accepts a remote config with safe headers', () => {
    expect(
      validateMcpServerConfig({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }),
    ).toBeNull();
  });
});
