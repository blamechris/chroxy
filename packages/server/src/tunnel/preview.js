import { CloudflareTunnelAdapter } from './cloudflare.js'
import { assertPreviewIngress } from '../preview-ingress.js'

function waitForExit(proc, milliseconds) {
  if (proc.exitCode != null || proc.signalCode != null) return Promise.resolve(true)
  return new Promise(resolve => {
    const finish = result => { clearTimeout(timer)
    proc.off('close', closed)
    resolve(result) }
    const closed = () => finish(true)
    const timer = setTimeout(() => finish(false), milliseconds)
    proc.once('close', closed)
  })
}

/** A preview has one lifetime: no retries, recovery or URL replacement. */
export class PreviewTunnelAdapter extends CloudflareTunnelAdapter {
  constructor(opts) {
    super({ ...opts, mode: 'quick' })
    this.maxStartAttempts = 1
    this._children = new Set()
  }

  _spawnCloudflared(argv, opts) {
    assertPreviewIngress(this.config.previewIngress)
    if (JSON.stringify(argv) !== JSON.stringify(this._quickTunnelArguments())) throw new Error('Preview ingress arguments changed')
    const proc = super._spawnCloudflared(argv, opts)
    this._children.add(proc)
    proc.once('close', () => this._children.delete(proc))
    return proc
  }

  async _handleUnexpectedExit() {
    if (!this.intentionalShutdown) this.emit('tunnel_lost')
    this.intentionalShutdown = true
  }

  _quickTunnelExposureMessage(url) {
    return `HTTP preview publicly reachable at ${url}; Chroxy adds no authentication. HTTP only: no WebSockets or reconnect.`
  }

  _quickTunnelArguments() {
    if (!this.config.previewIngress?.path) throw new Error('Preview requires a private Unix ingress configuration')
    // Quick dispatch needs this flag; the private ingress selects the origin.
    return ['tunnel', '--config', this.config.previewIngress.path, '--hello-world', '--no-autoupdate']
  }

  async stop() {
    this.intentionalShutdown = true
    this._startAbort?.abort()
    this._recoveryAbort?.abort()
    for (const proc of this._children) {
      const terminated = waitForExit(proc, 3000)
      proc.kill('SIGTERM')
      if (!await terminated) {
        const killed = waitForExit(proc, 2000)
        proc.kill('SIGKILL')
        if (!await killed) throw new Error('Preview tunnel process exit could not be confirmed after TERM and KILL')
      }
    }
    this.process = null
    this.url = null
  }
}
