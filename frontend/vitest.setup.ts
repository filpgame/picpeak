import { expect, vi } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// Provide Jest-compatible globals for existing tests that rely on jest.fn
(globalThis as any).jest = vi;

// Some jsdom builds (notably on Windows) expose `localStorage` as a bare
// object with no Storage methods, so tests calling `localStorage.clear()` /
// `setItem` throw "is not a function". Install an in-memory Storage shim only
// when the environment's implementation is missing/incomplete — this is a
// no-op where jsdom already provides a working Storage (e.g. Linux CI).
if (typeof globalThis.localStorage?.setItem !== 'function') {
  const createStorage = (): Storage => {
    let store: Record<string, string> = {};
    return {
      get length() { return Object.keys(store).length; },
      clear() { store = {}; },
      getItem(key: string) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
      key(index: number) { return Object.keys(store)[index] ?? null; },
      removeItem(key: string) { delete store[key]; },
      setItem(key: string, value: string) { store[key] = String(value); },
    } as Storage;
  };
  Object.defineProperty(globalThis, 'localStorage', { value: createStorage(), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: createStorage(), configurable: true, writable: true });
}
