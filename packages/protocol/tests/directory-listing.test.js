import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ListDirectorySchema } from '../src/schemas/client.ts'
import { ServerDirectoryListingSchema } from '../src/schemas/server/file-ops.ts'

const request = { type: 'list_directory', path: '~/project' }
const reply = { type: 'directory_listing', path: '/home/project', parentPath: '/home', entries: [], error: null }
describe('directory listing request correlation', () => {
  for (const [schema, frame] of [[ListDirectorySchema, request], [ServerDirectoryListingSchema, reply]]) {
    it(`${frame.type} preserves an optional request id`, () => {
      assert.equal(schema.parse({ ...frame, requestId: 'directory-1' }).requestId, 'directory-1')
      assert.equal('requestId' in schema.parse(frame), false)
    })
    it(`${frame.type} rejects malformed request ids`, () => {
      assert.equal(schema.safeParse({ ...frame, requestId: 1 }).success, false)
      assert.equal(schema.safeParse({ ...frame, requestId: 'x'.repeat(201) }).success, false)
    })
  }
})
