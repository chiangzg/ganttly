import { GanttView } from './components/GanttView';

/**
 * Root application component. MVP has a single workspace route: the gantt
 * editor. Future versions can add a project picker / settings pages.
 */
export function App() {
  return (
    <div className="flex h-full flex-col">
      <GanttView />
    </div>
  );
}
