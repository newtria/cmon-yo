import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  activateRecoveryAccount, clearRecovery, readRecovery, recoveryAccount, writeRecovery,
} from '../src/features/recovery/storage';

beforeEach(() => {
  const storage: Record<string, string> = {};
  Object.defineProperties(storage, {
    getItem: { value: (key: string) => storage[key] ?? null },
    setItem: { value: (key: string, value: string) => { storage[key] = value; } },
    removeItem: { value: (key: string) => { delete storage[key]; } },
  });
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => vi.unstubAllGlobals());

test('late validation and cleanup from an old account preserve the current draft and command', () => {
  expect(activateRecoveryAccount('first', recoveryAccount())).toBe(true);
  writeRecovery('first', 'draft', '이전 초안');
  const observedOwner = recoveryAccount();
  clearRecovery('first');
  expect(activateRecoveryAccount('next', recoveryAccount())).toBe(true);
  writeRecovery('next', 'draft', '현재 초안');
  writeRecovery('next', 'command', '미확정 요청');

  expect(activateRecoveryAccount('first', observedOwner)).toBe(false);
  expect(activateRecoveryAccount(null, observedOwner)).toBe(false);
  clearRecovery('first');
  expect(recoveryAccount()).toBe('next');
  expect(readRecovery('next', 'draft', z.string())).toBe('현재 초안');
  expect(readRecovery('next', 'command', z.string())).toBe('미확정 요청');
  expect(() => writeRecovery('first', 'draft', '늦은 입력')).toThrow('Account changed');
});

test('a verified identity transition removes only the outgoing account recovery data', () => {
  activateRecoveryAccount('first', recoveryAccount());
  writeRecovery('first', 'draft', '이전 초안');
  expect(activateRecoveryAccount('next', recoveryAccount())).toBe(true);
  expect(readRecovery('first', 'draft', z.string())).toBeNull();
  expect(recoveryAccount()).toBe('next');
  expect(activateRecoveryAccount(null, recoveryAccount())).toBe(true);
  expect(recoveryAccount()).toBeNull();
  activateRecoveryAccount('first', recoveryAccount());
  expect(readRecovery('first', 'draft', z.string())).toBeNull();
});

test('unavailable storage does not prevent identity verification', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => { throw new Error('Storage unavailable'); },
  });
  expect(recoveryAccount()).toBeUndefined();
  expect(activateRecoveryAccount('first', undefined)).toBe(true);
  expect(() => writeRecovery('first', 'draft', '입력')).toThrow();
});
