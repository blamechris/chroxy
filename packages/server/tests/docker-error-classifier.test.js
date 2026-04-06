import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDockerError } from '../src/docker-session.js'

describe('classifyDockerError', () => {
  it('classifies docker daemon not running error', () => {
    const err = new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_not_running')
    assert.ok(result.message.includes('Docker is not running'))
  })

  it('classifies "is the docker daemon running" error', () => {
    const err = new Error('Is the docker daemon running?')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_not_running')
  })

  it('classifies connection refused + docker in message', () => {
    const err = new Error('docker: connection refused to unix socket')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_not_running')
  })

  it('classifies docker daemon error from stderr', () => {
    const err = new Error('exit code 1')
    const result = classifyDockerError(err, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
    assert.equal(result.code, 'docker_not_running')
  })

  it('classifies image not found error', () => {
    const err = new Error('Unable to find image: No such image: myimage:latest')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_image_not_found')
    assert.ok(result.message.includes('docker pull'))
  })

  it('classifies manifest unknown error as image not found', () => {
    const err = new Error('manifest unknown: manifest unknown')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_image_not_found')
  })

  it('classifies image not found from stderr', () => {
    const err = new Error('exit code 1')
    const result = classifyDockerError(err, 'Error: No such image: badimage:v1.2')
    assert.equal(result.code, 'docker_image_not_found')
  })

  it('classifies permission denied error', () => {
    const err = new Error('Got permission denied while trying to connect to Docker')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_permission_denied')
    assert.ok(result.message.includes('Permission denied'))
  })

  it('classifies access denied error', () => {
    const err = new Error('Access denied: cannot access docker socket')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_permission_denied')
  })

  it('classifies permission denied from stderr', () => {
    const err = new Error('exit code 1')
    const result = classifyDockerError(err, 'permission denied while trying to connect')
    assert.equal(result.code, 'docker_permission_denied')
  })

  it('classifies "pull access denied" as image not found', () => {
    const err = new Error('pull access denied for myrepo/myimage, repository does not exist')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_image_not_found')
  })

  it('classifies "repository does not exist" as image not found', () => {
    const err = new Error('Error response from daemon: repository does not exist or may require authorization')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_image_not_found')
  })

  it('extracts image name from "No such image" error', () => {
    const err = new Error('Unable to find image: No such image: myimage:latest')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_image_not_found')
    assert.ok(result.message.includes("'myimage:latest'"), `expected image name in message, got: ${result.message}`)
    assert.ok(result.message.includes('docker pull myimage:latest'))
  })

  it('extracts image name from "pull access denied for" error', () => {
    const err = new Error('pull access denied for myorg/private-image:v2, repository does not exist')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_image_not_found')
    assert.ok(result.message.includes("'myorg/private-image:v2'"), `expected image name in message, got: ${result.message}`)
  })

  it('falls back to generic message when image name cannot be extracted', () => {
    const err = new Error('manifest unknown: manifest unknown')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_image_not_found')
    assert.ok(result.message.includes('docker pull <image>'))
  })

  it('falls back to generic docker_error for unknown errors', () => {
    const err = new Error('some unexpected docker failure')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_error')
    assert.equal(result.message, 'some unexpected docker failure')
  })

  it('handles empty message gracefully', () => {
    const err = new Error('')
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_error')
    assert.equal(result.message, '')
  })

  it('handles err.stderr property in addition to stderrText param', () => {
    const err = new Error('exit 1')
    err.stderr = 'Cannot connect to the Docker daemon'
    const result = classifyDockerError(err)
    assert.equal(result.code, 'docker_not_running')
  })
})
