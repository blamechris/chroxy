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
 *
 * #7968 added `floored: boolean` — the permission-floor verdict (see
 * docs/security/permission-floor.md) — to this same envelope. Unlike
 * `description`/`remainingMs`/`sessionId`, `floored` is NEVER conditionally
 * omitted: every emit site must state whether the floor forced this prompt,
 * so the field is required in the builder's TS signature (a caller cannot
 * forget it) while the wire SCHEMA keeps it optional — so a client parsing an
 * OLDER server's message (built before #7968, with no `floored` key at all)
 * still parses successfully and just sees the field absent. This mirrors the
 * existing `input` field's "required in TS, permissive at runtime" shape
 * (see the builder's own comment), which is what makes the builder a real
 * drift guard rather than a schema-enforced one.
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
        floored: true,
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
        floored: true,
      })
    })

    it('omits optional fields entirely when absent (absent, not null)', () => {
      const msg = buildPermissionRequestMessage({
        requestId: 'req-2',
        tool: 'Read',
        input: { file_path: '/etc/hosts' },
        floored: false,
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
        floored: false,
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
        floored: false,
      })
      assert.equal(msg.remainingMs, 0)
      assert.equal(ServerPermissionRequestSchema.safeParse(msg).success, true)
    })

    // #7968 — floored is ALWAYS present when the builder is used, unlike the
    // conditionally-omitted optionals above. Both booleans are exercised so a
    // hardcoded `floored: true` (or `false`) in the builder is caught.
    it('always includes floored on the message, true or false, never omitted', () => {
      const msgTrue = buildPermissionRequestMessage({
        requestId: 'req-9a', tool: 'Read', input: {}, floored: true,
      })
      const msgFalse = buildPermissionRequestMessage({
        requestId: 'req-9b', tool: 'Read', input: {}, floored: false,
      })
      assert.equal(msgTrue.floored, true)
      assert.equal(msgFalse.floored, false)
      assert.ok('floored' in msgTrue)
      assert.ok('floored' in msgFalse)
    })

    // #7968 — the SCHEMA side of the contract: a client must be able to parse
    // a `permission_request` from an OLDER server that predates this field
    // entirely (not even present as `undefined` — genuinely absent), so an
    // old-server/new-client pairing keeps working. Constructed as a raw
    // literal (not via the builder) because the builder always sets the
    // field on a NEW server; this simulates what an old server actually sent.
    it('the schema tolerates a permission_request with no floored field at all (older server)', () => {
      const oldServerMessage = {
        type: 'permission_request',
        requestId: 'req-10',
        tool: 'Bash',
        input: { command: 'ls' },
      }
      const result = ServerPermissionRequestSchema.safeParse(oldServerMessage)
      assert.equal(result.success, true)
      assert.ok(!('floored' in oldServerMessage))
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

    it('throws when floored is the wrong type', () => {
      assert.throws(
        () => buildPermissionRequestMessage({
          requestId: 'req-11',
          tool: 'Bash',
          input: {},
          floored: 'true',
        }),
        /invalid permission_request/,
      )
    })
  })
})
