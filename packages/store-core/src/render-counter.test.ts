import { describe, it, expect, beforeEach } from 'vitest'
import {
  bumpRenderCount,
  getRenderCount,
  resetRenderCounts,
  renderCountSnapshot,
} from './render-counter'

describe('render-counter', () => {
  beforeEach(() => resetRenderCounts())

  it('starts at 0 for an unknown label', () => {
    expect(getRenderCount('nope')).toBe(0)
  })

  it('increments and returns the running tally', () => {
    expect(bumpRenderCount('a')).toBe(1)
    expect(bumpRenderCount('a')).toBe(2)
    expect(getRenderCount('a')).toBe(2)
  })

  it('tracks labels independently', () => {
    bumpRenderCount('a')
    bumpRenderCount('b')
    bumpRenderCount('b')
    expect(getRenderCount('a')).toBe(1)
    expect(getRenderCount('b')).toBe(2)
  })

  it('reset clears one label or all', () => {
    bumpRenderCount('a')
    bumpRenderCount('b')
    resetRenderCounts('a')
    expect(getRenderCount('a')).toBe(0)
    expect(getRenderCount('b')).toBe(1)
    resetRenderCounts()
    expect(getRenderCount('b')).toBe(0)
  })

  it('snapshot reflects all tracked labels', () => {
    bumpRenderCount('a')
    bumpRenderCount('a')
    bumpRenderCount('b')
    expect(renderCountSnapshot()).toEqual({ a: 2, b: 1 })
  })
})
