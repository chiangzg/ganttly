/**
 * @ganttly/domain — framework-agnostic project scheduling logic.
 *
 * Pure functions only: no React, no DOM, no Zustand, no Fastify, no database.
 * Depends solely on `@ganttly/schema`, `@ganttly/calendar-data` and
 * `@ganttly/gan-parser`. Web Commands and the server-side
 * `ProjectApplicationService` must call these functions so that排期语义 stays
 * single-source.
 *
 * Re-exports the migrated `apps/web/src/lib` modules plus the pure command
 * model (`applyProjectCommand`).
 */
export * from './calendar';
export * from './schedule';
export * from './cpm';
export * from './summary';
export * from './cost';
export * from './resourceLoad';
export * from './assigneeSummary';
export * from './resourceTasks';
export * from './baseline';
export * from './projectImport';
export * from './taskPosition';
export * from './deleteImpact';
export * from './clipboard';
export * from './selection';
export * from './commands';
