/**
 * native-notifications tests (#7351).
 *
 * The defect these cover: chroxy's only `new Notification` call sat behind a
 * `permission === 'granted'` guard that nothing ever satisfied, because
 * `Notification.requestPermission()` was never called anywhere in the product.
 * The old suite hid this by hand-setting `Notification.permission = 'granted'`
 * in `beforeEach` — the precondition production never established.
 *
 * So these tests deliberately start from the REAL production state
 * (`permission === 'default'`, or no backend at all) and assert what the
 * module does from there, rather than from a world where someone already
 * granted it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getNotificationBackend,
  getNotificationPermission,
  refreshNotificationPermission,
  requestNativeNotificationPermission,
  sendNativeNotification,
  resetNativeNotificationStateForTests,
} from './native-notifications'

const originalNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification')
const originalTauri = Object.getOwnPropertyDescriptor(window, '__TAURI__')

/** Install a fake Web Notification API at the given permission state. */
function installWebBackend(permission: 'default' | 'granted' | 'denied', requestResult: unknown = 'granted') {
  const ctor = vi.fn()
  // @ts-expect-error — test double
  ctor.permission = permission
  // @ts-expect-error — test double
  ctor.requestPermission = vi.fn().mockResolvedValue(requestResult)
  // @ts-expect-error — test double
  globalThis.Notification = ctor
  return ctor as unknown as ReturnType<typeof vi.fn> & {
    permission: string
    requestPermission: ReturnType<typeof vi.fn>
  }
}

/** Install a fake Tauri notification plugin. */
function installTauriBackend(opts: { granted?: boolean; requestResult?: unknown } = {}) {
  const api = {
    isPermissionGranted: vi.fn().mockResolvedValue(opts.granted ?? false),
    requestPermission: vi.fn().mockResolvedValue(opts.requestResult ?? 'granted'),
    sendNotification: vi.fn(),
  }
  // @ts-expect-error — test double
  window.__TAURI__ = { notification: api }
  return api
}

beforeEach(() => {
  resetNativeNotificationStateForTests()
  // Start every case with NO backend, i.e. jsdom's real state. Each test
  // installs exactly the backend it means to exercise.
  // @ts-expect-error — clearing the global
  delete globalThis.Notification
  // @ts-expect-error — clearing the global
  delete window.__TAURI__
})

afterEach(() => {
  // #7347: the onClick cases spy on `window.focus`. Restoring here rather than
  // only at the end of each case means a failing assertion cannot leak a
  // throwing focus stub into the next test and turn one red into several.
  vi.restoreAllMocks()
  if (originalNotification) Object.defineProperty(globalThis, 'Notification', originalNotification)
  // @ts-expect-error — clearing the global
  else delete globalThis.Notification
  if (originalTauri) Object.defineProperty(window, '__TAURI__', originalTauri)
  // @ts-expect-error — clearing the global
  else delete window.__TAURI__
})

describe('getNotificationBackend', () => {
  it('reports unsupported when neither backend is present', () => {
    // This is the state of a dashboard opened over the LAN at an http:// address
    // — not a secure context, so the browser does not expose Notification at all.
    expect(getNotificationBackend()).toBe('unsupported')
    expect(getNotificationPermission()).toBe('unsupported')
  })

  it('reports web when only the Web Notification API is present', () => {
    installWebBackend('default')
    expect(getNotificationBackend()).toBe('web')
  })

  it('prefers the Tauri plugin over the Web API when both are present', () => {
    installWebBackend('granted')
    installTauriBackend({ granted: false })
    expect(getNotificationBackend()).toBe('tauri')
  })

  it('falls back to web when the Tauri namespace is present but incomplete', () => {
    installWebBackend('default')
    // A partially-injected plugin API must not be treated as a usable backend,
    // or every call site throws inside an effect where nothing surfaces it.
    // @ts-expect-error — deliberately missing sendNotification/requestPermission
    window.__TAURI__ = { notification: { isPermissionGranted: vi.fn() } }
    expect(getNotificationBackend()).toBe('web')
  })
})

