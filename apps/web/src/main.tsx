import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './i18n';
import { useProjectStore } from './store/useProjectStore';
import './styles/index.css';

// i18n is async-initialized but bootstraps synchronously with bundled
// zh-CN strings, so the app renders in Chinese on first paint.
initI18n();

// Expose the store for E2E tests (perf tests inject tasks directly).
// Not a security concern — the app is local-first; no remote code can access.
if (typeof window !== 'undefined') {
  (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore = useProjectStore;
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root element missing in index.html');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
