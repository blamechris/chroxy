// Isolated metadata only: no seed body reads. Parent owns deadline and concurrency.
import { statSync } from 'node:fs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const results = {}
  for (const { id, seedPath, cwd } of JSON.parse(input)) {
    try {
      const seed = statSync(seedPath)
      results[id] = seed.isFile() && statSync(cwd).isDirectory()
        ? `${seed.dev}:${seed.ino}:${seed.size}:${seed.mtimeMs}:${seed.ctimeMs}` : null
    } catch { results[id] = null }
  }
  process.stdout.write(JSON.stringify(results))
})
