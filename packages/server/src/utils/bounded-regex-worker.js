// Worker-thread side of utils/bounded-regex.js: compiles a pattern (cached) and
// tests one string, off the daemon's event loop. It holds no state that matters:
// the owner terminates it whenever a match runs past its deadline.
import { parentPort } from 'node:worker_threads'

const MAX_CACHED = 64
const cache = new Map()

function compile(source) {
  if (cache.has(source)) return cache.get(source)
  let re = null
  try {
    re = new RegExp(source, 'i')
  } catch {
    re = null
  }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value)
  cache.set(source, re)
  return re
}

parentPort.on('message', ({ id, source, text }) => {
  const re = compile(source)
  parentPort.postMessage({ id, matched: re ? re.test(text) : false })
})
