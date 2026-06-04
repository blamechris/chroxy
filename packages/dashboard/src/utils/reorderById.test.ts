/**
 * Tests for the shared reorder utility used by sidebar (#4832) and
 * SessionBar (#4831) drag-to-reorder.
 */
import { describe, it, expect } from 'vitest'
import { applyOrderById, moveItem, orderToIds } from './reorderById'

describe('moveItem', () => {
  it('moves an item from one index to another', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('is a no-op when from === to', () => {
    const items = ['a', 'b', 'c']
    expect(moveItem(items, 1, 1)).toBe(items)
  })

  it('returns the same reference for single-element / empty arrays', () => {
    const empty: string[] = []
    expect(moveItem(empty, 0, 0)).toBe(empty)
    const one = ['only']
    expect(moveItem(one, 0, 0)).toBe(one)
  })

  it('clamps out-of-range indices', () => {
    expect(moveItem(['a', 'b', 'c'], -5, 10)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 10, -5)).toEqual(['c', 'a', 'b'])
  })

  it('does not mutate the input array', () => {
    const items = ['a', 'b', 'c']
    const result = moveItem(items, 0, 2)
    expect(items).toEqual(['a', 'b', 'c'])
    expect(result).not.toBe(items)
  })
})

describe('applyOrderById', () => {
  type Item = { id: string; name: string }
  const get = (i: Item) => i.id

  it('returns the items in saved order', () => {
    const items: Item[] = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ]
    const result = applyOrderById(items, ['c', 'a', 'b'], get)
    expect(result.map(get)).toEqual(['c', 'a', 'b'])
  })

  it('drops ids in the saved order that no longer exist', () => {
    const items: Item[] = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]
    const result = applyOrderById(items, ['ghost', 'a', 'gone', 'b'], get)
    expect(result.map(get)).toEqual(['a', 'b'])
  })

  it('appends items not in the saved order at the end, preserving input order', () => {
    const items: Item[] = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'newer', name: 'Newer' },
      { id: 'newest', name: 'Newest' },
    ]
    const result = applyOrderById(items, ['b', 'a'], get)
    expect(result.map(get)).toEqual(['b', 'a', 'newer', 'newest'])
  })

  it('returns the items as-is when no order is saved', () => {
    const items: Item[] = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]
    const result = applyOrderById(items, [], get)
    expect(result.map(get)).toEqual(['a', 'b'])
  })

  it('handles empty items list', () => {
    expect(applyOrderById<Item>([], ['a', 'b'], get)).toEqual([])
  })

  it('ignores duplicate ids in the saved order', () => {
    const items: Item[] = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]
    const result = applyOrderById(items, ['a', 'a', 'b', 'a'], get)
    expect(result.map(get)).toEqual(['a', 'b'])
  })
})

describe('orderToIds', () => {
  it('extracts ids using the getter', () => {
    type Item = { id: string }
    const items: Item[] = [{ id: 'x' }, { id: 'y' }]
    expect(orderToIds(items, (i) => i.id)).toEqual(['x', 'y'])
  })
})
