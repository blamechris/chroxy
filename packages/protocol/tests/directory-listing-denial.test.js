import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DIRECTORY_LISTING_DENIED_PREFIX, isDirectoryListingDenial } from '../src/index.ts'

/**
 * #8303 — the one marker the server's Browse refusal and the dashboard's
 * recognition share. Pinned directly, not only through its two consumers.
 */
describe('DIRECTORY_LISTING_DENIED_PREFIX / isDirectoryListingDenial', () => {
  it('the prefix is "Access denied"', () => {
    assert.equal(DIRECTORY_LISTING_DENIED_PREFIX, 'Access denied')
  })

  it('recognises the refusal: the prefix, a colon, then any text', () => {
    assert.equal(isDirectoryListingDenial(`${DIRECTORY_LISTING_DENIED_PREFIX}: directory listing is restricted`), true)
    assert.equal(isDirectoryListingDenial('Access denied: x'), true)
  })

  it('does not recognise other listing errors or non-strings', () => {
    for (const v of ['Directory not found', 'Permission denied', 'Not a directory', 'Access denied', 'access denied: x', ' Access denied: x', '', null, undefined, 7, {}]) {
      assert.equal(isDirectoryListingDenial(v), false, String(v))
    }
  })
})
