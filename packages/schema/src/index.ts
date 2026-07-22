/**
 * @ganttly/schema — public API.
 *
 * Re-exports the data-model types and JSON Schema. The validator is implemented
 * against `schema.json` (AJV, draft 2020-12) so the source of truth for both
 * TypeScript and external tooling is a single JSON Schema file.
 */
export * from './types.js';
export { default as schemaJson } from '../schema.json' with { type: 'json' };
export { validateGanttlyFile, validateTask, formatAjvErrors } from './validate.js';
export { createEmptyFile } from './factory.js';
export { normalizeFile, type NormalizeFileOptions } from './normalize.js';
