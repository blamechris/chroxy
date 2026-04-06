/**
 * Node.js version gate.
 *
 * Imported as the first side-effect import in cli.js so it executes before
 * any other module initialisation. In ESM the module graph is resolved
 * top-down, so this body runs before Commander (or anything else) loads.
 */
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 22) {
  process.stderr.write(
    `Chroxy requires Node.js 22 or later.\n` +
    `You are running Node.js ${process.versions.node}.\n` +
    `Install Node 22: https://nodejs.org/en/download/\n`
  )
  process.exit(1)
}
