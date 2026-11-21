/**
 * Rule variants for the freshness model's tests. Test-only: production code
 * sees only DEFAULT_POLICY.
 *
 * LITERAL: a rule read literally where the model had to choose
 * otherwise. Each is expected to fail a named invariant under generated
 * sequences; that failure is the evidence for the DESIGN-GAP the model marks.
 *
 * MUTANTS: one deliberately broken rule per invariant, to prove the
 * invariant suite can go red (the repository's "every guard must be proven to
 * fail" rule).
 */

import { DEFAULT_POLICY, isOwnerBlock, nextReminderAt, withPolicy } from '../model/policy.js'

// Any new report is a content change, keeping the model's forward-only rule
// so that only the one reading differs.
function anyNewRef(item, next) {
  if (next.at != null && item.contentAt != null && next.at <= item.contentAt) return false
  return next.ref !== item.contentRef
}

export const LITERAL = {
  // Acknowledgment frees the slot (as one statement of the rules has it).
  ackFreesSlot: { expect: 'I2', policy: withPolicy({ slotHolderStates: new Set(['active']) }) },
  // The transition table: any new report or prompt is a content change.
  anyNewReportIsContent: { expect: 'I6', policy: withPolicy({ contentChanged: anyNewRef }) },
  // The key table: `updated` keyed by the change's ref, content allowed to move back.
  contentMayMoveBack: {
    expect: 'I3a',
    policy: withPolicy({
      contentChanged(item, next) {
        if (item.origin === 'prompt') return next.ref !== item.contentRef
        return next.fingerprint !== item.fingerprint
      },
    }),
  },
  // The key table: only a send is looked up before it is made; a resumed step re-reads.
  reReadOnResume: { expect: 'I3a', policy: withPolicy({ reuseRecorded: () => null }) },
  // 8: a stale owner block matches no row but `inconclusive`.
  staleOwnerBlockInconclusive: {
    expect: 'I9',
    policy: withPolicy({
      classify(ev, config) {
        return DEFAULT_POLICY.classify({ ...ev, ownerBlock: false }, config)
      },
    }),
  },
  // The prompt origin: resolved only by an answer to the item's own (latest seen) prompt.
  onlyOwnPromptAnswer: {
    expect: 'I4a',
    policy: withPolicy({
      promptAnswered(item, current) {
        return current?.status === 'answered' ? item.contentRef : null
      },
    }),
  },
  // 8: the recheck trigger lists only working_unreported and waiting_on_background.
  noRecheckAfterOwnerWait: {
    expect: 'I7f',
    policy: withPolicy({
      needsRecheck(last, policy) {
        return policy.recheckAfter.has(last.classification)
      },
    }),
  },
}

/** Preemption read literally: no comparison of the two deadlines. */
export function literalPreempts(challenger, active, now, config) {
  if (challenger.kind !== 'owner_block' || challenger.deadline == null) return false
  if (challenger.deadline <= now) return false
  return challenger.deadline < nextReminderAt(active, config)
}

/** The default rule's one-candidate-per-session choice, with no budget. */
function onePerSession(candidates) {
  return DEFAULT_POLICY.selectInvestigations(candidates, { cycleBudget: Infinity, recheckBudget: Infinity })
}

