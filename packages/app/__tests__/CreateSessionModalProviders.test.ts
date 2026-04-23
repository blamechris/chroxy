/**
 * Tests for CreateSessionModal's dynamic provider list (issue #2948).
 *
 * The mobile modal previously hardcoded a 3-item PROVIDERS list containing
 * only Claude variants, so mobile users could not create Codex or Gemini
 * sessions even though the server supported them. After #2948, the modal
 * must render providers from the server's `list_providers` response.
 *
 * These are source-scanning tests (in the style of ComponentRendering.test.ts).
 * They assert the implementation shape rather than rendering the component.
 */

import fs from 'fs';
import path from 'path';

const modalSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/components/CreateSessionModal.tsx'),
  'utf-8',
);

const connectionSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/store/connection.ts'),
  'utf-8',
);

const typesSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/store/types.ts'),
  'utf-8',
);

const messageHandlerSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/store/message-handler.ts'),
  'utf-8',
);

describe('CreateSessionModal — dynamic providers (#2948)', () => {
  test('no hardcoded non-empty PROVIDERS entries for specific providers', () => {
    // The old PROVIDERS array had literal ids like 'claude-sdk'/'claude-cli';
    // after #2948 these must come from the store, not a hardcoded constant.
    expect(modalSrc).not.toMatch(/id:\s*['"]claude-sdk['"]/);
    expect(modalSrc).not.toMatch(/id:\s*['"]claude-cli['"]/);
  });

  test('reads availableProviders from connection store', () => {
    expect(modalSrc).toMatch(/useConnectionStore\([\s\S]*availableProviders/);
  });

  test('invokes fetchProviders when the modal opens', () => {
    expect(modalSrc).toMatch(/fetchProviders/);
  });

  test('renders provider label via the shared label helper with name fallback', () => {
    // Must render a human-readable label (e.g. "Claude Code (SDK)") and fall
    // back to the raw provider name if unknown. The helper (getProviderLabel)
    // or the raw PROVIDER_LABELS map is acceptable — both end up in the same
    // lookup with the same fallback semantics.
    expect(modalSrc).toMatch(/getProviderLabel|PROVIDER_LABELS/);
  });

  test('iterates availableProviders to render chips', () => {
    expect(modalSrc).toMatch(/availableProviders[\s\S]*\.map\(/);
  });

  test('shows a loading placeholder while providers are empty', () => {
    // Fallback while list_providers has not yet responded.
    expect(modalSrc).toMatch(/Loading providers/i);
  });
});

describe('ConnectionState — providers fields (#2948)', () => {
  test('types.ts exports ProviderInfo interface', () => {
    expect(typesSrc).toMatch(/export\s+interface\s+ProviderInfo/);
  });

  test('ConnectionState declares availableProviders: ProviderInfo[]', () => {
    expect(typesSrc).toMatch(/availableProviders:\s*ProviderInfo\[\]/);
  });

  test('ConnectionState declares fetchProviders action', () => {
    expect(typesSrc).toMatch(/fetchProviders:\s*\(\)\s*=>/);
  });

  test('connection.ts initializes availableProviders: [] in default state', () => {
    expect(connectionSrc).toMatch(/availableProviders:\s*\[\]/);
  });

  test('connection.ts implements fetchProviders sending list_providers over WS', () => {
    expect(connectionSrc).toMatch(/fetchProviders:[\s\S]{0,200}list_providers/);
  });
});

describe('message-handler — provider_list + auth_ok (#2948)', () => {
  test('handles provider_list message and stores providers', () => {
    expect(messageHandlerSrc).toMatch(/case\s+['"]provider_list['"]/);
  });

  test('sends list_providers as a post-auth message', () => {
    expect(messageHandlerSrc).toMatch(/['"]list_providers['"]/);
  });
});
