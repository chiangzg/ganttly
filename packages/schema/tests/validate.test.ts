import { describe, expect, it } from 'vitest';
import {
  createEmptyFile,
  validateGanttlyFile,
  validateTask,
  formatAjvErrors,
} from '../src/index.js';

describe('createEmptyFile', () => {
  it('produces a file that validates against schema.json', () => {
    const file = createEmptyFile({ name: 'test' });
    const result = validateGanttlyFile(file);
    expect(result.ok, formatAjvErrors(result.errors)).toBe(true);
  });

  it('defaults to zh-CN locale and zh-CN calendar shell', () => {
    const file = createEmptyFile();
    expect(file.project.locale).toBe('zh-CN');
    expect(file.calendar.id).toBe('zh-CN');
    expect(file.calendar.weekStart).toBe(1);
    expect(file.calendar.weekends).toEqual([0, 6]);
    expect(file.tasks).toEqual([]);
    expect(file.schemaVersion).toBe(1);
  });

  it('honors provided options', () => {
    const file = createEmptyFile({ name: 'x', locale: 'en', calendarId: 'en-US' });
    expect(file.project.name).toBe('x');
    expect(file.project.locale).toBe('en');
    expect(file.calendar.id).toBe('en-US');
  });
});

describe('validateGanttlyFile', () => {
  it('rejects unknown top-level keys', () => {
    const file = createEmptyFile() as unknown as Record<string, unknown>;
    file.bogus = true;
    const result = validateGanttlyFile(file);
    expect(result.ok).toBe(false);
  });

  it('rejects wrong schemaVersion', () => {
    const file = createEmptyFile();
    const bad = { ...file, schemaVersion: 2 };
    const result = validateGanttlyFile(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects bad locale enum', () => {
    const file = createEmptyFile();
    const bad = { ...file, project: { ...file.project, locale: 'ja' } };
    const result = validateGanttlyFile(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects progress out of range', () => {
    const file = createEmptyFile();
    const task = {
      id: 't1',
      name: 'x',
      parentId: null,
      order: 0,
      start: '2026-01-05',
      end: '2026-01-09',
      duration: 5,
      progress: 150,
      isMilestone: false,
      dependencies: [],
      constraints: {},
      assignments: [],
      customFields: {},
    };
    const bad = { ...file, tasks: [task] };
    const result = validateGanttlyFile(bad);
    expect(result.ok).toBe(false);
  });
});

describe('validateTask', () => {
  const baseTask = {
    id: 't1',
    name: 'design',
    parentId: null,
    order: 0,
    start: '2026-01-05',
    end: '2026-01-09',
    duration: 5,
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: {},
    assignments: [],
    customFields: {},
  };

  it('accepts a valid task', () => {
    expect(validateTask(baseTask).ok).toBe(true);
  });

  it('accepts a milestone with duration 0', () => {
    expect(
      validateTask({ ...baseTask, duration: 0, isMilestone: true, end: '2026-01-05' }).ok,
    ).toBe(true);
  });

  it('rejects unknown dependency type', () => {
    const bad = {
      ...baseTask,
      dependencies: [{ targetId: 't2', type: 'XX', lag: 0 }],
    };
    expect(validateTask(bad).ok).toBe(false);
  });

  it('rejects malformed date', () => {
    expect(validateTask({ ...baseTask, start: '2026/01/05' }).ok).toBe(false);
  });
});

describe('formatAjvErrors', () => {
  it('formats errors as readable strings', () => {
    const result = validateGanttlyFile({ schemaVersion: 99 });
    const formatted = formatAjvErrors(result.errors);
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });
});
