import type { AuthOkPayload } from './handlers/auth'

export interface SettledCredential {
  token: string
  pin: string | null
}

/** Per-socket credential admission after the existing transport handshake. */
export class CredentialSettlement {
  readonly paired: boolean
  readonly supported: boolean
  private authenticated = false
  private settled = false
  private pin: string | null = null

  constructor(private readonly token: string, private readonly auth: AuthOkPayload, isPairing = false) {
    this.paired = isPairing || auth.sessionToken !== null || (token === '' && auth.serverCapabilities.pairedCredentialConfirmation === true)
    this.supported = !this.paired || auth.serverCapabilities.pairedCredentialConfirmation === true
  }

  get isSettled(): boolean {
    return this.settled
  }

  authenticate(pin: string | null = null): SettledCredential | null {
    if (!this.supported) return null
    this.authenticated = true
    this.pin = pin
    return this.paired ? null : this.admit(this.token)
  }

  confirm(token: string | null, encryptedFrame: boolean): SettledCredential | null {
    if (!this.paired || !this.authenticated || !this.supported || !token) return null
    if (this.auth.encryption === 'required' && !encryptedFrame) return null
    return this.admit(token)
  }

  rotate(token: string | null): SettledCredential | null {
    return this.settled && token ? { token, pin: this.pin } : null
  }

  private admit(token: string): SettledCredential | null {
    if (this.settled) return null
    this.settled = true
    return { token, pin: this.pin }
  }
}
