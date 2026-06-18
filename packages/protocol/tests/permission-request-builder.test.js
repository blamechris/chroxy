import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPermissionRequestMessage,
  ServerPermissionRequestSchema,
} from '@chroxy/protocol'

/**
 * #6031: the `permission_request` wire message was hand-built as raw object
 * literals at 4+ emit sites (ws-permissions.js HTTP-fallback + two resend
 * paths, event-normalizer.js), each free to drift its field set. The single
 * `buildPermissionRequestMessage` factory now constructs + safeParse-validates
 * every emit so a dropped/misnamed/mis-typed field is caught loudly instead of
 * shipping a malformed prompt that strands or mis-routes the permission.
 *
 * These tests pin both halves of the contract: a valid call produces a
 * schema-valid message, and a malformed call (missing required field, wrong
 * type) throws rather than returning a partial object.
 */
describe('buildPermissionRequestMessage (#6031)', () => {
  describe('valid input', () => {
    it('produces a schema-valid message with all fields', () => {
      const msg = buildPermissionRequestMessage({
        requestId: 'req-1',
        tool: 'Bash',
        description: 'ls -la',
        input: { command: 'ls -la' },
        remainingMs: 300_000,
        sessionId: 'sess-abc',
      })
      assert.equal(msg.type, 'permission_request')
      assert.equal(ServerPermissionRequestSchema.safeParse(msg).success, true)
      assert.deepEqual(msg, {
        type: 'permission_request',
        requestId: 'req-1',
        tool: 'Bash',
        description: 'ls -la',
        input: { command: 'ls -la' },
        remainingMs: 300_000,
        sessionId: 'sess-abc',
      })
    })

    it('omits optional fields entirely when absent (absent, not null)', () => {
      const msg = buildPermissionRequestMessage({
        requestId: 'req-2',
        tool: 'Read',
        input: { file_path: '/etc/hosts' },
      })
      assert.equal(ServerPermissionRequestSchema.safeParse(msg).success, true)
      assert.ok(!('description' in msg))
      assert.ok(!('remainingMs' in msg))
      // The binding field clients fall back on: absent, never null.
      assert.ok(!('sessionId' in msg))
    })

    it('passes input through as-is without re-redacting (shape guard only)', () => {
      // Callers redact BEFORE the builder (#6038); it must not touch values.
      const redacted = { command: 'export TOKEN=[redacted]' }
      const msg = buildPermissionRequestMessage({
        requestId: 'req-3',
        tool: 'Bash',
        description: '[redacted]',
        input: redacted,
      })
      assert.equal(msg.input, redacted)
      assert.equal(msg.description, '[redacted]')
    })

    it('accepts remainingMs of 0 (expired-but-present)', () => {
      const msg = buildPermissionRequestMessage({
        requestId: 'req-4',
        tool: 'Edit',
        input: {},
        remainingMs: 0,
      })
      assert.equal(msg.remainingMs, 0)
      assert.equal(ServerPermissionRequestSchema.safeParse(msg).success, true)
    })
  })

  describe('malformed input is rejected', () => {
    it('throws when requestId is missing', () => {
      assert.throws(
        () => buildPermissionRequestMessage({ tool: 'Bash', input: {} }),
        /invalid permission_request/,
      )
    })

    it('throws when tool is missing', () => {
      assert.throws(
        () => buildPermissionRequestMessage({ requestId: 'req-5', input: {} }),
        /invalid permission_request/,
      )
    })

    it('throws when requestId is the wrong type', () => {
      assert.throws(
        () => buildPermissionRequestMessage({ requestId: 123, tool: 'Bash', input: {} }),
        /invalid permission_request/,
      )
    })

    it('throws when description is the wrong type', () => {
      assert.throws(
        () => buildPermissionRequestMessage({
          requestId: 'req-6',
          tool: 'Bash',
          description: { not: 'a string' },
          input: {},
        }),
        /invalid permission_request/,
      )
    })

    it('throws when remainingMs is negative', () => {
      assert.throws(
        () => buildPermissionRequestMessage({
          requestId: 'req-7',
          tool: 'Bash',
          input: {},
          remainingMs: -1,
        }),
        /invalid permission_request/,
      )
    })

    it('throws when sessionId is the wrong type', () => {
      assert.throws(
        () => buildPermissionRequestMessage({
          requestId: 'req-8',
          tool: 'Bash',
          input: {},
          sessionId: 42,
        }),
        /invalid permission_request/,
      )
    })

    it('surfaces the offending field name in the error message', () => {
      assert.throws(
        () => buildPermissionRequestMessage({ tool: 'Bash', input: {} }),
        /requestId/,
      )
    })
  })
})
