import { describe, expect, it } from 'vitest'
import * as git from './git'
import type { GitFileStatus } from '../types'

// These classify canonical cwd-relative status paths for the clients. Server
// containment remains authoritative; this is not a general path validator.
describe('git status outside-session selection (#8187)', () => {
  it.each(['../sibling.txt', '../../other/file', '..'])('classifies %s outside', path => {
    expect(git.isGitPathOutsideCwd(path)).toBe(true)
  })
  it.each(['inside.txt', 'dir/file', '..notes', 'dir/../literal', ''])('does not reject in-folder status spelling %s', path => {
    expect(git.isGitPathOutsideCwd(path)).toBe(false)
  })
  it.each([
    { path: '../new', oldPath: 'old', status: 'renamed' as const },
    { path: 'new', oldPath: '../old', status: 'renamed' as const },
    { path: '../new', oldPath: '../../old', status: 'renamed' as const },
    { path: '../plain', status: 'modified' as const },
  ])('marks the whole outside entry $path nonselectable', entry => {
    expect(git.isGitFileOutsideCwd(entry)).toBe(true)
    expect(git.expandRenamePathsForStaging([entry.path], [entry])).toEqual([])
  })
  it('drops directly selected outside paths even without matching entries', () => {
    expect(git.expandRenamePathsForStaging(['../outside', 'inside', '../../outside'], [])).toEqual(['inside'])
  })
  it('preserves both halves of an in-folder rename in first-seen order', () => {
    const entries: GitFileStatus[] = [{ path: 'new', oldPath: 'dir/old', status: 'renamed' }]
    expect(git.isGitFileOutsideCwd(entries[0]!)).toBe(false)
    expect(git.expandRenamePathsForStaging(['plain', 'new', 'new', 'dir/old'], entries)).toEqual(['plain', 'dir/old', 'new'])
  })
  it('retains legitimate independent source selection beside an outside rename', () => {
    const entries: GitFileStatus[] = [{ path: '../new', oldPath: 'old', status: 'renamed' }, { path: 'old', status: 'modified' }]
    expect(git.expandRenamePathsForStaging(['../new', 'old'], entries)).toEqual(['old'])
  })
  it('keeps COPY source independent even if it is outside', () => {
    const entry: GitFileStatus = { path: 'copy', oldPath: '../source', status: 'copied' }
    expect(git.isGitFileOutsideCwd(entry)).toBe(false)
    expect(git.expandRenamePathsForStaging(['copy'], [entry])).toEqual(['copy'])
  })
  it('handles empty and repeated selections without changing inputs', () => {
    const entries: GitFileStatus[] = [{ path: 'new', oldPath: '../old', status: 'renamed' }, { path: 'ok', status: 'modified' }]
    const paths = ['new', 'ok', 'new', 'ok']
    expect(git.expandRenamePathsForStaging([], entries)).toEqual([])
    expect(git.expandRenamePathsForStaging(paths, entries)).toEqual(['ok'])
    expect(paths).toEqual(['new', 'ok', 'new', 'ok'])
    expect(entries[0]!.oldPath).toBe('../old')
  })
  it('uses current status entries, not a cached rename classification', () => {
    expect(git.expandRenamePathsForStaging(['new'], [{ path: 'new', oldPath: 'old', status: 'renamed' }])).toEqual(['old', 'new'])
    expect(git.expandRenamePathsForStaging(['new'], [{ path: 'new', oldPath: '../old', status: 'renamed' }])).toEqual([])
    expect(git.expandRenamePathsForStaging(['new'], [{ path: 'new', status: 'modified' }])).toEqual(['new'])
  })
})
