/**
 * Shared test utilities for hook and component tests.
 *
 * Provides a lightweight hook renderer using react-test-renderer,
 * avoiding the need for @testing-library/react-native.
 */
import React from 'react';

const TestRenderer = require('react-test-renderer');

/**
 * Render a hook in a minimal test component.
 * Returns the hook's current value and an unmount function.
 */
export function renderHookSimple<T>(hookFn: () => T): { result: { current: T }; unmount: () => void } {
  const resultRef = { current: null as any as T };
  function TestComponent() {
    resultRef.current = hookFn();
    return null;
  }
  let renderer: any;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(TestComponent));
  });
  return {
    result: resultRef,
    unmount: () => {
      TestRenderer.act(() => {
        renderer.unmount();
      });
    },
  };
}

/** Run an async function inside TestRenderer.act() */
export async function actAsync(fn: () => Promise<void>): Promise<void> {
  await TestRenderer.act(fn);
}

/** Flush microtask queue (resolved promises) */
export function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}
