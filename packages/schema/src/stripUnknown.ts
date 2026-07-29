/**
 * Forward-compatibility: strip unknown fields from a `GanttlyFile`.
 *
 * The JSON Schema (`schema.json`) is the single source of truth and uses
 * `additionalProperties: false` everywhere. The data model evolves
 * **additively** — new versions of the app add optional fields (e.g.
 * `Task.overtimeDates`) — but a strict reader cannot tolerate fields it does
 * not know about. That means a file exported by a NEWER app is rejected by an
 * OLDER app's import ("must NOT have additional properties"), even though the
 * file is perfectly valid for the newer version. Project files are shared and
 * re-imported across versions, so this is a real forward-compatibility hazard.
 *
 * `stripUnknownFields` solves it: it walks the file against the compiled
 * schema's `$defs` and drops any key not listed under `properties`, collecting
 * the removed paths so callers can warn the user. It only ever DELETES keys
 * (never adds defaults — that's `normalizeFile`'s job), so it composes cleanly
 * as the first stage of the normalize pipeline and is independently testable.
 *
 * Why not rely on AJV's `removeAdditional`? It would silently drop data with no
 * way to report what was lost, and only fires when validation is compiled with
 * that flag. We want explicit, reportable, schema-driven stripping.
 *
 * Implementation note: we resolve `$defs` names ourselves rather than spinning
 * up a second AJV instance. The schema is tiny and only references its own
 * `$defs`, so a small recursive walker is clearer and dependency-free.
 */
import schemaJson from '../schema.json' with { type: 'json' };
import type { GanttlyFile } from './types.js';

interface JsonSchemaObject {
  type?: string | string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaDef>;
  items?: JsonSchemaDef;
  $ref?: string;
}

type JsonSchemaDef = JsonSchemaObject | { $ref?: string };

const rootSchema = schemaJson as unknown as JsonSchemaObject & {
  $defs: Record<string, JsonSchemaObject>;
};

/** A removed-field report: human-readable path (e.g. `tasks[3].legacyField`). */
export interface StrippedField {
  path: string;
}

export interface StripResult {
  /** The file with all unknown keys removed. */
  file: GanttlyFile;
  /** Removed-field paths, for surfacing to the user. */
  removed: string[];
}

/**
 * Returns a copy of `file` with every key not allowed by the schema removed.
 * Mutates nothing; collects removed paths into `removed`. Idempotent.
 */
export function stripUnknownFields(file: GanttlyFile): StripResult {
  const removed: string[] = [];
  // Treat the file as a plain record for the generic walker; the root schema
  // guarantees the output still conforms to GanttlyFile (minus dropped keys).
  const out = stripObject(file as unknown as Record<string, unknown>, rootSchema, '', removed);
  return { file: out as unknown as GanttlyFile, removed };
}

/**
 * Strip unknown keys from a plain object `value`, guided by `def`.
 * `path` is the dotted+bracketed location for the `removed` log. `removed` is
 * the accumulator. Returns the (possibly rebuilt) object — same reference when
 * nothing changed, a new object otherwise.
 */
function stripObject(
  value: Record<string, unknown>,
  def: JsonSchemaObject,
  path: string,
  removed: string[],
): Record<string, unknown> {
  // Only strict objects (additionalProperties === false) need stripping; a
  // schema object with additionalProperties undefined/true is permissive.
  if (def.additionalProperties !== false || !def.properties) {
    return value;
  }

  let mutated = false;
  const result: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    if (!(key in def.properties)) {
      // Unknown key — drop and report.
      removed.push(joinPath(path, key));
      mutated = true;
      continue;
    }
    const childDef = def.properties[key]!;
    const childPath = joinPath(path, key);
    const stripped = stripValue(child, childDef, childPath, removed);
    result[key] = stripped;
    // stripValue returns a new reference only when it rebuilt a nested object
    // or array; detect that here so we know whether to replace the parent.
    if (stripped !== child) mutated = true;
  }

  return mutated ? result : value;
}

/**
 * Strip unknown keys from any value (object / array / scalar) per `def`.
 * Returns the original reference when nothing changed.
 */
function stripValue(value: unknown, def: JsonSchemaDef, path: string, removed: string[]): unknown {
  const resolved = resolveRef(def);

  if (Array.isArray(value)) {
    if (!resolved.items) return value;
    const itemDef = resolveRef(resolved.items);
    let mutated = false;
    const mapped = value.map((item, index) => {
      const stripped = stripValue(item, itemDef, `${path}[${index}]`, removed);
      if (stripped !== item) mutated = true;
      return stripped;
    });
    return mutated ? mapped : value;
  }

  if (value !== null && typeof value === 'object') {
    return stripObject(value as Record<string, unknown>, resolved, path, removed);
  }

  return value;
}

/** Resolve a `$ref` (e.g. `#/$defs/task`) to its definition, or pass through. */
function resolveRef(def: JsonSchemaDef): JsonSchemaObject {
  const d = def as JsonSchemaObject;
  if (d.$ref) {
    const name = d.$ref.replace(/^#\/\$defs\//, '');
    const resolved = rootSchema.$defs[name];
    if (resolved) return resolved;
  }
  return d;
}

/** Join a parent path and a key into a readable path segment. */
function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}
