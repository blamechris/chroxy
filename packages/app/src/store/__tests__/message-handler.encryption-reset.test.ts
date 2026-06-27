import {
  resetEncryptionContext,
  getEncryptionState,
  getPendingKeyPair,
  getPendingSalt,
  setEncryptionState,
  prepareEagerKeyExchange,
} from '../message-handler';

/**
 * #6446 — the encryption context must reset as a UNIT on every new connection
 * (forward secrecy). The audit's "HIGH: encryption leaks on server-switch" was a
 * false positive (encryptionState + pendingKeyPair were already reset per
 * connection); this pins the real grain of truth — that pendingSalt + any future
 * field are cleared too, so nothing survives a reconnect / server switch.
 */
describe('resetEncryptionContext (#6446)', () => {
  it('clears the encryption context as a unit', () => {
    // Populate every encryption field, as a live connection would mid-handshake.
    setEncryptionState({ sharedKey: new Uint8Array(32), sendNonce: 7, recvNonce: 9 } as never);
    prepareEagerKeyExchange(); // sets pendingKeyPair + pendingSalt
    expect(getEncryptionState()).not.toBeNull();
    expect(getPendingKeyPair()).not.toBeNull();
    expect(getPendingSalt()).not.toBeNull();

    resetEncryptionContext();

    expect(getEncryptionState()).toBeNull();
    expect(getPendingKeyPair()).toBeNull();
    expect(getPendingSalt()).toBeNull(); // the field the old field-by-field reset missed (#6446)
  });
});
