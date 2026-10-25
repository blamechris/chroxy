import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadNamedKindKubeconfig } from './k8s-kind-kubeconfig.js'

function config({ context = 'kind-example', cluster = 'kind-example', server = 'https://127.0.0.1:12345', ca = true } = {}) {
  return `apiVersion: v1
kind: Config
current-context: ${context}
clusters:
- name: ${cluster}
  cluster:
    server: ${server}
${ca ? '    certificate-authority-data: Y2E=\n' : ''}contexts:
- name: ${context}
  context:
    cluster: ${cluster}
    user: kind-example
users:
- name: kind-example
  user: {}
`
}

describe('named kind kubeconfig for the integration roundtrip', () => {
  it('uses the exact cluster name and keeps HTTPS trust material', () => {
    const expected = config()
    const run = (command, args, options) => {
      assert.equal(command, 'kind')
      assert.deepEqual(args, ['get', 'kubeconfig', '--name', 'example'])
      assert.equal(options.encoding, 'utf8')
      return expected
    }
    assert.equal(loadNamedKindKubeconfig('example', run), expected)
  })

  it('rejects the HTTP endpoint produced by the client fallback', () => {
    assert.throws(
      () => loadNamedKindKubeconfig('example', () => config({ server: 'http://localhost:8080' })),
      /must use an HTTPS API endpoint/,
    )
  })

  it('rejects a different current context', () => {
    assert.throws(
      () => loadNamedKindKubeconfig('example', () => config({ context: 'kind-other' })),
      /context must be kind-example/,
    )
  })

  it('rejects a context pointing to a different cluster', () => {
    assert.throws(
      () => loadNamedKindKubeconfig('example', () => config({ cluster: 'kind-other' })),
      /cluster must be kind-example/,
    )
  })

  it('rejects a kind config without its CA', () => {
    assert.throws(
      () => loadNamedKindKubeconfig('example', () => config({ ca: false })),
      /certificate authority/,
    )
  })
})
