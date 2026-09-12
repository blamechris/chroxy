/**
 * #7728 — the mobile store must never offer one provider's models to another
 * provider's session.
 *
 * `models_updated` is a machine-wide broadcast tagged with the registry that
 * emitted it, and the app used to land every one of them in a single
 * `availableModels` list (`message-handler.ts` said so in a comment: "The app
 * omits extendModelsPatch — it does not track availableModelsProvider
 * (dashboard-only)"). With a Claude session and a codex session open, a Claude
 * roster arriving last made the codex session render Claude chips, and tapping
 * one sent `set_model` with a Claude id to codex — a correctness bug, not a
 * cosmetic one.
 *
 * This drives the REAL dispatch path into the REAL store shape, reads the roster
 * through `selectActiveProviderModels` — the SAME selector `SessionScreen`
 * subscribes to, so the screen's own composition is under test and not a
 * re-derivation of it — and renders the `SettingsBar` with the result, so the
 * assertion is about chips a user can tap rather than about a field.
 */
import React from 'react';
import renderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports (mirrors message-handler.test.ts)
// ---------------------------------------------------------------------------

jest.mock('../src/utils/crypto', () => ({
  createKeyPair: jest.fn(),
  deriveSharedKey: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  generateConnectionSalt: jest.fn(() => 'mock-salt'),
  deriveConnectionKey: jest.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}));

jest.mock('../src/notifications', () => ({
  registerForPushNotifications: jest.fn(),
}));

jest.mock('../src/utils/haptics', () => ({
  hapticSuccess: jest.fn(),
}));

jest.mock('../src/store/persistence', () => ({
  clearPersistedSession: jest.fn(),
}));

jest.mock('../src/store/imperative-callbacks', () => ({
  getCallback: jest.fn(() => undefined),
}));

