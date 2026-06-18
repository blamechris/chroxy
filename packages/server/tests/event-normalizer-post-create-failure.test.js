/**
 * EventNormalizer error mapping — `post_create_command_failed` stdout/stderr
 * forwarding (#5067)
 *
 * Pins the contract for the `error` event coming out of DockerByokSession's
 * postCreateCommand failure path (PR #5091): the normalizer must forward
 * `code`, `stdout`, AND `stderr` onto the wire so operators looking at the
 * dashboard error toast can diagnose without re-running the broken setup.
 *
 * Pre-fix this normalizer dropped every field except `data.message` and
 * `data.code` — the session layer captured both streams (PR #5091) but the
 * normalizer silently discarded them at the wire boundary. The Copilot
 * review on PR #5091 called this out: "stdout/stderr are attached to the
 * session error payload here, but they won't currently reach operators
 * because event-normalizer.js's error mapping only forwards data.message
 * (and maybe code)."
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventNormalizer } from '../src/event-normalizer.js'

describe('EventNormalizer error mapping — #5067 post_create_command_failed', () => {
  const ctx = { sessionId: 'sess-1', mode: 'multi', getSessionEntry: () => null }

  it('forwards stdout AND stderr onto the wire message for post_create_command_failed errors', () => {
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'post_create_command_failed',
      message: 'docker-byok postCreateCommand failed: npm ERR! missing package.json',
      stdout: 'Bootstrapping...\nERROR: missing required env var ACME_TOKEN\nAborting.\n',
      stderr: 'npm ERR! code ENOENT\nnpm ERR! syscall open\nnpm ERR! missing package.json',
    }, ctx)
    assert.ok(result && Array.isArray(result.messages) && result.messages.length === 1)
    const msg = result.messages[0].msg
    assert.equal(msg.type, 'message')
    assert.equal(msg.messageType, 'error')
    assert.equal(msg.code, 'post_create_command_failed')
    assert.match(msg.stdout, /ERROR: missing required env var ACME_TOKEN/,
      'stdout must round-trip the wire so operators can see the bootstrap diagnostic')
    assert.match(msg.stderr, /npm ERR! missing package\.json/,
      'stderr must round-trip the wire so operators can see the npm diagnostic')
  })

  it('omits stdout/stderr on the wire when the fields are absent', () => {
    // Generic errors (no post-create capture) must continue to flow through
    // the normalizer unchanged — wire stays at the legacy shape.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      message: 'something exploded',
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.stdout, undefined)
    assert.equal(msg.stderr, undefined)
  })

  it('omits stdout/stderr on the wire when the fields are empty string', () => {
    // Defensive: silent streams normalise to empty string in
    // docker-byok-session.js (the `?? ''` guard); they must NOT pollute
    // the wire with empty slots. Receivers see a consistent "present or
    // absent, never present-but-empty" shape.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'post_create_command_failed',
      message: 'x',
      stdout: '',
      stderr: '',
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.stdout, undefined)
    assert.equal(msg.stderr, undefined)
  })

  it('omits stdout/stderr on the wire when the fields are not strings', () => {
    // Defense in depth — the wire schema (ServerMessageSchema) constrains
    // stdout/stderr to strings, but event-normalizer is upstream of any
    // wire-level validation. Drop non-string payloads here so a malformed
    // producer can't reach the dashboard with junk on the fields.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'post_create_command_failed',
      message: 'x',
      stdout: 42,
      stderr: { not: 'a string' },
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.stdout, undefined)
    assert.equal(msg.stderr, undefined)
  })

  it('omits stdout/stderr when code is NOT post_create_command_failed (out-of-contract gating)', () => {
    // The fields are documented as set only on post_create_command_failed
    // errors. A buggy producer attaching them to other error codes should
    // NOT reach the wire — keeps the contract clean and prevents
    // downstream consumers from special-casing junk. Same gating pattern
    // as attemptedResumeId on resume_unknown.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'docker_error',
      message: 'x',
      stdout: 'should not flow through',
      stderr: 'should not flow through either',
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.stdout, undefined,
      'stdout must not flow through on non-post_create_command_failed errors')
    assert.equal(msg.stderr, undefined,
      'stderr must not flow through on non-post_create_command_failed errors')
  })

  it('truncates stdout to 8 KiB (matches wire schema cap)', () => {
    // The session layer tail-caps to 4 KiB (POST_CREATE_OUTPUT_CAP_BYTES),
    // and the wire schema declares an 8 KiB ceiling. Enforce the cap here
    // so a misbehaving producer can't ship a megabyte payload that the
    // dashboard accepts (lax client parse) but trips Zod-validating
    // consumers. Slice rather than drop — the truncated tail still helps
    // operator triage.
    const oversized = 'a'.repeat(20_000)
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'post_create_command_failed',
      message: 'x',
      stdout: oversized,
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.stdout.length, 8192)
  })

  it('truncates stderr to 8 KiB (matches wire schema cap)', () => {
    const oversized = 'b'.repeat(20_000)
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'post_create_command_failed',
      message: 'x',
      stderr: oversized,
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.stderr.length, 8192)
  })

  it('forwards just stdout when stderr is silent', () => {
    // Bootstrap-script shape: `echo "ERROR: ..."` to stdout before exit.
    // The motivating case from issue #5067.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'post_create_command_failed',
      message: 'docker-byok postCreateCommand failed: ',
      stdout: 'Bootstrapping...\nERROR: missing required env var ACME_TOKEN\n',
      stderr: '',
    }, ctx)
    const msg = result.messages[0].msg
    assert.match(msg.stdout, /ERROR: missing required env var/)
    assert.equal(msg.stderr, undefined)
  })

  it('forwards just stderr when stdout is silent', () => {
    // npm-install shape: per-package errors land on stderr, stdout is
    // empty by the time the command exits non-zero.
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('error', {
      code: 'post_create_command_failed',
      message: 'docker-byok postCreateCommand failed: npm ERR! ...',
      stdout: '',
      stderr: 'npm ERR! code ENOENT\nnpm ERR! missing package.json',
    }, ctx)
    const msg = result.messages[0].msg
    assert.equal(msg.stdout, undefined)
    assert.match(msg.stderr, /npm ERR! missing package\.json/)
  })
})
