import { describe, expect, it } from 'vitest';
import { createEmptyFile } from '@ganttly/schema';
import { parseProjectImport, ProjectImportError } from '../src/projectImport';

describe('parseProjectImport', () => {
  it('normalizes older ganttly JSON and preserves explicit overtime dates', () => {
    const source = createEmptyFile({ name: '导入测试' });
    source.tasks = [
      {
        id: 'task-1',
        name: '跨周任务',
        parentId: null,
        order: 0,
        start: '2026-01-05',
        end: '2026-01-12',
        duration: 6,
        progress: 0,
        isMilestone: false,
        dependencies: [],
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
        overtimeDates: ['2026-01-10'],
      },
    ];
    const legacy = structuredClone(source) as unknown as {
      tasks: Array<Record<string, unknown>>;
    };
    legacy.tasks[0]!.constraints = {};

    const result = parseProjectImport('json', 'fallback.ganttly.json', JSON.stringify(legacy));

    expect(result.name).toBe('导入测试');
    expect(result.file.tasks[0]?.constraints).toEqual({ type: 'none' });
    expect(result.file.tasks[0]?.overtimeDates).toEqual(['2026-01-10']);
  });

  it('uses the JSON filename when the internal project name is empty', () => {
    const source = createEmptyFile({ name: 'placeholder' });
    source.project.name = '   ';

    const result = parseProjectImport('json', '本地排期.ganttly.json', JSON.stringify(source));

    expect(result.name).toBe('本地排期');
  });

  it('reports malformed and schema-invalid JSON clearly', () => {
    expect(() => parseProjectImport('json', 'bad.json', '{')).toThrow(ProjectImportError);
    expect(() => parseProjectImport('json', 'bad.json', '{')).toThrow('JSON 解析失败');

    const invalid = createEmptyFile({ name: 'invalid' }) as unknown as Record<string, unknown>;
    invalid.schemaVersion = 999;
    expect(() => parseProjectImport('json', 'bad.json', JSON.stringify(invalid))).toThrow(
      '项目数据校验失败',
    );
  });

  it('parses .gan files, applies the bundled calendar, and reports skipped data', () => {
    const xml = `
      <project>
        <resources><resource id="1" name="测试人员" /></resources>
        <tasks>
          <task id="1" name="基础施工" start="05-01-2026" duration="2" />
        </tasks>
      </project>
    `;

    const result = parseProjectImport('gan', '房屋计划.gan', xml);

    expect(result.name).toBe('房屋计划');
    expect(result.taskCount).toBe(1);
    expect(result.file.calendar.id).toBe('zh-CN');
    expect(result.file.tasks[0]?.overtimeDates).toEqual([]);
    expect(result.skipped).toContain('资源(resources)');
  });

  it('surfaces invalid .gan files as import errors', () => {
    expect(() => parseProjectImport('gan', 'bad.gan', '<not-gan />')).toThrow(
      'GanttProject 文件解析失败',
    );
  });
});
