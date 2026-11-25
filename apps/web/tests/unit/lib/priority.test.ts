import { describe, expect, it } from 'vitest';
import { TASK_PRIORITIES } from '@ganttly/schema';
import { PRIORITY_TAG, PRIORITY_TAG_CLASS, priorityColor } from '@/lib/priority';

describe('priority presentation map (priority-matrix spec §2.1)', () => {
  it('gives every priority a tag, a Tailwind class and a colour token', () => {
    // Guards against adding a quadrant and forgetting one of the three maps —
    // Tailwind would then emit no class and the mark would render unstyled.
    for (const priority of TASK_PRIORITIES) {
      expect(PRIORITY_TAG[priority]).toBe(`P${priority}`);
      expect(PRIORITY_TAG_CLASS[priority]).toContain(`text-priority-${priority}`);
      expect(priorityColor(priority)).toBe(`rgb(var(--color-priority-${priority}))`);
    }
  });
});
