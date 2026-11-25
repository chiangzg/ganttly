import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { initI18n } from '@/i18n';
import { PrioritySegmented } from '@/components/PrioritySegmented';

// Real labels so the assertions read like the UI (优先级 / 未分级 / P1…).
initI18n();

const radio = (container: HTMLElement, dataPriority: string) =>
  container.querySelector<HTMLButtonElement>(`[data-priority="${dataPriority}"]`)!;

describe('PrioritySegmented (priority-matrix spec §3.1)', () => {
  it('renders five options in one radiogroup and checks the current value', () => {
    render(<PrioritySegmented value={2} onChange={() => {}} />);

    const group = screen.getByRole('radiogroup', { name: '优先级' });
    const options = screen.getAllByRole('radio');
    expect(options.map((o) => o.getAttribute('data-priority'))).toEqual([
      'none',
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
      'false',
      'false',
    ]);
    // Built from <button>s on purpose: an <input type="radio"> would shift the
    // positional `drawer.locator('input').first()` selectors of existing e2e.
    expect(group.querySelector('input')).toBeNull();
  });

  it('reports a different pick, and stays silent when the checked one is re-picked', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <PrioritySegmented value={undefined} onChange={onChange} />,
    );

    fireEvent.click(radio(container, '3'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(3);

    // The owner applied it: the same click is now a no-op, not a "change".
    rerender(<PrioritySegmented value={3} onChange={onChange} />);
    fireEvent.click(radio(container, '3'));
    expect(onChange).toHaveBeenCalledTimes(1);

    // "未分级" reports `undefined` — the absent-key state, not a sentinel value.
    fireEvent.click(radio(container, 'none'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
