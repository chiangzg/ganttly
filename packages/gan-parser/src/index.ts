/**
 * GanttProject `.gan` (XML) importer (PRD §3.9, M4.4-M4.5).
 *
 * Parses a `.gan` file and returns a partial `GanttlyFile` containing only
 * the fields we support. Anything we can't represent is collected in a
 * `skipped` report so the user knows what was dropped.
 *
 * Mapping rules (PRD §3.9):
 *
 *   <task> attribute      → ganttly field
 *   ---------------------    ----------------
 *   id (numeric)          → id (stringified; collisions unlikely)
 *   name                  → name
 *   start (dd-MM-yyyy)    → start (yyyy-MM-dd)
 *   duration              → duration (in working days)
 *   complete              → progress
 *   meeting="true"        → isMilestone
 *   color                 → color
 *   notes                 → note
 *   nested <task>         → parentId (flattened)
 *   <depend id type>      → dependencies (type code mapped)
 *
 *   <depend> type code   → DependencyType
 *   --------------------    ---------------
 *   0 / 2 (FS)              FS
 *   1 / 3 (SS)              SS
 *   6 / 7 (FF)              FF
 *   4 / 5 (SF)              SF
 *
 * DROPPED in MVP (P1 will add):
 * - Resources, allocations, rates, roles
 * - Baselines (<previous>)
 * - PERT, custom columns
 * - Calendars (we use bundled zh-CN instead)
 */
import { XMLParser } from 'fast-xml-parser';
import { createEmptyFile, type DependencyType, type GanttlyFile, type Task } from '@ganttly/schema';

export interface GanImportResult {
  file: GanttlyFile;
  /** Names of attributes/elements we ignored, for surfacing in UI. */
  skipped: string[];
  /** Number of tasks successfully imported. */
  taskCount: number;
}

const DEPEND_TYPE_MAP: Record<number, DependencyType> = {
  0: 'FS',
  2: 'FS', // GanttProject's primary FS code
  1: 'SS',
  3: 'SS',
  6: 'FF',
  7: 'FF',
  4: 'SF',
  5: 'SF',
};

export class GanImportError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GanImportError';
    this.cause = cause;
  }
}

export function parseGan(xmlContent: string): GanImportResult {
  let parsed: unknown;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
      // Force task/depend to always be arrays (single-child case).
      isArray: (name) => name === 'task' || name === 'depend',
      // Keep empty self-closing elements as empty objects so we can detect them
      // for the "skipped" report.
      parseTagValue: true,
    });
    parsed = parser.parse(xmlContent);
  } catch (err) {
    throw new GanImportError('Failed to parse XML', err);
  }

  const skipped = new Set<string>();
  const root = (parsed as { project?: Record<string, unknown> }).project;
  if (!root) {
    throw new GanImportError('Not a .gan file: missing <project> root element');
  }

  const file = createEmptyFile({ name: readAttr(root, 'name') || 'Imported project' });

  // Surface the things we deliberately dropped. We do this BEFORE the tasks
  // early-return so empty-task files still report skipped sections.
  if (root.resources) skipped.add('资源(resources)');
  if (root.allocations) skipped.add('资源分配(allocations)');
  if (root.previous) skipped.add('基线对比(previous)');
  if (root.roles) skipped.add('角色(roles)');
  if (root.view) skipped.add('视图状态(view)');
  if (root.taskproperties) skipped.add('自定义列(taskproperties)');

  // Tasks: walk the nested tree, flatten, and assign parentId.
  const tasksContainer = root.tasks as { task?: GanTaskNode[] | GanTaskNode } | undefined;
  const taskNodes = tasksContainer?.task;
  if (!taskNodes) {
    return { file, skipped: [...skipped], taskCount: 0 };
  }
  const taskList = Array.isArray(taskNodes) ? taskNodes : [taskNodes];
  const collected: Task[] = [];
  let order = 0;
  for (const node of taskList) {
    flattenTask(node, null, collected, () => order++);
  }

  file.tasks = collected;

  return {
    file,
    skipped: [...skipped],
    taskCount: collected.length,
  };
}

interface GanTaskNode {
  '@_id'?: string;
  '@_name'?: string;
  '@_start'?: string;
  '@_duration'?: string;
  '@_complete'?: string;
  '@_meeting'?: string;
  '@_color'?: string;
  '@_notes'?: string;
  task?: GanTaskNode[] | GanTaskNode;
  depend?:
    | Array<{ '@_id'?: string; '@_type'?: string; '@_difference'?: string }>
    | {
        '@_id'?: string;
        '@_type'?: string;
        '@_difference'?: string;
      };
}

function flattenTask(
  node: GanTaskNode,
  parentId: string | null,
  out: Task[],
  nextOrder: () => number,
): void {
  const id = String(node['@_id'] ?? nanoidFallback());
  const name = node['@_name'] ?? 'Unnamed task';
  const startRaw = node['@_start'] ?? '';
  const start = convertGanDate(startRaw);
  const duration = Number(node['@_duration'] ?? '1');
  const progress = Number(node['@_complete'] ?? '0');
  const isMilestone = node['@_meeting'] === 'true';
  const color = normalizeColor(node['@_color']);
  const note = node['@_notes'];

  // Depend: GanttProject uses numeric task ids.
  const depsRaw = node.depend;
  const deps = (Array.isArray(depsRaw) ? depsRaw : depsRaw ? [depsRaw] : []).map((d) => {
    const typeCode = Number(d['@_type'] ?? '0');
    return {
      targetId: String(d['@_id'] ?? ''),
      type: DEPEND_TYPE_MAP[typeCode] ?? 'FS',
      lag: Number(d['@_difference'] ?? '0'),
    };
  });

  // Compute end as start + duration-1 calendar days (rough — exact calendar math
  // requires the project's calendar, which we deliberately drop per PRD).
  const end = addCalendarDaysApprox(start, Math.max(0, duration - 1));

  out.push({
    id,
    name,
    parentId,
    order: nextOrder(),
    start,
    end,
    duration: Math.max(0, duration),
    progress: Math.min(100, Math.max(0, progress)),
    isMilestone,
    color,
    note,
    dependencies: deps,
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
  });

  const children = Array.isArray(node.task) ? node.task : node.task ? [node.task] : [];
  for (const child of children) {
    flattenTask(child, id, out, nextOrder);
  }
}

/** Convert GanttProject's `dd-MM-yyyy` format to ISO `yyyy-MM-dd`. */
function convertGanDate(raw: string): string {
  const m = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) {
    // Fallback: if already ISO, accept; else default.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return '2026-01-05';
  }
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function addCalendarDaysApprox(iso: string, days: number): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d)) + days * 86_400_000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm2 = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd2 = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm2}-${dd2}`;
}

/** Normalise a GanttProject hex colour (e.g. `#ff0033`) to CSS-compatible form. */
function normalizeColor(raw?: string): string | undefined {
  if (!raw) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  return raw; // best-effort
}

function readAttr(obj: Record<string, unknown>, key: string): string {
  const v = obj[`@_${key}`];
  return typeof v === 'string' ? v : '';
}

function nanoidFallback(): string {
  return `gan-${Math.random().toString(36).slice(2, 10)}`;
}
