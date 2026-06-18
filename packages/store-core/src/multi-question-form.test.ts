import { describe, it, expect } from 'vitest'
import type { ChatMessageQuestion } from './types'
import {
  buildAnswersMap,
  computeCanSubmit,
  isSingleMultiSelectForm,
  setSingleSelect,
  toggleMultiSelect,
} from './multi-question-form'

const opt = (label: string, value = label) => ({ label, value })

const singleQ = (question: string): ChatMessageQuestion => ({
  question,
  options: [opt('A'), opt('B')],
})

const multiQ = (question: string): ChatMessageQuestion => ({
  question,
  options: [opt('X'), opt('Y'), opt('Z')],
  multiSelect: true,
})

describe('setSingleSelect (#5800)', () => {
  it('sets the chosen value at the given index immutably', () => {
    const prev = { 0: 'A' }
    const next = setSingleSelect(prev, 1, 'B')
    expect(next).toEqual({ 0: 'A', 1: 'B' })
    expect(prev).toEqual({ 0: 'A' }) // unchanged
  })

  it('overwrites an existing single-select value', () => {
    expect(setSingleSelect({ 0: 'A' }, 0, 'B')).toEqual({ 0: 'B' })
  })
})

describe('toggleMultiSelect (#5800)', () => {
  it('adds a value when absent', () => {
    expect(toggleMultiSelect({}, 0, 'X')).toEqual({ 0: ['X'] })
  })

  it('removes a value when already present', () => {
    expect(toggleMultiSelect({ 0: ['X', 'Y'] }, 0, 'X')).toEqual({ 0: ['Y'] })
  })

  it('appends to the existing array preserving order', () => {
    expect(toggleMultiSelect({ 0: ['X'] }, 0, 'Y')).toEqual({ 0: ['X', 'Y'] })
  })

  it('treats a missing index as an empty selection', () => {
    expect(toggleMultiSelect({ 1: ['Y'] }, 0, 'X')).toEqual({ 1: ['Y'], 0: ['X'] })
  })

  it('does not mutate the previous map', () => {
    const prev = { 0: ['X'] }
    toggleMultiSelect(prev, 0, 'Y')
    expect(prev).toEqual({ 0: ['X'] })
  })
})

describe('buildAnswersMap (#5800)', () => {
  it('keys by question text, single-select emits the chosen string', () => {
    const questions = [singleQ('Q1'), singleQ('Q2')]
    const state = { singleSelectByIdx: { 0: 'A', 1: 'B' }, multiSelectByIdx: {} }
    expect(buildAnswersMap(questions, state)).toEqual({ Q1: 'A', Q2: 'B' })
  })

  it('multi-select emits a native string[] of chosen values', () => {
    const questions = [multiQ('Q1')]
    const state = { singleSelectByIdx: {}, multiSelectByIdx: { 0: ['X', 'Z'] } }
    expect(buildAnswersMap(questions, state)).toEqual({ Q1: ['X', 'Z'] })
  })

  it('multi-select with no selection emits an empty array (SDK accepts zero)', () => {
    const questions = [multiQ('Q1')]
    const state = { singleSelectByIdx: {}, multiSelectByIdx: {} }
    expect(buildAnswersMap(questions, state)).toEqual({ Q1: [] })
  })

  it('omits an unanswered single-select question entirely', () => {
    const questions = [singleQ('Q1'), singleQ('Q2')]
    const state = { singleSelectByIdx: { 0: 'A' }, multiSelectByIdx: {} }
    expect(buildAnswersMap(questions, state)).toEqual({ Q1: 'A' })
  })

  it('mixes single and multi questions by position', () => {
    const questions = [singleQ('Q1'), multiQ('Q2')]
    const state = { singleSelectByIdx: { 0: 'A' }, multiSelectByIdx: { 1: ['Y'] } }
    expect(buildAnswersMap(questions, state)).toEqual({ Q1: 'A', Q2: ['Y'] })
  })
})

describe('computeCanSubmit (#5800)', () => {
  it('requires every single-select question to have a choice', () => {
    const questions = [singleQ('Q1'), singleQ('Q2')]
    expect(
      computeCanSubmit(questions, { singleSelectByIdx: { 0: 'A' }, multiSelectByIdx: {} }),
    ).toBe(false)
    expect(
      computeCanSubmit(questions, { singleSelectByIdx: { 0: 'A', 1: 'B' }, multiSelectByIdx: {} }),
    ).toBe(true)
  })

  it('allows multi-select questions to be empty', () => {
    const questions = [multiQ('Q1')]
    expect(computeCanSubmit(questions, { singleSelectByIdx: {}, multiSelectByIdx: {} })).toBe(true)
  })

  it('mixed form: only single-selects gate submission', () => {
    const questions = [singleQ('Q1'), multiQ('Q2')]
    expect(
      computeCanSubmit(questions, { singleSelectByIdx: {}, multiSelectByIdx: {} }),
    ).toBe(false)
    expect(
      computeCanSubmit(questions, { singleSelectByIdx: { 0: 'A' }, multiSelectByIdx: {} }),
    ).toBe(true)
  })
})

describe('isSingleMultiSelectForm (#5800)', () => {
  it('true for exactly one multiSelect question', () => {
    expect(isSingleMultiSelectForm([multiQ('Q1')])).toBe(true)
  })

  it('false for a single single-select question', () => {
    expect(isSingleMultiSelectForm([singleQ('Q1')])).toBe(false)
  })

  it('false for more than one question (even if multiSelect)', () => {
    expect(isSingleMultiSelectForm([multiQ('Q1'), multiQ('Q2')])).toBe(false)
  })

  it('false for an empty array', () => {
    expect(isSingleMultiSelectForm([])).toBe(false)
  })

  it('false for undefined / non-array', () => {
    expect(isSingleMultiSelectForm(undefined)).toBe(false)
  })
})
