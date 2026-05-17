import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { WebSocketProvider, useWebSocket } from './useWebSocket';

function createWrapper() {
  return function Wrapper({ children }) {
    return <WebSocketProvider>{children}</WebSocketProvider>;
  };
}

function waitForConnection(result) {
  return new Promise((resolve) => {
    const check = () => {
      if (result.current.connected) return resolve();
      setTimeout(check, 10);
    };
    check();
  });
}

describe('WebSocketProvider subscribe/unsubscribe', () => {
  let mockWs;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWs = {
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      close: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    };
    class MockWebSocket {
      constructor() { return mockWs; }
    }
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function openConnection() {
    act(() => { mockWs.onopen(); });
  }

  function dispatchMessage(type, data = {}) {
    act(() => {
      mockWs.onmessage({ data: JSON.stringify({ type, ...data }) });
    });
  }

  it('removes empty callback bucket after last unsubscribe', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper: createWrapper() });
    openConnection();

    const fn = vi.fn();
    const unsub = result.current.subscribe('test-event', fn);
    unsub();

    // Repeated subscribe/unsubscribe cycles — no stale dispatch
    for (let i = 0; i < 5; i++) {
      const tmp = vi.fn();
      const u = result.current.subscribe('test-event', tmp);
      u();
    }

    // After all unsubscribes, dispatching should invoke zero callbacks
    dispatchMessage('test-event');
    expect(fn).not.toHaveBeenCalled();
  });

  it('dispatch stays stable across repeated mount/unmount cycles', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper: createWrapper() });
    openConnection();

    const calls = [];

    for (let cycle = 0; cycle < 3; cycle++) {
      const fn = vi.fn((msg) => calls.push({ cycle, msg }));
      const unsub = result.current.subscribe('tick', fn);

      dispatchMessage('tick', { n: cycle });
      expect(fn).toHaveBeenCalledTimes(1);

      unsub();
      dispatchMessage('tick', { n: cycle + 100 });
      expect(fn).toHaveBeenCalledTimes(1); // no stale dispatch
    }

    expect(calls).toHaveLength(3);
    calls.forEach((c, i) => expect(c.cycle).toBe(i));
  });

  it('keeps channel entry on partial unsubscribe', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper: createWrapper() });
    openConnection();

    const fnA = vi.fn();
    const fnB = vi.fn();
    const unsubA = result.current.subscribe('ch', fnA);
    result.current.subscribe('ch', fnB);

    dispatchMessage('ch');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);

    unsubA();

    dispatchMessage('ch');
    expect(fnA).toHaveBeenCalledTimes(1); // no more calls
    expect(fnB).toHaveBeenCalledTimes(2); // still active
  });

  it('removes channel entry after unsubscribing all callbacks', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper: createWrapper() });
    openConnection();

    const fnA = vi.fn();
    const fnB = vi.fn();
    const unsubA = result.current.subscribe('ch', fnA);
    const unsubB = result.current.subscribe('ch', fnB);

    unsubA();
    unsubB();

    dispatchMessage('ch');
    expect(fnA).not.toHaveBeenCalled();
    expect(fnB).not.toHaveBeenCalled();
  });

  it('unsubscribe is idempotent and does not throw on unknown channel', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper: createWrapper() });
    openConnection();

    const fn = vi.fn();
    const unsub = result.current.subscribe('x', fn);

    expect(() => unsub()).not.toThrow();
    expect(() => unsub()).not.toThrow();

    const fakeUnsub = () => result.current.subscribe('x', fn)();
    // calling after already unsubscribed should not throw
    // (subscribe creates new entry, immediate unsub cleans it)
    expect(() => fakeUnsub()).not.toThrow();
  });

  it('wildcard listeners are independent from channel listeners', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper: createWrapper() });
    openConnection();

    const starFn = vi.fn();
    const chFn = vi.fn();
    const unsubStar = result.current.subscribe('*', starFn);
    const unsubCh = result.current.subscribe('ev', chFn);

    dispatchMessage('ev', { val: 1 });
    expect(starFn).toHaveBeenCalledTimes(1);
    expect(chFn).toHaveBeenCalledTimes(1);

    unsubCh();
    dispatchMessage('ev', { val: 2 });
    expect(starFn).toHaveBeenCalledTimes(2);
    expect(chFn).toHaveBeenCalledTimes(1);

    unsubStar();
    dispatchMessage('ev', { val: 3 });
    expect(starFn).toHaveBeenCalledTimes(2);
    expect(chFn).toHaveBeenCalledTimes(1);
  });
});
