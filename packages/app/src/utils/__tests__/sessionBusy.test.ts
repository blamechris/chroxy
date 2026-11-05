import { isSessionBusy } from '../sessionBusy';

/**
 * #8261 — `sessions[].isBusy` is a `session_list` snapshot (create / destroy /
 * switch). The live per-turn channel (`stream_start` / `result` ->
 * `session_activity`, `agent_idle`) moves `sessionStates[id].isIdle`, so a
 * snapshot taken mid-turn left the dot on after the turn ended. The rendered
 * surfaces are covered by components/__tests__/SessionBusyDot.test.tsx.
 */
describe('isSessionBusy (#8261)', () => {
  it('is NOT busy once the live state is idle, even if the snapshot said busy', () => {
    expect(isSessionBusy({ isBusy: true }, { isIdle: true })).toBe(false);
  });

  it('is busy while the live state says a turn is running', () => {
    expect(isSessionBusy({ isBusy: false }, { isIdle: false })).toBe(true);
  });

  it('falls back to the snapshot when no live state is seeded', () => {
    expect(isSessionBusy({ isBusy: true }, undefined)).toBe(true);
    expect(isSessionBusy({ isBusy: false }, undefined)).toBe(false);
  });
});
