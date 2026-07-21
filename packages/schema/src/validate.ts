/**
 * Schema validator backed by AJV (draft 2020-12) against `schema.json`.
 *
 * The JSON Schema file is the single source of truth — both TypeScript types
 * (hand-written to match) and runtime validation derive from it. When the two
 * disagree, the JSON Schema wins (it is what external tooling will use).
 *
 * Implementation note: AJV only resolves `$defs/*` references against the
 * ROOT schema object passed to `compile`. To validate a single task in
 * isolation, we wrap it with the root `$defs` so the `task` subschema's
 * references (`isoDate`, etc.) resolve correctly.
 */
import Ajv202012, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schemaJson from '../schema.json' with { type: 'json' };
import type { GanttlyFile, Task } from './types.js';

interface SchemaRoot {
  $defs: Record<string, unknown>;
}

const schemaRoot = schemaJson as unknown as SchemaRoot;

// Compile once at module load. Schema is tiny (<5KB), this is cheap.
const ajv = new Ajv202012({ allErrors: true, strict: true });
addFormats(ajv);

const validateFileFn = ajv.compile<GanttlyFile>(schemaJson);

// Wrap the `task` subschema with the root `$defs` so its `$ref`s resolve.
const validateTaskFn = ajv.compile<Task>({
  ...schemaRoot.$defs['task']!,
  $defs: schemaRoot.$defs,
});

export interface ValidationResult {
  ok: boolean;
  errors: ErrorObject[];
}

export function validateGanttlyFile(data: unknown): ValidationResult {
  const ok = validateFileFn(data);
  return { ok: Boolean(ok), errors: validateFileFn.errors ?? [] };
}

export function validateTask(data: unknown): ValidationResult {
  const ok = validateTaskFn(data);
  return { ok: Boolean(ok), errors: validateTaskFn.errors ?? [] };
}

/** Human-readable one-line summary of an AJV error list, for surfacing in UI. */
export function formatAjvErrors(errors: ErrorObject[]): string {
  return errors
    .slice(0, 20)
    .map((e) => `${e.instancePath || '<root>'}: ${e.message ?? 'invalid'}`)
    .join('; ');
}
