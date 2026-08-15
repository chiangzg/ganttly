import { getCalendar } from '@ganttly/calendar-data';
import { GanImportError, parseGan } from '@ganttly/gan-parser';
import {
  formatAjvErrors,
  normalizeFile,
  validateGanttlyFile,
  type GanttlyFile,
  type Holiday,
} from '@ganttly/schema';

export type ProjectImportKind = 'json' | 'gan';

export interface ProjectImportResult {
  file: GanttlyFile;
  name: string;
  taskCount: number;
  skipped: string[];
}

export class ProjectImportError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProjectImportError';
    this.cause = cause;
  }
}

const getHolidays = (region: string): Holiday[] => getCalendar(region).holidays;

/** Parse and normalize a local project file without creating or activating a project. */
export function parseProjectImport(
  kind: ProjectImportKind,
  filename: string,
  content: string,
): ProjectImportResult {
  return kind === 'json'
    ? parseGanttlyJson(filename, content)
    : parseGanttProjectFile(filename, content);
}

function parseGanttlyJson(filename: string, content: string): ProjectImportResult {
  let data: unknown;
  try {
    data = JSON.parse(content) as unknown;
  } catch (error) {
    throw new ProjectImportError(`JSON 解析失败：${errorMessage(error)}`, error);
  }

  if (!canNormalizeFile(data)) {
    throw new ProjectImportError('文件内容不是有效的 ganttly 项目');
  }

  try {
    // Collect forward-compat stripped fields so we can warn the user.
    const skipped: string[] = [];
    const onStripped = (paths: string[]): void => {
      for (const p of paths) skipped.push(`忽略未知字段: ${p}`);
    };

    // Normalize before AJV validation so older additive schema-v1 files load.
    const file = normalizeFile(data, { getHolidays, onStripped });
    const validation = validateGanttlyFile(file);
    if (!validation.ok) {
      throw new ProjectImportError(`项目数据校验失败：${formatAjvErrors(validation.errors)}`);
    }

    return {
      file,
      name: file.project.name?.trim() || projectNameFromFilename(filename),
      taskCount: file.tasks.length,
      skipped,
    };
  } catch (error) {
    if (error instanceof ProjectImportError) throw error;
    throw new ProjectImportError(`无法读取 ganttly 项目：${errorMessage(error)}`, error);
  }
}

function parseGanttProjectFile(filename: string, content: string): ProjectImportResult {
  try {
    const parsed = parseGan(content);
    const source = {
      ...parsed.file,
      // GanttProject calendars are deliberately not imported; use our bundled calendar.
      calendar: getCalendar('zh-CN'),
    };
    const file = normalizeFile(source, { getHolidays });
    const importedName = file.project.name?.trim();
    const name =
      importedName && importedName !== 'Imported project'
        ? importedName
        : projectNameFromFilename(filename);

    return {
      file,
      name,
      taskCount: parsed.taskCount,
      skipped: parsed.skipped,
    };
  } catch (error) {
    const reason = error instanceof GanImportError ? error.message : errorMessage(error);
    throw new ProjectImportError(`GanttProject 文件解析失败：${reason}`, error);
  }
}

function canNormalizeFile(data: unknown): data is GanttlyFile {
  if (!isRecord(data) || !isRecord(data.project) || !isRecord(data.calendar)) return false;
  return (
    Array.isArray(data.calendar.holidays) &&
    Array.isArray(data.tasks) &&
    Array.isArray(data.resources)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectNameFromFilename(filename: string): string {
  return (
    filename
      .replace(/\.ganttly\.json$/i, '')
      .replace(/\.(gan|xml|json)$/i, '')
      .trim() || '导入项目'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
