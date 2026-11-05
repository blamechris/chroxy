import * as fs from 'fs';
import * as path from 'path';
import { isSessionBusy } from '../sessionBusy';

/**
 * #8261 — `sessions[].isBusy` is a `session_list` snapshot (create / destroy /
 * switch). The live per-turn channel (`stream_start` / `result` ->
 * `session_activity`, `agent_idle`) moves `sessionStates[id].isIdle`, so a
 * snapshot taken mid-turn left the dot on after the turn ended.
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

describe('busy surfaces read the live state (#8261)', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

  it('SessionPicker derives showBusy from isSessionBusy, not session.isBusy', () => {
    const src = read('../../components/SessionPicker.tsx');
    expect(src.includes('isSessionBusy(')).toBe(true);
    expect(/showBusy\s*=[^;]*session\.isBusy/.test(src)).toBe(false);
  });

  it('SessionOverview derives isBusy from isSessionBusy', () => {
    const src = read('../../components/SessionOverview.tsx');
    expect(src.includes('isSessionBusy(')).toBe(true);
  });
});
