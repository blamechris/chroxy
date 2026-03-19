// Runs after test framework is installed (afterEach/beforeEach are available).
// Prevents fake-timer and AsyncStorage state from leaking between tests.

afterEach(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  const store = global.__asyncStorageBackingStore;
  if (store) {
    Object.keys(store).forEach((k) => delete store[k]);
  }
});
