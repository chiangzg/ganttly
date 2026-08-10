/** Return the adjacent selectable visual row index, stopping at list edges. */
export function adjacentSelectableRow(
  currentIndex: number,
  selectableIndexes: ReadonlyArray<number>,
  direction: -1 | 1,
): number | null {
  const position = selectableIndexes.indexOf(currentIndex);
  if (position === -1) return null;
  return selectableIndexes[position + direction] ?? null;
}

/** Focus an absolutely-positioned row and keep it inside its scroll viewport. */
export function focusAndRevealRow(
  scrollContainer: HTMLElement | null,
  visualIndex: number,
  rowHeight: number,
): void {
  if (!scrollContainer) return;
  const row = scrollContainer.querySelector<HTMLElement>(
    `[data-keyboard-row-index="${visualIndex}"]`,
  );
  if (!row) return;

  const rowTop = visualIndex * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < scrollContainer.scrollTop) {
    scrollContainer.scrollTop = rowTop;
  } else if (rowBottom > scrollContainer.scrollTop + scrollContainer.clientHeight) {
    scrollContainer.scrollTop = rowBottom - scrollContainer.clientHeight;
  }
  row.focus({ preventScroll: true });
}
