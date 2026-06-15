import { createLogger } from './logger.js'

// Defensive fallback so the guard can NEVER throw a TypeError inside its own
// error handler if a future caller omits `log` — that would defeat the whole
// point of a crash-prevention guard (Copilot review). Both current callers
// pass their own session/provider logger.
const _fallbackLog = createLogger('child-stream-guard')

/**
 * Shared EPIPE guard for a spawned child's stdout/stderr (#5324/#5361).
 *
 * A stream-level 'error' (EPIPE on a dying child, a read fault) emitted on
 * child.stdout/child.stderr with NO listener throws and crashes the WHOLE
 * daemon — readline does not attach an error handler to its input, so each
 * stream needs its own. We log + swallow: the matching process death already
 * surfaces via 'close' (exit code) or 'error' (spawn failure), which drive
 * teardown/respawn; the stream error itself carries no extra recoverable
 * signal beyond "the pipe broke".
 *
 * Extracted from the byte-divergent copies in cli-session.js and
 * jsonl-subprocess-session.js (audit P2-9). `destroying` is a GETTER, not a
 * boolean: both call sites attach this before the `_destroying` flag can flip,
 * so the guard must read it lazily on each error.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {{ destroying: () => boolean, log?: { warn: (m: string) => void }, label?: string }} opts
 */
export function guardChildStreams(child, { destroying, log = _fallbackLog, label } = {}) {
  const prefix = label ? `[${label}] ` : ''
  for (const name of ['stdout', 'stderr']) {
    const stream = child?.[name]
    if (!stream) continue
    stream.on('error', (err) => {
      if (destroying && destroying()) return
      log.warn(`${prefix}${name} stream error (ignored): ${err?.message || err}`)
    })
  }
}