describe('getNotificationPermission (web)', () => {
  it.each(['default', 'granted', 'denied'] as const)('mirrors Notification.permission === %s', state => {
    installWebBackend(state)
    expect(getNotificationPermission()).toBe(state)
  })
})

describe('getNotificationPermission (tauri)', () => {
  it("reports 'default' before the async probe has resolved", () => {
    installTauriBackend({ granted: true })
    // isPermissionGranted() is async but the notification guard is synchronous,
    // so the pre-probe answer must fail CLOSED — never an optimistic 'granted'.
    expect(getNotificationPermission()).toBe('default')
  })

  it("reports 'granted' after refresh resolves true", async () => {
    installTauriBackend({ granted: true })
    await refreshNotificationPermission()
    expect(getNotificationPermission()).toBe('granted')
  })

  it("does not downgrade a recorded 'denied' back to 'default' on refresh", async () => {
    // The plugin's isPermissionGranted() is a bare boolean and cannot express
    // "asked and refused". If a refresh reset that to 'default', the auto-request
    // gate would re-prompt a user who already said no, on every probe.
    const api = installTauriBackend({ granted: false, requestResult: 'denied' })
    expect(await requestNativeNotificationPermission()).toBe('denied')
    expect(await refreshNotificationPermission()).toBe('denied')
    expect(api.isPermissionGranted).toHaveBeenCalled()
  })

  it("recovers to 'granted' if the user grants after an earlier denial", async () => {
    const api = installTauriBackend({ granted: false, requestResult: 'denied' })
    await requestNativeNotificationPermission()
    expect(getNotificationPermission()).toBe('denied')
    api.isPermissionGranted.mockResolvedValue(true)
    expect(await refreshNotificationPermission()).toBe('granted')
  })
})

describe('requestNativeNotificationPermission', () => {
  it('delegates to the Web API and returns its result', async () => {
    const ctor = installWebBackend('default', 'granted')
    expect(await requestNativeNotificationPermission()).toBe('granted')
    expect(ctor.requestPermission).toHaveBeenCalledOnce()
  })

  it('delegates to the Tauri plugin and caches the result', async () => {
    const api = installTauriBackend({ requestResult: 'granted' })
    expect(await requestNativeNotificationPermission()).toBe('granted')
    expect(api.requestPermission).toHaveBeenCalledOnce()
    expect(getNotificationPermission()).toBe('granted')
  })

  it('returns unsupported when there is no backend to ask', async () => {
    expect(await requestNativeNotificationPermission()).toBe('unsupported')
  })

  it('never reports a grant for an unrecognised result', async () => {
    // A shim resolving with undefined must not be read as permission.
    // NB: set on the mock rather than through installWebBackend's parameter —
    // passing `undefined` there hits the default argument and silently installs
    // 'granted', so the test would pass while exercising nothing.
    const ctor = installWebBackend('default')
    ctor.requestPermission.mockResolvedValue(undefined)
    expect(await requestNativeNotificationPermission()).toBe('default')
  })

  it('survives a rejected Web request (Chrome rejects without a user gesture)', async () => {
    const ctor = installWebBackend('default')
    ctor.requestPermission.mockRejectedValue(new Error('requires a user gesture'))
    expect(await requestNativeNotificationPermission()).toBe('default')
  })
})

describe('sendNativeNotification', () => {
  it('does NOT send when permission is still default — the real production state', () => {
    const ctor = installWebBackend('default')
    expect(sendNativeNotification('t', { body: 'b' })).toBe(false)
    expect(ctor).not.toHaveBeenCalled()
  })

  it('does NOT send when permission is denied', () => {
    const ctor = installWebBackend('denied')
    expect(sendNativeNotification('t', { body: 'b' })).toBe(false)
    expect(ctor).not.toHaveBeenCalled()
  })

  it('does NOT send when there is no backend', () => {
    expect(sendNativeNotification('t')).toBe(false)
  })

  it('sends through the Web API once granted', () => {
    const ctor = installWebBackend('granted')
    expect(sendNativeNotification('Title', { body: 'Body', tag: 'tag-1' })).toBe(true)
    expect(ctor).toHaveBeenCalledWith('Title', { body: 'Body', tag: 'tag-1' })
  })

  it('sends through the Tauri plugin once granted', async () => {
    const api = installTauriBackend({ granted: true })
    await refreshNotificationPermission()
    expect(sendNativeNotification('Title', { body: 'Body' })).toBe(true)
    expect(api.sendNotification).toHaveBeenCalledWith({ title: 'Title', body: 'Body' })
  })

  it('reports false rather than throwing when the backend throws', () => {
    const ctor = installWebBackend('granted')
    ctor.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(sendNativeNotification('t')).toBe(false)
  })
})

