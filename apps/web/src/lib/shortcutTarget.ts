/**
 * Keyboard-shortcut input-target filtering (editor-interaction-optimization-plan §4.2).
 *
 * When a global or row/canvas keydown handler is about to act on a shortcut,
 * it must first check whether focus is inside a *text-editing* element. The
 * plan is explicit: "输入框/textarea/select/contenteditable 聚焦时，不拦截文本
 * 编辑快捷键；保存快捷键除外". Letting a `Delete` or `Cmd+Z` bubble up from the
 * F2 rename input would otherwise mis-delete the task or undo the whole project
 * instead of the input's text.
 *
 * The check is a pure function so it can be unit-tested without a DOM/store,
 * matching the repo convention (see `taskHoverHit`, `taskDropTarget`).
 */

/**
 * INPUT types that edit text. Buttons/checkboxes/radio/range/file/etc. do not
 * edit text and must NOT block task shortcuts — e.g. the milestone checkbox in
 * the drawer should not swallow a `Delete` that targets the selected task.
 */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'url',
  'date',
  'datetime-local',
  'time',
  'week',
  'month',
]);

/**
 * Returns `true` when `target` is an element the user types into, and shortcuts
 * that would affect text (Delete, Backspace, undo/redo, arrows, etc.) should be
 * left for that element to handle. Non-editable targets (rows, canvas, buttons,
 * checkboxes, the document body) return `false`.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // `isContentEditable` is the live property (true once the element is
  // connected with contenteditable). Also honour the raw attribute so the
  // check holds in jsdom / before the element is appended to the document.
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    // An `<input>` with no `type` attribute defaults to text.
    return type === '' || TEXT_INPUT_TYPES.has(type);
  }
  return false;
}
