import React from 'react';

// Mock only useWindowDimensions — don't spread the whole RN module
let mockDimensions = { width: 375, height: 812 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

import { useLayout } from '../../hooks/useLayout';

const TestRenderer = require('react-test-renderer');

function renderHookSimple<T>(hookFn: () => T): { result: { current: T } } {
  const resultRef = { current: null as any as T };
  function TestComponent() {
    resultRef.current = hookFn();
    return null;
  }
  TestRenderer.act(() => {
    TestRenderer.create(React.createElement(TestComponent));
  });
  return { result: resultRef };
}

describe('useLayout', () => {
  afterEach(() => {
    mockDimensions = { width: 375, height: 812 };
  });

  it('returns phone portrait layout for small screens', () => {
    mockDimensions = { width: 375, height: 812 };
    const { result } = renderHookSimple(() => useLayout());
    expect(result.current.width).toBe(375);
    expect(result.current.height).toBe(812);
    expect(result.current.isTablet).toBe(false);
    expect(result.current.isWide).toBe(false);
    expect(result.current.isLandscape).toBe(false);
    expect(result.current.isSplitView).toBe(false);
  });

  it('returns isTablet=true at exactly 768dp width', () => {
    mockDimensions = { width: 768, height: 1024 };
    const { result } = renderHookSimple(() => useLayout());
    expect(result.current.isTablet).toBe(true);
    expect(result.current.isWide).toBe(false);
    expect(result.current.isLandscape).toBe(false);
    expect(result.current.isSplitView).toBe(false);
  });

  it('returns isTablet=false at 767dp width', () => {
    mockDimensions = { width: 767, height: 1024 };
    const { result } = renderHookSimple(() => useLayout());
    expect(result.current.isTablet).toBe(false);
  });

  it('returns isWide=true at exactly 1024dp width', () => {
    mockDimensions = { width: 1024, height: 768 };
    const { result } = renderHookSimple(() => useLayout());
    expect(result.current.isTablet).toBe(true);
    expect(result.current.isWide).toBe(true);
    expect(result.current.isLandscape).toBe(true);
    expect(result.current.isSplitView).toBe(true);
  });

  it('returns isLandscape=true when width > height', () => {
    mockDimensions = { width: 812, height: 375 };
    const { result } = renderHookSimple(() => useLayout());
    expect(result.current.isLandscape).toBe(true);
    expect(result.current.isTablet).toBe(true);
  });

  it('returns isLandscape=false when width === height (square)', () => {
    mockDimensions = { width: 500, height: 500 };
    const { result } = renderHookSimple(() => useLayout());
    expect(result.current.isLandscape).toBe(false);
  });

  it('returns isSplitView only when both isTablet and isLandscape', () => {
    // Tablet portrait — isTablet true, isLandscape false
    mockDimensions = { width: 768, height: 1024 };
    const { result: portrait } = renderHookSimple(() => useLayout());
    expect(portrait.current.isSplitView).toBe(false);

    // Phone landscape — isTablet false, isLandscape true
    mockDimensions = { width: 700, height: 375 };
    const { result: phoneLandscape } = renderHookSimple(() => useLayout());
    expect(phoneLandscape.current.isSplitView).toBe(false);

    // Tablet landscape — both true
    mockDimensions = { width: 1024, height: 768 };
    const { result: tabletLandscape } = renderHookSimple(() => useLayout());
    expect(tabletLandscape.current.isSplitView).toBe(true);
  });
});
