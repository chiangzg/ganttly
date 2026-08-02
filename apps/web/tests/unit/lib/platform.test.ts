import { afterEach, describe, expect, it } from 'vitest';
import { isMac, modKeyLabel } from '@/lib/platform';

/**
 * isMac / modKeyLabel drive the ⌘-vs-Ctrl shortcut hints shown in the context
 * menu and toolbar (plan §4.2). jsdom defaults `navigator.platform` to an empty
 * string, so each case stubs it via Object.defineProperty and restores it.
 */
describe('platform detection', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'platform');

  function setPlatform(value: string): void {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      get: () => value,
    });
  }

  afterEach(() => {
    // Restore the original descriptor (or reset our stub) between cases.
    if (original) {
      Object.defineProperty(navigator, 'platform', original);
    } else {
      Object.defineProperty(navigator, 'platform', { configurable: true, get: () => '' });
    }
  });

  it('isMac returns true on MacIntel and shows ⌘', () => {
    setPlatform('MacIntel');
    expect(isMac()).toBe(true);
    expect(modKeyLabel()).toBe('⌘');
  });

  it('isMac returns true on iPhone / iPad user agents', () => {
    setPlatform('iPhone');
    expect(isMac()).toBe(true);
    setPlatform('iPad');
    expect(isMac()).toBe(true);
  });

  it('isMac returns false on Win32 and shows Ctrl', () => {
    setPlatform('Win32');
    expect(isMac()).toBe(false);
    expect(modKeyLabel()).toBe('Ctrl');
  });

  it('isMac returns false on Linux x86_64', () => {
    setPlatform('Linux x86_64');
    expect(isMac()).toBe(false);
    expect(modKeyLabel()).toBe('Ctrl');
  });

  it('isMac returns false for an empty platform string', () => {
    setPlatform('');
    expect(isMac()).toBe(false);
    expect(modKeyLabel()).toBe('Ctrl');
  });
});
