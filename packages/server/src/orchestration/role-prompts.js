/**
 * Role preambles + per-turn prompt builders + the repo-audit preset for the
 * orchestration harness (engine, epic #6691, step E-2).
 *
 * The PREAMBLE (role framing) goes in the session preamble, which is silently
 * capped at SESSION_PREAMBLE_MAX_LENGTH (4000) — so preambles stay short and
 * the structured-output CONTRACT travels in the per-turn prompts (which are not
 * capped), appended via decision-contract's `decisionInstruction`.
 */

import { decisionInstruction } from './decision-contract.js'

export const ARCHITECT_PREAMBLE = [
  'You are the ARCHITECT of a code-audit committee. You decompose an audit goal',
  'into independent subtasks, review each worker\'s plan-of-attack before it runs,',
  'review each worker\'s result after, and finally synthesize a report.',
  'You never edit files yourself. Be concrete and terse. Every turn ends with a',
  'single fenced `chroxy-decision` JSON block, exactly as the turn instructs —',
  'no prose after it. Absence of a valid block is treated as a failure, never as',
  'approval, so always emit one.',
].join(' ')

export const AUDIT_WORKER_PREAMBLE = [
  'You are an AUDIT WORKER on a code-audit committee. You investigate one subtask',
  'READ-ONLY: read and search the codebase, reason about it, and report findings.',
  'You do NOT edit files, run mutating commands, or fetch the network. First you',
  'propose a short plan-of-attack for the architect to approve; then you execute',
  'and report a result summary. Every turn ends with a single fenced',
  '`chroxy-decision` JSON block, exactly as the turn instructs — no prose after it.',
].join(' ')

export function architectPreamble() { return ARCHITECT_PREAMBLE }
export function auditWorkerPreamble() { return AUDIT_WORKER_PREAMBLE }

const join = (...parts) => parts.filter((p) => p != null && p !== '').join('\n\n')

/** Architect: decompose the epic goal into subtasks. */
export function buildPlanPrompt({ goal, repoMap = '', maxSubtasks = 8 }) {
  return join(
    `Decompose this audit goal into at most ${maxSubtasks} INDEPENDENT subtasks, each a distinct area of the repo. Each subtask has role "audit".`,
    `GOAL:\n${goal}`,
    repoMap ? `REPO MAP (partial):\n${repoMap}` : null,
    decisionInstruction('epic_plan'),
  )
}

/** Worker: propose a plan-of-attack for one subtask. */
export function buildPoaPrompt({ subtask }) {
  return join(
    `Propose a brief plan-of-attack for this audit subtask, then wait for approval.`,
    `SUBTASK: ${subtask.title}\nGOAL: ${subtask.goal}`,
    subtask.successCriteria ? `SUCCESS CRITERIA: ${subtask.successCriteria}` : null,
    decisionInstruction('plan_of_attack'),
  )
}

/** Architect: review a worker's plan-of-attack. */
export function buildPoaReviewPrompt({ subtask, poa }) {
  return join(
    `Review this worker's plan-of-attack for subtask "${subtask.title}".`,
    `PLAN:\n${poa.plan}`,
    `Verdict: approve (proceed), revise (send feedback, same worker retries), redelegate (fresh worker), or escalate (to the user).`,
    decisionInstruction('poa_review'),
  )
}

/** Worker: execute the (approved) subtask and report a result. */
export function buildExecutePrompt({ subtask, feedback = null }) {
  return join(
    `Carry out the audit for subtask "${subtask.title}" and report your findings.`,
    feedback ? `ARCHITECT FEEDBACK to address:\n${feedback}` : null,
    decisionInstruction('work_result'),
  )
}

/** Architect: review a worker's result. */
export function buildResultReviewPrompt({ subtask, result }) {
  return join(
    `Review this worker's audit result for subtask "${subtask.title}".`,
    `RESULT:\n${result.summary}`,
    `Verdict: approve (accept), revise (send feedback, same worker retries), redelegate (fresh worker), or escalate.`,
    decisionInstruction('result_review'),
  )
}

/** Architect: synthesize the accepted results into a report. */
export function buildSynthesisPrompt({ goal, results = [] }) {
  const body = results.map((r, i) => `## ${i + 1}. ${r.title}\n${r.summary}`).join('\n\n')
  return join(
    `Synthesize the committee's audit results into one markdown report for this goal.`,
    `GOAL:\n${goal}`,
    `RESULTS:\n${body || '(none)'}`,
    decisionInstruction('synthesis'),
  )
}

export const REPO_AUDIT_PRESET = Object.freeze({
  name: 'repo-audit',
  goalTemplate:
    'Perform a full self-audit of this repository: correctness bugs, security issues, '
    + 'dead code, missing test coverage, and documentation drift. Decompose the work by area.',
  // Every subtask in an audit run is read-only, regardless of what the architect
  // proposes — the engine coerces role:'implement' to 'audit' with a warning.
  forceRole: 'audit',
})

export function presetFor(name) {
  return name === 'repo-audit' ? REPO_AUDIT_PRESET : null
}
