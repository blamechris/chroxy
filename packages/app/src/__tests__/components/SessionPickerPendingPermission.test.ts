import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from '@chroxy/store-core';
// #5759 — the predicate now lives in store-core (shared with the dashboard).
import { countLivePermissionPrompts } from '@chroxy/store-core';

/**
 * SessionPicker pill — "needs your permission" dot (#5750).
 *
 * Mobile parity with the dashboard's per-tab pending-permission indicator
 * (#5667 / #5674): a background session blocked on a permission prompt now
 * surfaces an amber dot so the user can find which session is waiting without
 * tab-hunting. Two layers covered here:
 *
 *  1. `countLivePermissionPrompts` — the predicate (behavioral unit test).
 *  2. The pill wiring (source-text, mirroring SessionPickerPendingShells).
 */

const now = 1_000_000;
function prompt(over: Partial<ChatMessage> = {}): ChatMessage {
  // Minimal live permission prompt: type:'prompt' + requestId + future expiresAt + no answer.
  return { id: 'm', type: 'prompt', requestId: 'req-1', expiresAt: now + 60_000, ...over } as ChatMessage;
}

describe('countLivePermissionPrompts (#5750)', () => {
  it('counts a live, unanswered permission prompt', () => {
    expect(countLivePermissionPrompts([prompt()], now)).toBe(1);
  });

  it('counts multiple live prompts (e.g. parallel SDK tool calls)', () => {
    expect(countLivePermissionPrompts([prompt(), prompt({ requestId: 'req-2' })], now)).toBe(2);
  });

  it('ignores an answered prompt', () => {
    expect(countLivePermissionPrompts([prompt({ answered: 'allow' })], now)).toBe(0);
  });

  it('ignores an expired prompt (expiresAt <= now)', () => {
    expect(countLivePermissionPrompts([prompt({ expiresAt: now - 1 })], now)).toBe(0);
  });

  it('ignores an AskUserQuestion prompt (no requestId / no expiresAt)', () => {
    // type:'prompt' but without the requestId+expiresAt pair that marks a
    // *permission* prompt — must not trip the indicator.
    expect(countLivePermissionPrompts([{ id: 'q', type: 'prompt' } as ChatMessage], now)).toBe(0);
    expect(countLivePermissionPrompts([prompt({ expiresAt: undefined })], now)).toBe(0);
    expect(countLivePermissionPrompts([prompt({ requestId: undefined })], now)).toBe(0);
  });

  it('ignores non-prompt messages', () => {
    expect(countLivePermissionPrompts([{ id: 't', type: 'text' } as unknown as ChatMessage], now)).toBe(0);
  });

  it('returns 0 for an empty message list', () => {
    expect(countLivePermissionPrompts([], now)).toBe(0);
  });
});

describe('SessionPicker pill — pending-permission dot wiring (#5750)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionPicker.tsx'),
    'utf-8',
  );
  const pillStartIdx = source.indexOf('function SessionPill');
  const pillEndIdx = source.indexOf('const styles', pillStartIdx);
  if (pillStartIdx < 0 || pillEndIdx < 0 || pillEndIdx <= pillStartIdx) {
    throw new Error('Unable to locate the SessionPill render block in SessionPicker.tsx');
  }
  const pillSection = source.slice(pillStartIdx, pillEndIdx);

  it('the pill takes a pendingPermissionCount prop', () => {
    expect(source).toMatch(/pendingPermissionCount:\s*number/);
    expect(pillSection).toMatch(/pendingPermissionCount/);
  });

  it('shows the permission dot only on a non-active, non-crashed tab with a pending prompt', () => {
    expect(pillSection).toMatch(/showPendingPermission\s*=\s*!isCrashed\s*&&\s*!isActive\s*&&\s*pendingPermissionCount\s*>\s*0/);
  });

  it('the permission state takes precedence over the generic busy pulse', () => {
    // A session waiting on the user is more actionable than "processing".
    expect(pillSection).toMatch(/showBusy\s*=\s*!isCrashed\s*&&\s*!showPendingPermission/);
  });

  it('renders a permissionDot with its dedicated style', () => {
    expect(pillSection).toMatch(/styles\.permissionDot/);
    expect(source).toMatch(/permissionDot:\s*\{/);
  });

  it('announces the waiting state to screen readers', () => {
    expect(pillSection).toMatch(/waiting for your permission/);
    expect(pillSection).toMatch(/allow or deny a permission request/);
  });

  it('SessionPicker derives per-session counts and passes them to the pill', () => {
    expect(source).toMatch(/countLivePermissionPrompts/);
    expect(source).toMatch(/pendingPermissionCount=\{pendingPermissionCounts\.get/);
  });
});