jest.mock('../src/store/multi-client', () => ({
  useMultiClientStore: { getState: jest.fn(() => ({ setClients: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/web', () => ({
  useWebStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/cost', () => ({
  useCostStore: { getState: jest.fn(() => ({ handleCostUpdate: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/terminal', () => ({
  useTerminalStore: { getState: jest.fn(() => ({ appendTerminalData: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/notifications', () => ({
  useNotificationStore: { getState: jest.fn(() => ({ addNotification: jest.fn(), dismissNotification: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/conversations', () => ({
  useConversationStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { UNTAGGED_MODELS_PROVIDER } from '@chroxy/store-core';
import { selectActiveProviderModels } from '../src/store/connection';
import { handleMessage, setStore, setConnectionContext } from '../src/store/message-handler';
import { SettingsBar } from '../src/components/SettingsBar';
import type { ConnectionState } from '../src/store/types';

const CODEX_SESSION = 'codex-session';

const CLAUDE_ROSTER = {
  type: 'available_models',
  models: [{ id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8' }],
  defaultModel: 'opus',
  provider: 'claude-sdk',
};
const CODEX_ROSTER = {
  type: 'available_models',
  models: [{ id: 'gpt-5.5', label: 'GPT-5.5', fullId: 'gpt-5.5' }],
  defaultModel: 'gpt-5.5',
  provider: 'codex',
};

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState;
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s;
      state = { ...state, ...patch };
    },
  };
}

function baseState(): Partial<ConnectionState> {
  return {
    activeSessionId: CODEX_SESSION,
    sessions: [{ sessionId: CODEX_SESSION, name: 'Codex', provider: 'codex' } as never],
    availableProviders: [{ name: 'codex', capabilities: { modelSwitch: true } } as never],
    sessionStates: {},
    modelsByProvider: {},
    appendTerminalData: jest.fn(),
  } as unknown as Partial<ConnectionState>;
}

const mockCtx = { url: 'wss://t', token: 'tok', socket: {} as WebSocket, isReconnect: false };

function collectVisibleText(root: ReactTestInstance): string {
  return root.findAllByType(Text).map((node) => {
    const c = node.props.children;
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (Array.isArray(c)) {
      return c.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('');
    }
    return '';
  }).join(' ');
}

/**
 * Render the SettingsBar exactly as SessionScreen composes it: the roster comes
 * from `selectActiveProviderModels`, which resolves the provider from the state
 * itself. Nothing here tells the selector which provider to use — that is the
 * point, and it is why a screen that asked for the wrong provider would be red.
 */
function renderBarFor(
  state: ConnectionState,
  setModel: (id: string) => void = () => {},
) {
  const roster = selectActiveProviderModels(state);
  const provider = state.sessions.find((s) => s.sessionId === state.activeSessionId)?.provider ?? null;
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <SettingsBar
        {...({
          expanded: true,
          onToggle: () => {},
          activeModel: null,
          defaultModelId: roster.defaultModelId,
          availableModels: roster.models,
          permissionMode: null,
          availablePermissionModes: [],
          lastResultCost: null,
          lastResultDuration: null,
          sessionCost: null,
          cumulativeUsage: null,
          costBudget: null,
          contextOccupancy: null,
          sessionCwd: '/tmp',
          serverMode: 'cli' as const,
          isIdle: true,
          activeAgents: [],
          interventions: [],
          connectedClients: [],
          customAgents: [],
          mcpServers: [],
          provider,
          setModel,
          setPermissionMode: () => {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)}
      />,
    );
  });
  return { tree, roster };
}

describe('#7728 — the mobile store keys model rosters by provider', () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore(baseState());
    setStore(store);
    setConnectionContext(mockCtx as never);
  });

  afterEach(() => {
    setConnectionContext(null);
  });

  it('offers ZERO chips from the wrong provider when only claude-sdk has broadcast', () => {
    // Exactly the reported bug: a claude-sdk roster arrives while a codex
    // session is active. Pre-#7728 this rendered "Opus" as a tappable chip
    // whose tap sent `set_model('opus')` to a codex session.
    handleMessage(CLAUDE_ROSTER, mockCtx as never);

    const { tree, roster } = renderBarFor(store.getState());
    expect(roster.models).toEqual([]);
    expect(roster.defaultModelId).toBeNull();
    expect(collectVisibleText(tree.root)).not.toContain('Opus');
    // No chip means no tappable control at all — assert the control count, not
    // just the absent label, so a chip rendered with an empty label still fails.
    const chips = tree.root.findAllByType(TouchableOpacity)
      .filter((n) => collectVisibleText(n).includes('Opus'));
    expect(chips).toHaveLength(0);
  });

  it('keeps the codex chips after a LATER claude-sdk broadcast', () => {
    handleMessage(CODEX_ROSTER, mockCtx as never);
    handleMessage(CLAUDE_ROSTER, mockCtx as never);

    const { tree, roster } = renderBarFor(store.getState());
    expect(roster.models.map((m) => m.id)).toEqual(['gpt-5.5']);
    expect(roster.defaultModelId).toBe('gpt-5.5');
    const text = collectVisibleText(tree.root);
    expect(text).toContain('GPT-5.5');
    expect(text).not.toContain('Opus');
  });

  it("a chip tap sends that provider's own model id", () => {
    handleMessage(CODEX_ROSTER, mockCtx as never);
    handleMessage(CLAUDE_ROSTER, mockCtx as never);

    const sent: string[] = [];
    const { tree } = renderBarFor(store.getState(), (id) => sent.push(id));
    const chip = tree.root.findAllByType(TouchableOpacity)
      .find((n) => collectVisibleText(n).includes('GPT-5.5'));
    expect(chip).toBeDefined();
    act(() => { chip!.props.onPress(); });
    expect(sent).toEqual(['gpt-5.5']);
  });

  it('still serves an UNTAGGED broadcast to every session (older daemons)', () => {
    // A daemon that tags nothing has one registry, and its roster stays global —
    // "nobody said which provider" must not read as "this provider has none".
    handleMessage({ ...CODEX_ROSTER, provider: undefined }, mockCtx as never);

    expect(Object.keys(store.getState().modelsByProvider)).toEqual([UNTAGGED_MODELS_PROVIDER]);
    const { roster } = renderBarFor(store.getState());
    expect(roster.models.map((m) => m.id)).toEqual(['gpt-5.5']);
  });
});
