import { getSessionStatus, formatCost, getStatusColor, SessionStatus } from '../../components/SessionOverview';

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

  describe('formatCost', () => {
    it('returns "\u2014" for null', () => {
      expect(formatCost(null)).toBe('\u2014');
    });

    it('returns "\u2014" for 0', () => {
      expect(formatCost(0)).toBe('\u2014');
    });

    it('formats cents for small amounts', () => {
      expect(formatCost(0.0042)).toBe('$0.00');
    });

    it('formats dollars with 2 decimals', () => {
      expect(formatCost(1.234)).toBe('$1.23');
    });

    it('formats large amounts', () => {
      expect(formatCost(12.5)).toBe('$12.50');
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
