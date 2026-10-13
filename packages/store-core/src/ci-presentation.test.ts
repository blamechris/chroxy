import { describe, expect, it } from 'vitest'
import { describeNoPrStatus } from './ci-presentation'
import type { ServerSessionPrStatusMessage } from '@chroxy/protocol'

describe('no-PR presentation', () => {
  const snapshot = (reason: string | null) => ({ reason }) as ServerSessionPrStatusMessage
  it('uses No repo only for the explicit non-repository reason', () => {
    expect(describeNoPrStatus(snapshot('session working directory is not a git repository'))).toEqual({ label: 'No repo', reason: null })
  })
  it('keeps missing snapshots distinct from a verified no-PR result', () => {
    expect(describeNoPrStatus(snapshot(null))).toEqual({ label: 'No PR', reason: null })
  })
  it.each(['gh pr list failed: authentication required', 'session working directory no longer exists', 'no GitHub remote'])('keeps %s visible as an unavailable survey', reason => {
    expect(describeNoPrStatus(snapshot(reason))).toEqual({ label: 'CI unavailable', reason })
  })
})
