/**
 * EventNormalizer error mapping — `resume_unknown` payload forwarding (#4947)
 *
 * Pins the contract for the `error` event coming out of CliSession's
 * resume-failure path (server PR #4944): the normalizer must forward both
 * `code` AND `attemptedResumeId` onto the wire so the dashboard
 * ResumeUnknownChip (#4947) can surface the attempted id as subtext for
 * operator correlation against the persisted state file
 * (`resumeConversationId` in `~/.chroxy/session-state.json`).
 *
 * Pre-fix this normalizer dropped every field except `data.message` and
 * `data.code` — the (Optional) acceptance-criterion subtext on the chip
 * would never have a value to render. The original PR #4944 review comment
 * called this out explicitly: "no dashboard/WS consumer reads it today".
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventNormalizer } from '../src/event-normalizer.js'

describe('EventNormalizer error mapping — #4947', () => {
  const ctx = { sessionId: 'sess-1', mode: 'multi', getSessionEntry: () => null }

  it('forwards attemptedResumeId onto the wire message for resume_unknown errors', () => {
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'resume_unknown',
      message: 'Previous Claude conversation could not be resumed',
      attemptedResumeId: 'abc123-def456-7890',
    }, ctx)
    assert.ok(result && Array.isArray(result.messages) && result.messages.length === 1)
    const msg = result.messages[0].msg
    assert.equal(msg.type, 'message')
    assert.equal(msg.messageType, 'error')
    assert.equal(msg.code, 'resume_unknown')
    assert.equal(msg.attemptedResumeId, 'abc123-def456-7890',
      'attemptedResumeId must round-trip the wire so ResumeUnknownChip can correlate')
  })

  it('omits attemptedResumeId on the wire when the field is missing', () => {
    // Generic errors (no resume attempt) must continue to flow through
    // the normalizer unchanged — wire stays at the legacy 3-field shape
    // (type, messageType, content, timestamp, [code]).
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      message: 'something exploded',
    }, ctx)
    assert.ok(result && Array.isArray(result.messages) && result.messages.length === 1)
    const msg = result.messages[0].msg
    assert.equal(msg.attemptedResumeId, undefined,
      'normalizer must NOT add an empty attemptedResumeId field — that would render "Attempted id: " with no value')
  })

  it('omits attemptedResumeId on the wire when the field is empty string', () => {
    // Defensive: a producer that defaults to '' rather than undefined must
    // not pollute the wire with an empty slot. The chip's render guard
    // already treats whitespace-only as absent, but normalising at the
    // wire boundary means the dashboard message-handler sees a consistent
    // shape and downstream consumers (mobile app) get the same treatment
    // without re-implementing the guard.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'resume_unknown',
      message: 'x',
      attemptedResumeId: '',
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.attemptedResumeId, undefined)
  })

  it('omits attemptedResumeId on the wire when the field is not a string', () => {
    // Defense in depth — the wire schema (ServerMessageSchema) constrains
    // attemptedResumeId to a string, but the event-normalizer is upstream
    // of any wire-level validation. Drop non-string payloads here so a
    // malformed producer can't reach the dashboard with junk on the field.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'resume_unknown',
      message: 'x',
      attemptedResumeId: 42,
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.attemptedResumeId, undefined)
  })

  // PR #4967 Copilot review hardening: gate-on-code + trim + 256-char cap.
  it('omits attemptedResumeId when code is not resume_unknown (out-of-contract gating)', () => {
    // The field is documented as set only on resume_unknown errors. A
    // buggy producer attaching it to other error codes should NOT reach
    // the wire — keeps the contract clean and prevents downstream
    // consumers from special-casing junk.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'stream_stall',
      message: 'x',
      attemptedResumeId: 'abc123',
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.attemptedResumeId, undefined,
      'attemptedResumeId must not flow through on non-resume_unknown errors')
  })

  it('trims whitespace from attemptedResumeId before emitting', () => {
    // Defensive normalisation at the wire boundary — same UX guard the
    // dashboard chip applies at render time, but enforced upstream so
    // every downstream consumer sees the same shape.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'resume_unknown',
      message: 'x',
      attemptedResumeId: '  abc123  ',
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.attemptedResumeId, 'abc123')
  })

  it('omits attemptedResumeId on the wire when only whitespace', () => {
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'resume_unknown',
      message: 'x',
      attemptedResumeId: '   \t  ',
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.attemptedResumeId, undefined)
  })

  it('truncates attemptedResumeId to 256 chars (matches wire schema cap)', () => {
    // The wire schema rejects > 256 chars, but the server doesn't
    // self-validate outgoing messages against ServerMessageSchema. Enforce
    // the cap here so a misbehaving producer can't ship a megabyte id
    // that the dashboard accepts (lax client parse) but trips Zod-
    // validating consumers. Silently truncate rather than drop — the
    // truncated id still helps operator triage.
    const oversized = 'a'.repeat(500)
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'resume_unknown',
      message: 'x',
      attemptedResumeId: oversized,
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.attemptedResumeId, 'a'.repeat(256))
  })
})
