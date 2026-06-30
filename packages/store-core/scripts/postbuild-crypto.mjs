import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../dist/crypto.js', import.meta.url)
const source = await readFile(file, 'utf8')

const namedImport = "import { encodeBase64, decodeBase64 } from 'tweetnacl-util';"
const defaultImport = [
  "import naclUtil from 'tweetnacl-util';",
  'const { encodeBase64, decodeBase64 } = naclUtil;',
].join('\n')

if (!source.includes(namedImport) && !source.includes(defaultImport)) {
  throw new Error('Expected tweetnacl-util import was not found in dist/crypto.js')
}

await writeFile(file, source.replace(namedImport, defaultImport))
