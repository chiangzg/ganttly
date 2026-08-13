import { describe, expect, it } from 'vitest';
import {
  applyCommandRequestSchema,
  createProjectRequestSchema,
  importProjectRequestSchema,
  listProjectsQuerySchema,
  saveProjectRequestSchema,
} from '../src';

describe('createProjectRequestSchema', () => {
  it('accepts an envelope carrying an opaque file body', () => {
    const parsed = createProjectRequestSchema.parse({ file: { anything: true } });
    expect(parsed.file).toEqual({ anything: true });
  });

  it('rejects an envelope missing the file field', () => {
    expect(() => createProjectRequestSchema.parse({})).toThrow();
  });
});

describe('saveProjectRequestSchema', () => {
  it('accepts { file } with a present document body', () => {
    expect(saveProjectRequestSchema.parse({ file: { tasks: [] } }).file).toEqual({
      tasks: [],
    });
  });

  it('rejects a null file (structure is validated later by AJV, but null is never valid)', () => {
    expect(() => saveProjectRequestSchema.parse({ file: null })).toThrow();
  });
});

describe('importProjectRequestSchema', () => {
  it('accepts name + file + optional sourceClientId', () => {
    const parsed = importProjectRequestSchema.parse({
      name: 'Migration',
      file: { tasks: [] },
      sourceClientId: 'client-1',
    });
    expect(parsed).toMatchObject({ name: 'Migration', sourceClientId: 'client-1' });
  });

  it('rejects an empty name', () => {
    expect(() => importProjectRequestSchema.parse({ name: '', file: {} })).toThrow();
  });
});

describe('applyCommandRequestSchema', () => {
  it('accepts an opaque command payload', () => {
    const parsed = applyCommandRequestSchema.parse({ command: { kind: 'addTask' } });
    expect(parsed.command).toEqual({ kind: 'addTask' });
  });
});

describe('listProjectsQuerySchema', () => {
  it('coerces deleted="true" to true and treats other values as false', () => {
    expect(listProjectsQuerySchema.parse({ deleted: 'true' }).deleted).toBe(true);
    expect(listProjectsQuerySchema.parse({ deleted: 'false' }).deleted).toBe(false);
    expect(listProjectsQuerySchema.parse({ deleted: '1' }).deleted).toBe(false);
  });

  it('leaves deleted undefined when absent (default excludes trash)', () => {
    expect(listProjectsQuerySchema.parse({}).deleted).toBeUndefined();
  });

  it('reads the search query', () => {
    expect(listProjectsQuerySchema.parse({ query: 'roadmap' }).query).toBe('roadmap');
  });
});
