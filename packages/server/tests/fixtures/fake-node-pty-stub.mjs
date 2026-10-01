// A trivial stand-in module for a SUCCESSFUL `import('node-pty')` resolution
// — see resolve-node-pty-import-success.mjs. Its contents are never used by
// probeNodePtyAvailable() (which only cares whether the import rejects or
// resolves), so this just needs to be a valid, importable ES module.
export const fakeNodePtyStub = true
