/**
 * SettingsScreen — Session Rules UI tests (#2434)
 *
 * Uses static source analysis consistent with existing app test patterns.
 */
import * as fs from 'fs';
import * as path from 'path';

const settingsSource = fs.readFileSync(
  path.resolve(__dirname, '../../screens/SettingsScreen.tsx'),
  'utf-8',
);

const typesSource = fs.readFileSync(
  path.resolve(__dirname, '../../store/types.ts'),
  'utf-8',
);

const connectionSource = fs.readFileSync(
  path.resolve(__dirname, '../../store/connection.ts'),
  'utf-8',
);

describe('SettingsScreen — Session Rules section (#2434)', () => {
  it('renders a SESSION RULES section header', () => {
    expect(settingsSource).toMatch(/SESSION RULES/);
  });

  it('shows "No active rules" when sessionRules is empty', () => {
    expect(settingsSource).toMatch(/No active rules/);
  });

  it('reads sessionRules from the active session state', () => {
    expect(settingsSource).toMatch(/sessionRules/);
  });

  it('renders rule chips with tool name and decision label', () => {
    expect(settingsSource).toMatch(/auto-allow/);
    expect(settingsSource).toMatch(/auto-deny/);
  });

  it('includes a remove control on each chip (× character)', () => {
    // Rendered as unicode \u00d7 (multiplication sign ×)
    expect(settingsSource).toMatch(/\\u00d7/);
  });

  it('has a "Clear All Rules" button that calls setPermissionRules with empty array', () => {
    expect(settingsSource).toMatch(/Clear All Rules/);
    expect(settingsSource).toMatch(/setPermissionRules\(\[\]\)/);
  });

  it('removes individual rule by filtering out the tapped index', () => {
    expect(settingsSource).toMatch(/sessionRules\.filter/);
  });

  it('gates the section on activeSessionId being non-null', () => {
    expect(settingsSource).toMatch(/activeSessionId\s*!=\s*null/);
  });
});

describe('PermissionRule type in types.ts (#2434)', () => {
  it('defines the PermissionRule interface', () => {
    expect(typesSource).toMatch(/interface PermissionRule/);
  });

  it('PermissionRule has tool, decision, and optional pattern fields', () => {
    expect(typesSource).toMatch(/tool:\s*string/);
    expect(typesSource).toMatch(/decision:\s*'allow'\s*\|\s*'deny'/);
    expect(typesSource).toMatch(/pattern\?:\s*string/);
  });

  it('SessionState includes sessionRules as an optional field', () => {
    expect(typesSource).toMatch(/sessionRules\?:\s*PermissionRule\[\]/);
  });

  it('ConnectionState declares setPermissionRules action', () => {
    expect(typesSource).toMatch(/setPermissionRules/);
  });
});

describe('setPermissionRules action in connection.ts (#2434)', () => {
  it('implements setPermissionRules that sends set_permission_rules over WebSocket', () => {
    expect(connectionSource).toMatch(/setPermissionRules/);
    expect(connectionSource).toMatch(/set_permission_rules/);
  });

  it('includes sessionId in the payload when a session is active', () => {
    // The pattern matches: includes sessionId in the payload for setPermissionRules
    const setRulesBlock = connectionSource.match(/setPermissionRules[\s\S]{0,300}sessionId/);
    expect(setRulesBlock).not.toBeNull();
  });
});