export const MUTANTS = {
  I1a: withPolicy({ canShow: () => true }),
  I1b: withPolicy({
    // No upper bound on k: a reminder falls due every first interval.
    reminderDue(item, now, config) {
      const k = item.counters.reminders_used + 1
      const anchor = Math.max(item.lastShowAt ?? -Infinity, item.lastReturnAt ?? -Infinity)
      return now >= anchor + k * config.surface.reminder_after_minutes[0] * 60_000 ? k : null
    },
  }),
  // Two guards bound returns: the stored counter and the constant ordinal 1
  // in the key. The proof breaks both (see the test); each alone is I2b.
  I1c: withPolicy({ verifyFailedStep: () => 'returned', surfaceOrdinal: (step, ctx) => (step === 'returned' ? ctx.returns : DEFAULT_POLICY.surfaceOrdinal(step, ctx)) }),
  I2b: withPolicy({ verifyFailedStep: () => 'returned' }),
  I1d: withPolicy({ showIsCounted: () => false }),
  I2: withPolicy({ slotHolderStates: new Set() }),
  // The preempted item is not held behind a still-queued preemptor.
  I2c: withPolicy({ preemptorFirst: () => {} }),
  // "Front of its class" applied to deadline items as well; that alone is
  // rescued by the preemptor-first rule, so both are broken.
  'I2c.front': withPolicy({
    preemptorFirst: () => {},
    orderKey(item, now) {
      const hasDeadline = item.kind === 'owner_block' && item.deadline != null && item.deadline > now
      if (!hasDeadline) return DEFAULT_POLICY.orderKey(item, now)
      return [0, item.position?.rank ?? 1, item.position?.seq ?? 0, 0, item.deadline, item.itemId]
    },
  }),
  I3a: withPolicy({ reuseRecorded: () => null }),
  // Two independent guards stop a second send; see the test for why the
  // proof breaks both.
  I3b: withPolicy({ attemptAlreadyRecorded: () => false, attemptUsesOrdinal: false }),
  I4a: withPolicy({
    // Resolve only when the state leaves blocked.
    declaredResolvedBy(latest, opening, config) {
      if (!latest || !opening || latest.last_report_at <= opening.last_report_at) return false
      return !isOwnerBlock(latest, config) && latest.state !== 'blocked' && latest.state !== 'stalled'
    },
  }),
  I4b: withPolicy({
    // Resolve on any newer report, even one that is still an owner block.
    declaredResolvedBy(latest, opening) {
      return Boolean(latest && opening && latest.last_report_at > opening.last_report_at)
    },
  }),
  I5: withPolicy({ mayOpenEpisode: (item) => !item || !item.open }),
  I6: withPolicy({ contentChanged: anyNewRef }),
  I7a: withPolicy({ maxCycles: 3, secondCycleAfter: new Set(['inconclusive', 'running_claim_unverified', 'blocked_unresolved', 'waiting_on_owner', 'finished_unreported', 'gone', 'source_unreachable']) }),
  I7b: withPolicy({
    // Every holding trigger of a session runs, not one per session.
    selectInvestigations(candidates, budgets) {
      return DEFAULT_POLICY.selectInvestigations(candidates.map((c, i) => ({ ...c, key: `${c.key}#${i}` })), budgets)
    },
  }),
  I7c: withPolicy({
    selectInvestigations(candidates, budgets) {
      return DEFAULT_POLICY.selectInvestigations(candidates, { ...budgets, cycleBudget: Infinity, recheckBudget: Infinity })
    },
  }),
  I7d: withPolicy({
    // Rechecks drawn from the cycle budget, ahead of cycles.
    selectInvestigations(candidates, { cycleBudget }) {
      const one = onePerSession(candidates)
      return [...one.filter((c) => c.kind === 'recheck'), ...one.filter((c) => c.kind === 'cycle')].slice(0, cycleBudget)
    },
  }),
  I7e: withPolicy({
    // Newest onset first: an old onset can wait behind new ones.
    selectInvestigations(candidates, budgets) {
      return DEFAULT_POLICY.selectInvestigations(candidates.map((c) => ({ ...c, onsetSeq: -(c.onsetSeq ?? 0) })), budgets)
    },
  }),
  I7f: withPolicy({ surfaceFor: () => null }),
  I7g: withPolicy({
    // Old activity read as working, so a recheck never ends.
    classifyRecheck() {
      return 'working_unreported'
    },
  }),
  I8b: withPolicy({ reportAge: ({ lastReportAt, checkedAt }) => (checkedAt - lastReportAt) / 2 }),
  I8: withPolicy({ reportAge: ({ lastReportAt, checkedAt, previousCheckedAt }) => checkedAt - (previousCheckedAt ?? lastReportAt) }),
  // A model that starts a new onset at every tick: its own onset ids keep
  // every cycle count at one, so only the monitor's own onsets can see it.
  'I7a.onset': withPolicy({ startsNewOnset: () => true }),
  // Withdraw a prompt item as lapsed while a prompt is still pending.
  'I4b.lapsed': withPolicy({
    promptLapsed(item, current, latestReport) {
      return Boolean(latestReport && latestReport.last_report_at > (current?.raised_at ?? -Infinity))
    },
  }),
  // Never open a prompt item.
  I10: withPolicy({ mayOpenEpisode: (item, ref, origin) => (origin === 'prompt' ? false : DEFAULT_POLICY.mayOpenEpisode(item, ref, origin)) }),
  // Any open-turn event after the report counts as working, however old.
  'I7f.window': withPolicy({ withinActivityWindow: () => true }),
  I9: withPolicy({
    classify(ev, config) {
      return DEFAULT_POLICY.classify({ ...ev, ownerBlock: false }, config)
    },
  }),
}
