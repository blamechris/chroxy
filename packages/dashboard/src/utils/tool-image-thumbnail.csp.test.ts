/**
 * #6810 -- policy pin: the thumbnail must be an image source the dashboard's
 * Content-Security-Policy allows.
 *
 * The first cut of #6810 produced `blob:` URLs. jsdom does not enforce CSP, so
 * every unit test passed while a real browser rendered every thumbnail broken
 * (`img-src 'self' data:`). This test reads the CSP the server and the Tauri
 * shell actually ship and checks the scheme the thumbnail really uses, so a
 * move back to object URLs goes red here instead of in a smoke test.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { downscaleToDataUri } from './tool-image-thumbnail'
import { installThumbnailStubs, type ThumbnailStubs } from './tool-image-thumbnail-stubs'

const REPO = resolve(__dirname, '../../../..')

function imgSrcDirectives(file: string, marker: RegExp): string[][] {
  const text = readFileSync(resolve(REPO, file), 'utf8')
  const out: string[][] = []
  for (const line of text.split('\n')) {
    if (!marker.test(line)) continue
    for (const m of line.matchAll(/img-src ([^;"]*)/g)) out.push((m[1] ?? '').trim().split(/\s+/))
  }
  return out
}

/** CSP source-expression match for a URL we are about to put in `<img src>`. */
function allows(sources: string[], url: string): boolean {
  const scheme = url.slice(0, url.indexOf(':') + 1) // e.g. "data:"
  return sources.some((s) => s === scheme)
}

let stubs: ThumbnailStubs | null = null
afterEach(() => {
  stubs?.restore()
  stubs = null
})

describe('thumbnail src vs the shipped img-src CSP (#6810)', () => {
  const policies: Array<[string, string[][]]> = [
    ['dashboard (http-routes.js)', imgSrcDirectives('packages/server/src/http-routes.js', /'Content-Security-Policy':/)],
    ['Tauri csp/devCsp (tauri.conf.json)', imgSrcDirectives('packages/desktop/src-tauri/tauri.conf.json', /"(csp|devCsp)":/)],
  ]

  it('actually found the policies it is checking', () => {
    for (const [name, found] of policies) {
      expect(found.length, `no img-src found for ${name}`).toBeGreaterThan(0)
    }
  })

  it('the downscaled thumbnail is a scheme every shipped img-src allows', async () => {
    stubs = installThumbnailStubs()
    const uri = await downscaleToDataUri({ mediaType: 'image/png', data: btoa('x') })
    expect(uri).not.toBeNull()
    expect(uri!.startsWith('blob:')).toBe(false)
    for (const [name, found] of policies) {
      for (const sources of found) {
        expect(allows(sources, uri!), `${name}: img-src ${sources.join(' ')} rejects ${uri!.slice(0, 12)}`).toBe(true)
      }
    }
  })
})
