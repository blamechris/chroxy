import React from 'react';
import { ErrorBoundary } from '../ErrorBoundary';

describe('ErrorBoundary (#1830)', () => {
  it('exports ErrorBoundary class with required lifecycle methods', () => {
    expect(ErrorBoundary).toBeDefined();
    expect(ErrorBoundary.getDerivedStateFromError).toBeDefined();
    expect(ErrorBoundary.prototype.componentDidCatch).toBeDefined();
    expect(ErrorBoundary.prototype.render).toBeDefined();
    // handleRetry is a class property (arrow function), verified via instance test below
  });

  it('getDerivedStateFromError returns error state', () => {
    const error = new Error('test crash');
    const state = ErrorBoundary.getDerivedStateFromError(error);
    expect(state).toEqual({ hasError: true, error });
  });

  it('handleRetry resets error state', () => {
    const instance = new ErrorBoundary({ children: null });
    instance.setState = jest.fn();
    instance.handleRetry();
    expect(instance.setState).toHaveBeenCalledWith({ hasError: false, error: null });
  });

  it('initial state has no error', () => {
    const instance = new ErrorBoundary({ children: null });
    expect(instance.state).toEqual({ hasError: false, error: null });
  });
});