/**
 * #7347 — click-to-focus.
 *
 * The turn-complete notification names a session, so clicking it has to be
 * able to bring that session to the front. These pin BOTH halves of what the
 * module actually does: the web backend wires the click, and the Tauri backend
 * demonstrably does not. The second half is the point — desktop click-to-focus
 * needs a Rust-side notification, and a test that only covered the web path
 * would leave "does the desktop app do this?" answerable only by guessing.
 */
describe('sendNativeNotification — onClick (#7347)', () => {
  /**
   * Web backend whose constructor produces an instance with a real `close`,
   * so the click handler can be invoked the way a browser would invoke it.
   */
  function installClickableWebBackend() {
    const instances: Array<{ onclick: (() => void) | null; close: ReturnType<typeof vi.fn> }> = []
    const ctor = installWebBackend('granted')
    ctor.mockImplementation(function (this: { onclick: (() => void) | null; close: ReturnType<typeof vi.fn> }) {
      this.onclick = null
      this.close = vi.fn()
      instances.push(this)
    })
    return { ctor, instances }
  }

  it('wires the click handler on the web backend, focusing the window and closing the card', () => {
    const { instances } = installClickableWebBackend()
    const onClick = vi.fn()
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {})

    expect(sendNativeNotification('Chroxy: api', { body: 'Finished', onClick })).toBe(true)
    expect(instances).toHaveLength(1)
    const instance = instances[0]!
    // Not yet — only the click may fire it.
    expect(onClick).not.toHaveBeenCalled()

    expect(typeof instance.onclick).toBe('function')
    instance.onclick!()

    expect(focusSpy).toHaveBeenCalled()
    expect(instance.close).toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledOnce()
    focusSpy.mockRestore()
  })

  it('still calls back when window.focus() is refused', () => {
    const { instances } = installClickableWebBackend()
    const onClick = vi.fn()
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {
      throw new Error('blocked by window-management policy')
    })

    sendNativeNotification('Chroxy: api', { onClick })
    instances[0]!.onclick!()

    // The in-app navigation is worth doing even when the window cannot be
    // raised — otherwise a focus policy silently eats the whole interaction.
    expect(onClick).toHaveBeenCalledOnce()
    focusSpy.mockRestore()
  })

  it('leaves onclick unset when the caller passes no handler', () => {
    const { instances } = installClickableWebBackend()
    sendNativeNotification('Chroxy: api', { body: 'Finished' })
    expect(instances[0]!.onclick).toBeNull()
  })

  it('sends but does NOT invoke onClick on the Tauri backend — the documented desktop gap', async () => {
    const api = installTauriBackend({ granted: true })
    await refreshNotificationPermission()
    const onClick = vi.fn()

    // The notification itself still goes out; only the click wiring is absent.
    expect(sendNativeNotification('Chroxy: api', { body: 'Finished', onClick })).toBe(true)
    expect(api.sendNotification).toHaveBeenCalledWith({ title: 'Chroxy: api', body: 'Finished' })
    // The plugin's sendNotification returns void and takes no click callback,
    // so there is nowhere for `onClick` to be attached. If a future plugin
    // version gains one, THIS assertion is the thing that should be updated —
    // deliberately, rather than the gap being discovered by a user clicking a
    // notification and nothing happening.
    expect(onClick).not.toHaveBeenCalled()
    expect(api.sendNotification.mock.calls[0]![0]).not.toHaveProperty('onClick')
  })
})
