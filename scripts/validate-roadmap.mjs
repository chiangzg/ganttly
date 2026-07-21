/**
 * Validate docs/roadmap.json against packages/schema/schema.json.
 *
 * Used by CI (PRD §7.9 dogfooding) to ensure the repo's own roadmap stays
 * schema-valid — the file is produced/edited by the ganttly UI itself, so a
 * schema violation would indicate a bug in the app's save path.
 *
 * Pure ESM, no TypeScript loader needed: loads schema.json directly and
 * resolves ajv from packages/schema's installed deps via createRequire.
 *
 * Exit code 0 = valid, 1 = invalid.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

// Resolve ajv from packages/schema (it declares ajv + ajv-formats as deps).
const schemaPkgDir = resolve(repoRoot, 'packages/schema');
const schemaRequire = createRequire(resolve(schemaPkgDir, 'package.json'));
const Ajv2020 = schemaRequire('ajv/dist/2020.js');
const addFormats = schemaRequire('ajv-formats');

const schemaJson = JSON.parse(readFileSync(resolve(schemaPkgDir, 'schema.json'), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schemaJson);

const roadmapPath = resolve(repoRoot, 'docs/roadmap.json');
const data = JSON.parse(readFileSync(roadmapPath, 'utf-8'));

const ok = validate(data);
if (!ok) {
  console.error(`✗ docs/roadmap.json is NOT valid against schema.json`);
  for (const err of validate.errors ?? []) {
    const path = err.instancePath || '<root>';
    console.error(`  ${path}: ${err.message ?? 'invalid'}`);
  }
  process.exit(1);
}

const taskCount = data.tasks?.length ?? 0;
console.log(`✓ docs/roadmap.json is schema-valid (${taskCount} tasks)`);
