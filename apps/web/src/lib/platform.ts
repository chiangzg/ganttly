/**
 * Platform detection for keyboard-shortcut UI (editor-interaction-optimization-plan §4.2).
 *
 * Shortcut hints and tooltips need to show ⌘ on macOS and Ctrl elsewhere. The
 * codebase had no central Cmd-vs-Ctrl detection — every call site used the
 * `e.ctrlKey || e.metaKey` idiom ad-hoc. This module centralises the *display*
 * side (the *handling* side stays symmetric on both modifier keys).
 *
 * Pure (reads `navigator.platform` lazily) so it can be unit-tested by mocking
 * the navigator property.
 */

/**
 * `true` on macOS / iOS / iPadOS user agents. Uses `navigator.platform` rather
 * than `userAgent` to stay stable against UA-client-hints freezing.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

/**
 * The modifier label to show in shortcut hints — "⌘" on Apple platforms,
 * "Ctrl" everywhere else. Matches the `e.ctrlKey || e.metaKey` handling idiom
 * used across the editor: both keys are accepted, but the hint shows the one
 * the user's OS conventionally presses.
 */
export function modKeyLabel(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
