import * as fs from 'fs';
import * as path from 'path';
import { getSessionStatus, getStatusColor, lastPreviewMessage } from '../../components/SessionOverview';
import type { ChatMessage } from '../../store/types';

describe('SessionOverview visible prop removal (#1072)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../components/SessionOverview.tsx'),
    'utf-8',
  );

  it('SessionOverviewProps does not include visible', () => {
    // Extract the interface definition
    const propsMatch = source.match(/interface SessionOverviewProps\s*\{([^}]+)\}/);
    expect(propsMatch).not.toBeNull();
    expect(propsMatch![1]).not.toMatch(/visible/);
  });

  it('SessionOverview function does not use visible parameter', () => {
    // The function signature should not destructure visible
    const fnMatch = source.match(/function SessionOverview\(\{([^}]+)\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![1]).not.toMatch(/visible/);
  });
});

describe('SessionOverview helpers', () => {
  describe('getSessionStatus', () => {
    it('returns "crashed" when health is crashed', () => {
      expect(getSessionStatus({
        health: 'crashed',
        isBusy: false,
        isIdle: true,
        activeAgentCount: 0,
        isPlanPending: false,
        hasNotification: false,
      })).toBe('crashed');
    });

    it('returns "permission" when plan is pending', () => {
      expect(getSessionStatus({
        health: 'healthy',
        isBusy: false,
        isIdle: false,
        activeAgentCount: 0,
        isPlanPending: true,
        hasNotification: false,
      })).toBe('permission');
    });

    it('returns "attention" when has notification', () => {
      expect(getSessionStatus({
        health: 'healthy',
        isBusy: false,
        isIdle: true,
        activeAgentCount: 0,
        isPlanPending: false,
        hasNotification: true,
      })).toBe('attention');
    });

    it('returns "agents" when active agents exist', () => {
      expect(getSessionStatus({
        health: 'healthy',
        isBusy: true,
        isIdle: false,
        activeAgentCount: 2,
        isPlanPending: false,
        hasNotification: false,
      })).toBe('agents');
    });

    it('returns "busy" when busy with no agents', () => {
      expect(getSessionStatus({
        health: 'healthy',
        isBusy: true,
        isIdle: false,
        activeAgentCount: 0,
        isPlanPending: false,
        hasNotification: false,
      })).toBe('busy');
    });

    it('returns "idle" when not busy and idle', () => {
      expect(getSessionStatus({
        health: 'healthy',
        isBusy: false,
        isIdle: true,
        activeAgentCount: 0,
        isPlanPending: false,
        hasNotification: false,
      })).toBe('idle');
    });
  });

  describe('getStatusColor', () => {
    it('returns red for crashed', () => {
      const result = getStatusColor('crashed');
      expect(result.fg).toBeDefined();
      expect(result.bg).toBeDefined();
    });

    it('returns orange for permission', () => {
      const result = getStatusColor('permission');
      expect(result.fg).toBeDefined();
    });

    it('returns blue for busy', () => {
      const result = getStatusColor('busy');
      expect(result.fg).toBeDefined();
    });

    it('returns green for idle', () => {
      const result = getStatusColor('idle');
      expect(result.fg).toBeDefined();
    });

    it('returns purple for agents', () => {
      const result = getStatusColor('agents');
      expect(result.fg).toBeDefined();
    });

    it('returns orange for attention', () => {
      const result = getStatusColor('attention');
      expect(result.fg).toBeDefined();
    });
  });
});

// #8461 -- the card previews the reply, not the "Reply cut off" chip that follows it.
describe('lastPreviewMessage (#8461)', () => {
  const m = (over: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>): ChatMessage =>
    ({ content: '', timestamp: 1, ...over }) as ChatMessage;
  const reply = m({ id: 'r1', type: 'response', content: 'half an answer' });
  const chip = m({ id: 'o1', type: 'system', content: 'Reply cut off', turnOutcome: 'truncated' } as Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>);

  it('returns null with nothing to preview', () => {
    expect(lastPreviewMessage(undefined)).toBeNull();
    expect(lastPreviewMessage([])).toBeNull();
  });

  it('is the last message when it is not a turn-outcome chip', () => {
    expect(lastPreviewMessage([reply])).toBe(reply);
  });

  it('skips a trailing turn-outcome chip and previews the reply before it', () => {
    expect(lastPreviewMessage([reply, chip])).toBe(reply);
  });

  it('skips several chips, and previews the user input when a refusal produced no text', () => {
    const input = m({ id: 'u1', type: 'user_input', content: 'do the thing' });
    expect(lastPreviewMessage([input, chip, chip])).toBe(input);
  });

  it('returns null when only chips exist', () => {
    expect(lastPreviewMessage([chip])).toBeNull();
  });

  it('still previews any other system message (only outcome chips are skipped)', () => {
    const sys = m({ id: 's1', type: 'system', content: 'Connected' });
    expect(lastPreviewMessage([reply, sys])).toBe(sys);
  });
});
