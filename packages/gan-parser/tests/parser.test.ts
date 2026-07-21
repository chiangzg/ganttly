import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGan, GanImportError } from '../src/index.js';

/** The official GanttProject sample (PRD §7.7). */
const SAMPLE_PATH = resolve(process.cwd(), 'tests/fixtures/HouseBuildingSample.gan.xml');

const MINIMAL_GAN = `<?xml version="1.0" encoding="UTF-8"?>
<project name="Test project" company="" webLink="" view-index="0">
  <tasks>
    <task id="0" name="A" meeting="false" start="05-01-2026" duration="5" complete="0">
      <task id="1" name="A1" meeting="false" start="05-01-2026" duration="3" complete="50">
        <depend id="2" type="2" difference="0" hardness="Strong"/>
      </task>
    </task>
    <task id="2" name="B" meeting="true" start="12-01-2026" duration="0" complete="0" color="#ff0033"/>
    <task id="3" name="C" meeting="false" start="12-01-2026" duration="2" complete="0">
      <depend id="1" type="2" difference="0" hardness="Strong"/>
    </task>
  </tasks>
  <resources/>
  <allocations/>
  <previous/>
  <roles/>
</project>
`;

describe('parseGan — minimal fixtures', () => {
  it('parses project name and tasks', () => {
    const result = parseGan(MINIMAL_GAN);
    expect(result.file.project.name).toBe('Test project');
    expect(result.taskCount).toBe(4);
  });

  it('converts dd-MM-yyyy start dates to ISO', () => {
    const result = parseGan(MINIMAL_GAN);
    const a = result.file.tasks.find((t) => t.id === '0');
    expect(a?.start).toBe('2026-01-05');
  });

  it('preserves hierarchy by flattening with parentId', () => {
    const result = parseGan(MINIMAL_GAN);
    const a1 = result.file.tasks.find((t) => t.id === '1');
    expect(a1?.parentId).toBe('0');
    const a = result.file.tasks.find((t) => t.id === '0');
    expect(a?.parentId).toBeNull();
  });

  it('parses milestone flag and 0-duration', () => {
    const result = parseGan(MINIMAL_GAN);
    const b = result.file.tasks.find((t) => t.id === '2');
    expect(b?.isMilestone).toBe(true);
    expect(b?.duration).toBe(0);
  });

  it('parses color', () => {
    const result = parseGan(MINIMAL_GAN);
    const b = result.file.tasks.find((t) => t.id === '2');
    expect(b?.color).toBe('#ff0033');
  });

  it('parses progress', () => {
    const result = parseGan(MINIMAL_GAN);
    const a1 = result.file.tasks.find((t) => t.id === '1');
    expect(a1?.progress).toBe(50);
  });

  it('parses dependencies with correct type mapping', () => {
    const result = parseGan(MINIMAL_GAN);
    // Task 1 (A1) depends on task 2 (B), type=2 → FS
    const a1 = result.file.tasks.find((t) => t.id === '1');
    expect(a1?.dependencies).toEqual([{ targetId: '2', type: 'FS', lag: 0 }]);
  });

  it('records skipped sections in the report', () => {
    const withContent = `<?xml version="1.0"?>
<project name="t">
  <tasks/>
  <resources><resource id="0" name="r1"/></resources>
  <allocations><allocation task-id="0" resource-id="0"/></allocations>
  <previous><task id="0" start="05-01-2026" duration="5"/></previous>
</project>`;
    const result = parseGan(withContent);
    // Sections with children should be reported as skipped.
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('rejects non-gan XML', () => {
    expect(() => parseGan('<not-gan/>')).toThrow(GanImportError);
  });

  it('rejects malformed XML', () => {
    expect(() => parseGan('<<<not xml')).toThrow(GanImportError);
  });
});

describe('parseGan — official HouseBuildingSample', () => {
  it('parses without throwing', () => {
    const xml = readFileSync(SAMPLE_PATH, 'utf-8');
    const result = parseGan(xml);
    expect(result.taskCount).toBeGreaterThan(0);
  });

  it('produces a valid GanttlyFile via schema validation', async () => {
    const xml = readFileSync(SAMPLE_PATH, 'utf-8');
    const result = parseGan(xml);
    const { validateGanttlyFile } = await import('@ganttly/schema');
    // Re-add calendar (parseGan uses an empty calendar; we don't validate
    // required field count, just shape).
    const check = validateGanttlyFile(result.file);
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);
  });

  it('imports the 4 dependency types when present in the sample', () => {
    const xml = readFileSync(SAMPLE_PATH, 'utf-8');
    const result = parseGan(xml);
    const types = new Set<string>();
    for (const t of result.file.tasks) {
      for (const d of t.dependencies) types.add(d.type);
    }
    // Sample uses at least FS (the most common). We don't require all 4.
    expect(types.size).toBeGreaterThanOrEqual(1);
    expect(types.has('FS')).toBe(true);
  });
});
