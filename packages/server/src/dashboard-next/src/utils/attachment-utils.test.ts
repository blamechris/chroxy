/**
 * Attachment wire format conversion tests (#1304)
 */
import { describe, it, expect } from 'vitest'
import { toWireAttachments } from './attachment-utils'

describe('toWireAttachments', () => {
  it('converts file attachments to file_ref wire format', () => {
    const result = toWireAttachments(
      [{ path: 'src/index.ts', name: 'index.ts' }],
      [],
    )
    expect(result).toEqual([
      { type: 'file_ref', path: 'src/index.ts', name: 'index.ts' },
    ])
  })

  it('converts image attachments to image wire format', () => {
    const result = toWireAttachments(
      [],
      [{ data: 'aGVsbG8=', mediaType: 'image/png', name: 'screenshot.png' }],
    )
    expect(result).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'screenshot.png' },
    ])
  })

  it('combines file and image attachments', () => {
    const result = toWireAttachments(
      [{ path: 'readme.md', name: 'readme.md' }],
      [{ data: 'abc=', mediaType: 'image/jpeg', name: 'photo.jpg' }],
    )
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: 'file_ref', path: 'readme.md', name: 'readme.md' })
    expect(result[1]).toEqual({ type: 'image', mediaType: 'image/jpeg', data: 'abc=', name: 'photo.jpg' })
  })

  it('returns empty array when no attachments', () => {
    expect(toWireAttachments([], [])).toEqual([])
  })

  it('returns empty array when both inputs are undefined', () => {
    expect(toWireAttachments(undefined, undefined)).toEqual([])
  })
})
