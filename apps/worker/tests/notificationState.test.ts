import { describe, expect, it } from 'vitest';
import {
  updateEligibility,
  updatePaperEntries,
} from '../src/ui/notificationState.js';
import { MINT, OTHER_MINT } from '../../../tests/fixtures.js';
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const token = { mint: MINT, assessedAt: at(0), validUntil: at(60) };
const snapshot = (seconds: number, tokens = [token], truncated = false) => ({
  checkedAt: at(seconds),
  tokens,
  truncated,
});
describe('eligible token notification transitions', () => {
  it('alerts for existing eligible tokens on first use, then suppresses repeats across page loads', () => {
    const first = updateEligibility({}, snapshot(1));
    expect(first.arrivals).toEqual([token]);
    const reload = updateEligibility(
      JSON.parse(JSON.stringify(first.state)),
      snapshot(5),
    );
    expect(reload.arrivals).toEqual([]);
  });
  it('keeps uninterrupted risk renewals quiet, including a delayed browser poll', () => {
    const first = updateEligibility({}, snapshot(1));
    const renewed = { ...token, assessedAt: at(55), validUntil: at(115) };
    expect(
      updateEligibility(first.state, snapshot(70, [renewed])).arrivals,
    ).toEqual([]);
  });
  it('alerts after losing and then regaining eligibility', () => {
    const first = updateEligibility({}, snapshot(1));
    const lost = updateEligibility(first.state, snapshot(5, []));
    expect(lost.state[MINT]?.active).toBe(false);
    expect(updateEligibility(lost.state, snapshot(10)).arrivals).toEqual([
      token,
    ]);
  });
  it('alerts after an expired assessment is replaced without continuous coverage', () => {
    const first = updateEligibility({}, snapshot(1));
    const renewed = { ...token, assessedAt: at(70), validUntil: at(130) };
    expect(
      updateEligibility(first.state, snapshot(80, [renewed])).arrivals,
    ).toEqual([renewed]);
  });
  it('never notifies for expired or future observations', () => {
    expect(updateEligibility({}, snapshot(60)).arrivals).toEqual([]);
    expect(updateEligibility({}, snapshot(-1)).arrivals).toEqual([]);
  });
  it('does not mistake a truncated result for loss of eligibility', () => {
    const first = updateEligibility({}, snapshot(1));
    const other = { ...token, mint: OTHER_MINT };
    const partial = updateEligibility(first.state, snapshot(5, [other], true));
    expect(partial.state[MINT]?.active).toBe(true);
    expect(updateEligibility(partial.state, snapshot(10)).arrivals).toEqual([]);
  });
});

describe('paper entry decision notifications', () => {
  const first = { id: 'account-a:candidate-1', status: 'QUEUED', mint: MINT };
  const later = { id: 'account-a:candidate-2', status: 'QUEUED', mint: MINT };
  const data = (entries = [first]) => ({ checkedAt: at(5), entries });
  it('baselines existing history without showing old decisions as new', () => {
    const result = updatePaperEntries(null, data());
    expect(result.arrivals).toEqual([]);
    expect(result.state.seen[first.id]).toBeDefined();
  });
  it('notifies for new decisions, including another entry for the same token', () => {
    const baseline = updatePaperEntries(null, data());
    expect(
      updatePaperEntries(baseline.state, data([later, first])).arrivals,
    ).toEqual([later]);
  });
  it('does not repeat on execution status changes, polling, or page reloads', () => {
    const baseline = updatePaperEntries(null, data());
    const reload = JSON.parse(JSON.stringify(baseline.state));
    expect(
      updatePaperEntries(reload, data([{ ...first, status: 'FILLED' }]))
        .arrivals,
    ).toEqual([]);
  });
  it('keeps decisions for different accounts distinct', () => {
    const baseline = updatePaperEntries(null, data());
    const other = { ...first, id: 'account-b:candidate-1' };
    expect(
      updatePaperEntries(baseline.state, data([other, first])).arrivals,
    ).toEqual([other]);
  });
  it('remembers decisions that disappear from a bounded recent list', () => {
    const baseline = updatePaperEntries(null, data());
    const empty = updatePaperEntries(baseline.state, data([]));
    expect(updatePaperEntries(empty.state, data()).arrivals).toEqual([]);
  });
});
