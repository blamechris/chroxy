/**
 * Mermaid fence detection/split tests (#6754).
 */
import { describe, it, expect } from 'vitest'
import { splitMermaidSegments, hasMermaidBlock, type MessageSegment } from './mermaid'

describe('hasMermaidBlock', () => {
  it('is false for empty / plain text', () => {
    expect(hasMermaidBlock('')).toBe(false)
    expect(hasMermaidBlock(undefined as unknown as string)).toBe(false)
    expect(hasMermaidBlock('just some prose about mermaids')).toBe(false)
  })

  it('is true for a complete mermaid fence', () => {
    expect(hasMermaidBlock('```mermaid\ngraph TD; A-->B\n```')).toBe(true)
  })

  it('is false for other-language fences', () => {
    expect(hasMermaidBlock('```js\nconst x = 1\n```')).toBe(false)
    expect(hasMermaidBlock('```\nplain\n```')).toBe(false)
  })

  it('is false for an unclosed (streaming) mermaid fence', () => {
    expect(hasMermaidBlock('```mermaid\ngraph TD; A-->B')).toBe(false)
  })

  it('matches the language token case-insensitively and ignores trailing info', () => {
    expect(hasMermaidBlock('```Mermaid\ngraph TD; A-->B\n```')).toBe(true)
    expect(hasMermaidBlock('```mermaid  title=x\ngraph TD; A-->B\n```')).toBe(true)
  })
})

describe('splitMermaidSegments', () => {
  const types = (segs: MessageSegment[]) => segs.map((s) => s.type)

  it('returns [] for empty input', () => {
    expect(splitMermaidSegments('')).toEqual([])
  })

  it('returns a single markdown segment when there is no mermaid fence', () => {
    const segs = splitMermaidSegments('# Title\n\n```js\nx()\n```')
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual({ type: 'markdown', content: '# Title\n\n```js\nx()\n```' })
  })

  it('extracts a lone mermaid fence as the inner source only', () => {
    const segs = splitMermaidSegments('```mermaid\ngraph TD; A-->B\n```')
    expect(types(segs)).toEqual(['mermaid'])
    expect(segs[0]!.content).toBe('graph TD; A-->B\n')
  })

  it('preserves surrounding markdown around a mermaid fence, in order', () => {
    const segs = splitMermaidSegments('intro text\n\n```mermaid\ngraph TD; A-->B\n```\n\noutro text')
    expect(types(segs)).toEqual(['markdown', 'mermaid', 'markdown'])
    expect(segs[0]!.content).toContain('intro text')
    expect(segs[1]!.content).toBe('graph TD; A-->B\n')
    expect(segs[2]!.content).toContain('outro text')
  })

  it('handles multiple mermaid fences interleaved with text', () => {
    const segs = splitMermaidSegments('a\n```mermaid\nA\n```\nb\n```mermaid\nB\n```\nc')
    expect(types(segs)).toEqual(['markdown', 'mermaid', 'markdown', 'mermaid', 'markdown'])
    expect(segs[1]!.content).toBe('A\n')
    expect(segs[3]!.content).toBe('B\n')
  })

  it('leaves other-language fences inside the markdown segment (does not split them)', () => {
    const segs = splitMermaidSegments('```js\nx()\n```\n\n```mermaid\ngraph TD; A-->B\n```')
    expect(types(segs)).toEqual(['markdown', 'mermaid'])
    // the js fence stays verbatim inside the markdown segment
    expect(segs[0]!.content).toContain('```js')
    expect(segs[0]!.content).toContain('x()')
  })

  it('treats an unclosed mermaid fence as plain markdown (streaming)', () => {
    const segs = splitMermaidSegments('```mermaid\ngraph TD; A-->B')
    expect(types(segs)).toEqual(['markdown'])
    expect(segs[0]!.content).toContain('```mermaid')
  })
})
