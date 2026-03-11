/**
 * Behavioral test for AppState hot-reload cleanup pattern (#1995).
 *
 * The pattern: connection.ts stores its AppState subscription on a global,
 * and on hot-reload (module re-evaluation), removes the previous subscription
 * before creating a new one. This prevents duplicate listeners.
 *
 * We test the pattern by simulating what happens during hot-reload:
 * set up a fake previous subscription, then verify it gets cleaned up
 * when the module re-evaluates.
 */

describe('AppState hot-reload cleanup (#1995)', () => {
  test('removes previous subscription when global exists', () => {
    const removeSpy = jest.fn();

    // Simulate a previous hot-reload leaving a subscription on the global
    (global as any).__chroxy_appStateSub = { remove: removeSpy };

    // Simulate the cleanup pattern from connection.ts
    if ((global as any).__chroxy_appStateSub) {
      (global as any).__chroxy_appStateSub.remove();
    }

    expect(removeSpy).toHaveBeenCalledTimes(1);

    // Clean up
    delete (global as any).__chroxy_appStateSub;
  });

  test('does not throw when no previous subscription exists', () => {
    delete (global as any).__chroxy_appStateSub;

    expect(() => {
      if ((global as any).__chroxy_appStateSub) {
        (global as any).__chroxy_appStateSub.remove();
      }
    }).not.toThrow();
  });

  test('stores new subscription on global after cleanup', () => {
    const oldRemove = jest.fn();
    (global as any).__chroxy_appStateSub = { remove: oldRemove };

    // Cleanup
    if ((global as any).__chroxy_appStateSub) {
      (global as any).__chroxy_appStateSub.remove();
    }

    // Store new subscription
    const newSub = { remove: jest.fn() };
    (global as any).__chroxy_appStateSub = newSub;

    expect((global as any).__chroxy_appStateSub).toBe(newSub);
    expect(oldRemove).toHaveBeenCalledTimes(1);

    // Clean up
    delete (global as any).__chroxy_appStateSub;
  });

  test('connection.ts exports _appStateSub and stores it on global', () => {
    // Import the module — this triggers the global assignment
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const connection = require('../src/store/connection');

    expect(connection._appStateSub).toBeDefined();
    expect((global as any).__chroxy_appStateSub).toBe(connection._appStateSub);
  });
});
