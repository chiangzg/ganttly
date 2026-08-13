/**
 * Project statistics projection (spec §6.1 `summary_jsonb`).
 *
 * `computeProjectStats` mirrors the web client's pure projection in
 * `apps/web/src/data/repository.ts::summarizeProject` so a project stored and
 * reloaded through the server yields byte-identical card metadata. The
 * non-stat columns (id/name/timestamps) live on the projects row and are merged
 * in by {@link buildSummary} when assembling a response.
 */
import type { ProjectStats, ProjectSummary } from '@ganttly/api-contract';
import type { GanttlyFile, Task } from '@ganttly/schema';

/**
 * Structural view of a projects row — the columns {@link buildSummary} reads.
 * The drizzle row satisfies this structurally, so summary.ts needs no schema
 * import (which keeps it free of the `typeof projects` / type-only-import
 * friction).
 */
export interface SummarySource {
  id: string;
  name: string;
  summaryJsonb: unknown;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Compute the file-derived subset persisted in `summary_jsonb`:
 * leaf-weighted progress, leaf counts, and the project date range.
 */
export function computeProjectStats(file: GanttlyFile): ProjectStats {
  const parentIds = new Set(
    file.tasks.map((task) => task.parentId).filter((id): id is string => Boolean(id)),
  );
  const leaves = file.tasks.filter((task) => !parentIds.has(task.id));
  const weighted = leaves.reduce(
    (acc, task) => {
      const weight = Math.max(1, task.duration || 1);
      return { weight: acc.weight + weight, progress: acc.progress + task.progress * weight };
    },
    { weight: 0, progress: 0 },
  );
  return {
    taskCount: leaves.length,
    completedTaskCount: leaves.filter((task) => task.progress >= 100).length,
    progress: weighted.weight === 0 ? 0 : Math.round(weighted.progress / weighted.weight),
    ...collectProjectDates(file.tasks),
  };
}

function collectProjectDates(tasks: Task[]): Pick<ProjectStats, 'startDate' | 'endDate'> {
  if (tasks.length === 0) return {};
  const starts = tasks
    .map((task) => task.start)
    .filter(Boolean)
    .sort();
  const ends = tasks
    .map((task) => task.end)
    .filter(Boolean)
    .sort();
  return { startDate: starts[0], endDate: ends[ends.length - 1] };
}

/**
 * Merge a projects row with its `summary_jsonb` projection into the full
 * {@link ProjectSummary} DTO. Timestamps serialize to ISO strings.
 */
export function buildSummary(row: SummarySource): ProjectSummary {
  const stats = row.summaryJsonb as ProjectStats;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    ...stats,
  };
}
